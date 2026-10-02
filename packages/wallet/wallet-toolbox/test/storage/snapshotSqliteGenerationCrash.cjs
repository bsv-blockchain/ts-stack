// Actual built-source, registered-migrator SQLite process-loss qualification.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const { migration, readGenerationIndexState } = require('../../out/src/storage/schema/snapshotSqliteIndexState.js')
const { names, metadata, progress } = require('../../out/src/storage/schema/snapshotSqliteIndexGeneration.js')
const { retiredTables } = require('../../out/src/storage/schema/snapshotSqliteLegacyOwnership.js')
const { migrateBeforeSqliteGeneration } = require('./snapshotHistoricalMigrations.cjs')
const { oracle } = require('./snapshotGlobalIndexFixtures.cjs')
const phases = [
  'install-lock',
  'install-first-table',
  'install-partial-observers',
  'install-before-commit',
  'install-committed',
  'copy-before-cursor',
  'copy-after-cursor',
  'copy-before-commit',
  'copy-committed',
  'complete-before-commit',
  'copy-completed',
  'retirement-before-commit',
  'retirement-page-committed',
  'retirement-before-drop',
  'retirement-completed',
  'publication-before-insert',
  'publication-committed'
]
const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
function provider(filename) {
  return new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  })
}
async function seed(filename) {
  const source = provider(filename)
  try {
    await source.knex.raw('PRAGMA journal_mode=WAL')
    await migrateBeforeSqliteGeneration(source, 'generation loss', 'synthetic-generation-loss')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await source.knex('proven_txs').insert({
      ...dates,
      provenTxId: 7,
      txid: '7'.repeat(64),
      height: 1,
      index: 0,
      merklePath: Buffer.from([1]),
      rawTx: Buffer.from([1]),
      blockHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64)
    })
    await runInSeries([0, 100, 200, 300, 400, 500], async start => {
      await source.knex('transactions').insert(
        Array.from({ length: 100 }, (_, i) => ({
          ...dates,
          transactionId: (start + i + 1) * 2,
          userId: user.userId,
          txid: 'a'.repeat(64),
          provenTxId: 7,
          status: 'completed',
          reference: 'generation-' + (start + i),
          isOutgoing: true,
          satoshis: 0,
          description: ''
        }))
      )
    })
    return {
      userId: user.userId,
      otherId: other.userId,
      rows: await source.knex('transactions').orderBy('transactionId')
    }
  } finally {
    await source.destroy()
  }
}
async function child(filename, phase, marker) {
  assert(phases.includes(phase))
  assert.equal(typeof process.send, 'function', 'Native fixture child requires its parent')
  const source = provider(filename)
  const k = source.knex
  let stage = 'unstarted'
  const park = observed => {
    if (observed !== phase) return
    writeFileSync(marker, JSON.stringify({ phase, stage }), { mode: 0o600 })
    process.kill(process.pid, 'SIGKILL')
  }
  let committing
  const committed = () => {
    const current = committing
    committing = undefined
    if (current === undefined) return
    stage = 'idle'
    if (current === 'install') park('install-committed')
    if (current === 'copy') park('copy-committed')
    if (current === 'complete') park('copy-completed')
    if (current === 'retire') park('retirement-page-committed')
    if (current === 'retire-complete') park('retirement-completed')
  }
  const firstCursor = q => q.sql.startsWith('update `snapshot_index_rebuild_v2`') && q.bindings.includes(512)
  k.on('query', q => {
    const sql = q.sql.toLowerCase()
    // Knex does not emit query-response for every SQLite COMMIT. The next
    // serialized query also proves that the prior transaction completed.
    if (sql !== 'commit;') committed()
    if (sql.startsWith('create table if not exists snapshot_index_install_lock_v2')) stage = 'install'
    if (stage === 'install' && sql === 'commit;') park('install-before-commit')
    if (firstCursor(q)) park('copy-before-cursor')
    if (stage === 'copy' && sql === 'commit;') park('copy-before-commit')
    if (stage === 'complete' && sql === 'commit;') park('complete-before-commit')
    if (stage === 'retire' && sql === 'commit;') park('retirement-before-commit')
    if (sql === 'commit;') committing = stage
    if (sql.startsWith('drop table')) park('retirement-before-drop')
    if (sql.startsWith('insert into `knex_migrations`') && q.bindings.includes(migration))
      park('publication-before-insert')
  })
  k.on('query-response', (_value, q) => {
    const sql = q.sql.toLowerCase()
    if (sql.startsWith('create table if not exists snapshot_index_install_lock_v2')) park('install-lock')
    if (sql.startsWith('create table "snapshot_profile_keys_v2"')) park('install-first-table')
    if (sql.startsWith('create trigger "snapshot_identity_before_transactions_insert"'))
      park('install-partial-observers')
    if (firstCursor(q)) {
      stage = 'copy'
      park('copy-after-cursor')
    }
    if (sql.startsWith('update `snapshot_index_generation_v2` set `complete` = ?') && q.bindings[0] === true)
      stage = 'complete'
    if (sql.startsWith('delete from `snapshot_global_edges`')) stage = 'retire'
    if (
      sql.startsWith('update `snapshot_index_generation_v2` set `retiretable` = ?') &&
      q.bindings[0] === retiredTables.length
    )
      stage = 'retire-complete'
    if (sql === 'commit;') committed()
    if (sql.startsWith('insert into `knex_migrations`') && q.bindings.includes(migration)) park('publication-committed')
  })
  try {
    await source.migrate('generation loss', 'synthetic-generation-loss')
    throw new Error('Requested generation boundary was not reached: ' + phase)
  } finally {
    await source.destroy()
  }
}
async function terminateAt(filename, phase, directory) {
  const marker = path.join(directory, 'boundary.json')
  const handle = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  handle.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  const exited = new Promise((resolve, reject) => {
    handle.once('exit', (code, signal) => resolve({ code, signal }))
    handle.once('error', reject)
  })
  const timer = setTimeout(() => handle.kill('SIGKILL'), 15000)
  try {
    handle.send({ filename, phase, marker })
    const result = await exited
    assert.equal(result.signal, 'SIGKILL', stderr)
    assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).phase, phase)
    return result
  } finally {
    clearTimeout(timer)
    if (handle.exitCode === null && handle.signalCode === null) {
      handle.kill('SIGKILL')
      await exited
    }
  }
}
async function qualifySQLiteGenerationProcessLoss() {
  const results = []
  await runInSeries(phases, async phase => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-sqlite-generation-'))
    const filename = path.join(directory, 'wallet.sqlite')
    let source
    try {
      const seeded = await seed(filename)
      const result = await terminateAt(filename, phase, directory)
      source = provider(filename)
      const k = source.knex
      assert.deepEqual(await k('transactions').orderBy('transactionId'), seeded.rows)
      const early = [
        'install-lock',
        'install-first-table',
        'install-partial-observers',
        'install-before-commit'
      ].includes(phase)
      assert.equal(await k.schema.hasTable(metadata), !early)
      if (early) await oracle(k)
      else {
        assert.equal(await readGenerationIndexState(k), phase === 'publication-committed' ? 'v2' : false)
        const after = (await k(progress).where('stream', 0).first()).afterId
        if (['install-committed', 'copy-before-cursor', 'copy-after-cursor', 'copy-before-commit'].includes(phase))
          assert.equal(after, 0)
        else if (phase === 'copy-committed') assert.equal(after, 512)
        else assert.equal(after, 1200)
      }
      if (phase === 'retirement-before-commit') assert.equal((await k('snapshot_global_edges')).length, 600)
      if (phase === 'retirement-page-committed') assert.equal((await k('snapshot_global_edges')).length, 344)
      const published = await k('knex_migrations').where('name', migration)
      assert.equal(published.length, phase === 'publication-committed' ? 1 : 0)
      // Independent mutations below the committed source cursor must be represented after recovery.
      await k('transactions').where('transactionId', 2).update({ userId: seeded.otherId })
      await k('transactions').where('transactionId', 4).delete()
      await k('transactions').insert({ ...seeded.rows[0], transactionId: 3, reference: 'new-low-key' })
      // This exact owned child has exited; no other migrator can own the fixture lock.
      await k.migrate.forceFreeMigrationsLock()
      assert.equal(await source.migrate('generation loss', 'synthetic-generation-loss'), migration)
      assert.equal(await readGenerationIndexState(k), 'v2')
      const mapping = new Map([
        ['snapshot_global_edges', names.edges],
        ['snapshot_global_keys', names.keys],
        ['snapshot_global_guards', names.guards]
      ])
      const rebuilt = new Proxy(k, {
        apply(target, self, args) {
          if (mapping.has(args[0])) args[0] = mapping.get(args[0])
          return Reflect.apply(target, self, args)
        }
      })
      await oracle(rebuilt)
      const actual = await k(names.profile).where('snapshotTableId', 0).orderBy('snapshotRowId')
      const expected = await k('transactions')
        .select({ snapshotRowId: 'transactionId', snapshotUserId: 'userId' })
        .orderBy('transactionId')
      assert.deepEqual(
        actual.map(({ snapshotRowId, snapshotUserId }) => ({ snapshotRowId, snapshotUserId })),
        expected
      )
      for (const table of retiredTables) assert.equal(await k.schema.hasTable(table), false)
      assert.equal((await k('knex_migrations').where('name', migration)).length, 1)
      assert.equal((await k.raw('PRAGMA foreign_keys'))[0].foreign_keys, 1)
      results.push({
        phase,
        signal: result.signal,
        sourceRowsRetained: true,
        completeJournalAfterRecovery: true,
        independentLowKeyWrites: true
      })
    } finally {
      if (source) await source.destroy()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
  return results
}
if (process.argv[2] === 'child') {
  assert.equal(typeof process.send, 'function', 'Native fixture child requires its parent')
  process.once('message', ({ filename, phase, marker }) => {
    child(filename, phase, marker).catch(error => {
      console.error(error)
      process.exitCode = 1
      process.disconnect()
    })
  })
}
module.exports = { qualifySQLiteGenerationProcessLoss }
