// Native process-loss qualification, using only caller-owned synthetic databases.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { knex } = require('knex')
const { addSnapshotArchiveTables } = require('../../out/src/storage/schema/snapshotArchiveMigration.js')
const { addSnapshotArchiveRequestTable } = require('../../out/src/storage/schema/snapshotArchiveRequestMigration.js')
const { addSnapshotArchiveOwnerTable } = require('../../out/src/storage/schema/snapshotArchiveOwnerMigration.js')
const { addSnapshotArchiveGuardTable } = require('../../out/src/storage/schema/snapshotArchiveGuardMigration.js')
const {
  KnexSnapshotArchiveRequestStore
} = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.js')
const { recoverSnapshotArchiveGuards } = require('../../out/src/storage/snapshot/archive/SnapshotArchiveGuard.js')

async function qualifyGuardProcessLoss(control, config) {
  const requests = new KnexSnapshotArchiveRequestStore(control, true, true)
  const identity = '02' + 'ee'.repeat(32)
  const offered = await requests.offer(identity, { lifetimeMs: 300000, maxBytes: 32768 })
  const { owner } = await requests.claimReader(identity, offered.request)
  await control.schema.createTable('snapshot_guard_fixture', table => {
    table.integer('id').primary()
    table.string('value')
  })
  await control('snapshot_guard_fixture').insert({ id: 1, value: 'before' })
  const child = spawn(process.execPath, [join(__dirname, 'snapshotArchiveGuardChild.cjs')], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', reject)
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned guard child readiness deadline')), 15000)
      child.once('message', message => {
        clearTimeout(timer)
        try {
          assert.deepEqual(message, { ready: true, value: 'before' })
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      void exited.then(
        () => {
          clearTimeout(timer)
          reject(new Error(stderr || 'Owned guard child exited before readiness'))
        },
        error => {
          clearTimeout(timer)
          reject(error)
        }
      )
      // Ephemeral fixture connection details travel through private IPC, never command arguments or output.
      child.send({ config, owner })
    })
    await requests.markReaderCancellation(identity, offered.request)
    await recoverSnapshotArchiveGuards(control, config)
    await requests.reap()
    assert.equal((await control('snapshot_archive_owners')).length, 1)
    assert.equal(Number((await control('snapshot_archive_capacity').first()).archives), 1)
    await control('snapshot_guard_fixture').update({ value: 'survives owner loss' })
    child.kill('SIGTERM')
    const result = await exited
    assert.equal(result.signal, 'SIGTERM')
    await recoverSnapshotArchiveGuards(control, config)
    await requests.reap()
    assert.equal((await control('snapshot_archive_owners')).length, 0)
    assert.equal(Number((await control('snapshot_archive_capacity').first()).archives), 0)
    assert.equal((await control('snapshot_guard_fixture').first()).value, 'survives owner loss')
    await assert.rejects(requests.claimReader(identity, offered.request), /unavailable/)
    return {
      actualSignal: result.signal,
      busyBeforeLoss: true,
      foregroundWrite: true,
      exactOwnerRecovered: true,
      staleRequestRefused: true
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    await control.schema.dropTable('snapshot_guard_fixture')
  }
}

async function qualifySQLiteGuardProcessLoss() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-guard-process-'))
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const control = knex(config)
  try {
    await control.raw('PRAGMA journal_mode = WAL')
    await addSnapshotArchiveTables(control)
    await addSnapshotArchiveRequestTable(control)
    await addSnapshotArchiveOwnerTable(control)
    await addSnapshotArchiveGuardTable(control)
    return await qualifyGuardProcessLoss(control, config)
  } finally {
    await control.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}
module.exports = { qualifyGuardProcessLoss, qualifySQLiteGuardProcessLoss }
