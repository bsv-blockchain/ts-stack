const { migrateBeforeSqliteGeneration } = require('./snapshotHistoricalMigrations.cjs')
// Synthetic process-loss qualification, invoked by the existing native fixtures.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { knex, oracle } = require('./snapshotGlobalIndexFixtures.cjs')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  removeSnapshotGlobalIndexes,
  readSnapshotGlobalIndexState,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION
} = require('../../out/src/storage/schema/snapshotGlobalIndexMigration.js')

const phases = [
  'after-guard-table',
  'after-key-table',
  'after-first-index',
  'partial-observers',
  'partial-producers',
  'before-cursor',
  'after-cursor',
  'after-commit'
]
const migrationName = 'synthetic global crash'
const migrationIdentity = 'synthetic-global-crash'

const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
const provider = options =>
  new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(options) })

async function migrate(source) {
  await migrateBeforeSqliteGeneration(source, migrationName, migrationIdentity)
}
async function seed(options) {
  const source = provider(options)
  try {
    if (options.client === 'better-sqlite3') await source.knex.raw('PRAGMA journal_mode = WAL')
    await migrateBeforeSqliteGeneration(source, migrationName, migrationIdentity)
    await source.makeAvailable()
    await removeSnapshotGlobalIndexes(source.knex)
    await source.knex('knex_migrations').where('name', SNAPSHOT_GLOBAL_INDEX_MIGRATION).delete()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await runInSeries([7, 9], async provenTxId => {
      await source.knex('proven_txs').insert({
        ...dates,
        provenTxId,
        txid: String(provenTxId).repeat(64),
        height: 1,
        index: 0,
        merklePath: Buffer.from([1]),
        rawTx: Buffer.from([1]),
        blockHash: 'a'.repeat(64),
        merkleRoot: 'b'.repeat(64)
      })
    })
    await source.knex('proven_tx_reqs').insert({
      ...dates,
      provenTxReqId: 5,
      txid: 'a'.repeat(64),
      provenTxId: 7,
      status: 'unknown',
      rawTx: Buffer.from([1]),
      history: '{}',
      notify: '{}'
    })
    await runInSeries([0, 200, 400], async start => {
      await source.knex('transactions').insert(
        Array.from({ length: 200 }, (_, i) => ({
          ...dates,
          transactionId: (start + i + 1) * 2,
          userId: user.userId,
          txid: 'a'.repeat(64),
          provenTxId: (start + i) % 2 ? 7 : null,
          status: 'completed',
          reference: 'global-crash-' + (start + i),
          isOutgoing: true,
          satoshis: 0,
          description: ''
        }))
      )
    })
    return { userId: user.userId, otherId: other.userId }
  } finally {
    await source.destroy()
  }
}

async function child(options, phase, marker) {
  assert(phases.includes(phase))
  assert.equal(typeof process.send, 'function', 'Child requires its fixture parent')
  const source = provider(options)
  let cursorWritten = false
  const cursor = query =>
    query.sql.startsWith('update `snapshot_global_index_progress`') && query.bindings.includes(512)
  const park = event => {
    writeFileSync(marker, JSON.stringify({ phase, event }), { mode: 0o600 })
    process.kill(process.pid, 'SIGKILL')
  }
  source.knex.on('query', query => {
    if (phase === 'before-cursor' && cursor(query)) park('query')
    if (phase === 'after-commit' && cursorWritten && query.sql.toLowerCase().startsWith('begin'))
      park('next-transaction')
  })
  source.knex.on('query-response', (_result, query) => {
    const sql = query.sql.toLowerCase()
    if (phase === 'after-guard-table' && sql.startsWith('create table `snapshot_global_guards`')) park('query-response')
    if (phase === 'after-key-table' && sql.startsWith('create table `snapshot_global_keys`')) park('query-response')
    if (
      phase === 'after-first-index' &&
      (sql.startsWith('create index `snapshot_global_page`') ||
        sql.startsWith('alter table `snapshot_global_keys` add index `snapshot_global_page`'))
    )
      park('query-response')
    if (phase === 'partial-observers' && sql.startsWith('create trigger snapshot_global_edge_delete '))
      park('query-response')
    if (phase === 'partial-producers' && sql.startsWith('create trigger snapshot_global_tx_insert '))
      park('query-response')
    if (cursor(query)) {
      cursorWritten = true
      if (phase === 'after-cursor') park('query-response')
    }
    if (phase === 'after-commit' && cursorWritten && sql.startsWith('commit')) park('query-response')
  })
  try {
    await migrate(source)
    throw new Error('Expected migration boundary was not reached')
  } finally {
    await source.destroy()
  }
}

async function terminateAt(options, phase) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-global-boundary-'))
  const marker = path.join(directory, 'boundary.json')
  const processHandle = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  processHandle.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  const exited = new Promise((resolve, reject) => {
    processHandle.once('exit', (code, signal) => resolve({ code, signal }))
    processHandle.once('error', reject)
  })
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 15000)
  try {
    processHandle.send({ options, phase, marker })
    const result = await exited
    assert.equal(result.signal, 'SIGKILL', stderr)
    const observed = JSON.parse(await fs.readFile(marker, 'utf8'))
    assert.equal(observed.phase, phase)
    return { phase, event: observed.event, signal: result.signal }
  } finally {
    clearTimeout(timer)
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill('SIGKILL')
      await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function qualify(options, phase) {
  const { userId, otherId } = await seed(options)
  const outcome = await terminateAt(options, phase)
  const source = provider(options)
  const database = source.knex
  try {
    assert.equal(await readSnapshotGlobalIndexState(database), false)
    if (['before-cursor', 'after-cursor', 'after-commit'].includes(phase)) {
      const committed = phase === 'after-commit'
      const progress = await database('snapshot_global_index_progress').where('id', 0).first()
      assert.equal(progress.afterRowId, committed ? 512 : 0)
      assert.equal(
        Number((await database('snapshot_global_edges').count({ count: '*' }).first()).count),
        committed ? 640 : 0
      )
    }
    await database('transactions').where('transactionId', 2).update({ userId: otherId })
    await database('transactions').where('transactionId', 4).delete()
    await database('transactions').insert({
      ...dates,
      transactionId: 3,
      userId,
      txid: 'a'.repeat(64),
      provenTxId: null,
      status: 'completed',
      reference: 'behind-cursor',
      isOutgoing: true,
      satoshis: 0,
      description: ''
    })
    await database('proven_tx_reqs').where('provenTxReqId', 5).update({ provenTxId: 9 })
    // A killed migrator leaves Knex's lock claimed. This is fixture-owned recovery;
    // the verified child is gone and no other migrator can own this isolated store.
    await database.migrate.forceFreeMigrationsLock()
    await migrate(source)
    assert.equal(await readSnapshotGlobalIndexState(database), true)
    await oracle(database)
    assert.equal(
      Number(
        (await database('knex_migrations').where('name', SNAPSHOT_GLOBAL_INDEX_MIGRATION).count({ count: '*' }).first())
          .count
      ),
      1
    )
    return { ...outcome, journalPublishedAfterRecovery: true, independentProfileChangeAndLowIdInsert: true }
  } finally {
    await source.destroy()
  }
}

async function qualifySQLiteGlobalIndexProcessLoss() {
  const results = []
  await runInSeries(phases, async phase => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-global-index-crash-'))
    try {
      results.push(
        await qualify(
          {
            client: 'better-sqlite3',
            connection: { filename: path.join(directory, 'wallet.sqlite') },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 }
          },
          phase
        )
      )
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
  return results
}

async function qualifyMysqlGlobalIndexProcessLoss(control, connection) {
  // The calling fixture has already verified its disposable, pinned container.
  const results = []
  await runInSeries(phases, async phase => {
    const database = 'ts569_global_' + randomUUID().replaceAll('-', '')
    await control.raw('CREATE DATABASE ??', [database])
    try {
      results.push(
        await qualify({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } }, phase)
      )
    } finally {
      await control.raw('DROP DATABASE ??', [database])
    }
  })
  return results
}

if (process.argv[2] === 'child') {
  assert.equal(typeof process.send, 'function', 'Child execution requires its fixture parent')
  process.once('message', ({ options, phase, marker }) => {
    child(options, phase, marker).catch(error => {
      console.error(error)
      process.exitCode = 1
      process.disconnect()
    })
  })
}
module.exports = { qualifySQLiteGlobalIndexProcessLoss, qualifyMysqlGlobalIndexProcessLoss }
