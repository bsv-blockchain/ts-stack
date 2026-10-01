// Synthetic SQLite process-termination qualification. Run after pnpm build.
// Each child owns a fresh temporary database; no wallet or service is contacted.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { knex } = require('knex')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  KnexSnapshotArchiveStore,
  snapshotArchiveTables
} = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveStore.js')
const { addSnapshotArchiveTables } = require('../../out/src/storage/schema/snapshotArchiveMigration.js')
const identity = '02' + '11'.repeat(32),
  date = new Date('2026-01-01T00:00:00.000Z')
const binding = {
  version: 1,
  snapshotId: 'a'.repeat(64),
  sourceSchema: 'synthetic-v1',
  sourceStorage: {
    created_at: date,
    updated_at: date,
    storageIdentityKey: 'source',
    storageName: 'source',
    chain: 'test',
    dbtype: 'SQLite',
    maxOutputScript: 1024
  },
  user: { created_at: date, updated_at: date, userId: 7, identityKey: identity, activeStorage: 'source' }
}
const phases = [
  'after-begin',
  'after-page-insert',
  'after-page-checkpoint',
  'after-append-commit',
  'after-seal-before-ack'
]
const open = directory =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: path.join(directory, 'archive.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
async function child(directory, phase) {
  assert(phases.includes(phase))
  const db = open(directory)
  await db.raw('PRAGMA journal_mode = WAL')
  await addSnapshotArchiveTables(db)
  const store = new KnexSnapshotArchiveStore(db)
  const writer = await store.begin(binding)
  fs.writeFileSync(path.join(directory, 'writer.json'), JSON.stringify(writer), { mode: 0o600 })
  const park = () => {
    fs.writeFileSync(path.join(directory, 'boundary'), phase)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  if (phase === 'after-begin') park()
  db.on('query-response', (_result, query) => {
    if (phase === 'after-page-insert' && query.sql.startsWith('insert into `snapshot_archive_pages`')) park()
    if (
      phase === 'after-page-checkpoint' &&
      query.sql.startsWith('update `snapshot_archives`') &&
      query.sql.includes('`nextSequence`')
    )
      park()
  })
  await runInSeries(snapshotArchiveTables.entries(), async ([sequence, table]) => {
    await store.append(writer, { sequence, table, rows: 0, done: true, bytes: new Uint8Array([91, 93]) })
    if (phase === 'after-append-commit') park()
  })
  await store.seal(writer)
  if (phase === 'after-seal-before-ack') park()
  throw new Error('Expected boundary was not reached')
}
async function parent() {
  await runInSeries(phases, async phase => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ts569-archive-crash-'))
    let processHandle, database, exited
    try {
      processHandle = spawn(process.execPath, [__filename, 'child', phase], {
        cwd: directory,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      let error = ''
      processHandle.stderr.on('data', chunk => {
        error = (error + chunk.toString()).slice(-65536)
      })
      exited = new Promise((resolve, reject) => {
        processHandle.once('exit', (code, signal) => resolve({ code, signal }))
        processHandle.once('error', reject)
      })
      const deadline = Date.now() + 15000
      let reachedBoundary = fs.existsSync(path.join(directory, 'boundary'))
      function* pendingBoundary() {
        while (!reachedBoundary) yield undefined
      }
      await runInSeries(pendingBoundary(), async () => {
        if (processHandle.exitCode !== null || processHandle.signalCode !== null)
          throw new Error(error || 'Child stopped before boundary')
        assert(Date.now() < deadline, 'Boundary deadline: ' + phase)
        await new Promise(resolve => setTimeout(resolve, 20))
        reachedBoundary = fs.existsSync(path.join(directory, 'boundary'))
      })
      assert.equal(fs.readFileSync(path.join(directory, 'boundary'), 'utf8'), phase)
      processHandle.kill('SIGKILL')
      const outcome = await exited
      assert.equal(outcome.signal, 'SIGKILL')
      database = open(directory)
      const store = new KnexSnapshotArchiveStore(database)
      const writer = JSON.parse(fs.readFileSync(path.join(directory, 'writer.json'), 'utf8'))
      const before = await database('snapshot_archives').where({ archiveId: writer.archiveId }).first()
      const ready = phase === 'after-seal-before-ack'
      if (ready) {
        assert.equal((await store.inspect(identity, writer.archiveId)).pages, 13)
        assert.equal((await store.read(identity, writer.archiveId, 12)).table, 'syncStates')
      } else await assert.rejects(store.inspect(identity, writer.archiveId), /unavailable/)
      let committed = 0
      if (phase === 'after-append-commit') committed = 1
      else if (ready) committed = 13
      assert.equal(before.nextSequence, committed)
      assert.equal(Number((await database('snapshot_archive_pages').count({ count: '*' }))[0].count), committed)
      if (phase === 'after-append-commit') {
        await store.append(writer, {
          sequence: 0,
          table: 'provenTxs',
          rows: 0,
          done: true,
          bytes: new Uint8Array([91, 93])
        })
        assert.equal((await database('snapshot_archives').first()).nextSequence, 1)
      }
      await database('snapshot_archives').where({ archiveId: writer.archiveId }).update({ expiresAt: 0 })
      await store.reap()
      assert.equal(Number((await database('snapshot_archive_capacity').first()).reservedBytes), 0)
      assert.equal(Number((await database('snapshot_archive_pages').count({ count: '*' }))[0].count), 0)
      console.log(
        JSON.stringify({
          phase,
          actualSignal: outcome.signal,
          committedPages: committed,
          ready,
          exactReplay: phase === 'after-append-commit',
          expiredCleanupComplete: true
        })
      )
    } finally {
      if (processHandle?.exitCode === null && processHandle.signalCode === null) {
        processHandle.kill('SIGKILL')
        await exited
      }
      if (database) await database.destroy()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
async function main() {
  if (process.argv[2] === 'child') {
    assert.equal(typeof process.send, 'function', 'Child execution requires its fixture parent')
    await child(process.cwd(), process.argv[3])
  } else {
    await parent()
    const { qualifySQLiteGuardProcessLoss } = require('./snapshotArchiveGuardCrash.cjs')
    console.log(JSON.stringify({ ownerProcessLoss: await qualifySQLiteGuardProcessLoss() }))
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
