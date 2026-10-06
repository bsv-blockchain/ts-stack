const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  knex,
  StorageKnex,
  StorageProvider,
  seedArchiveClosure,
  tables,
  exact
} = require('./snapshotJournalNativeFixture.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.js')
const {
  copySnapshotJournalBootstrapPage
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const {
  advanceSnapshotJournalFloor,
  collectSnapshotJournalReceipts
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')
const {
  collectSnapshotJournalTombstones,
  snapshotJournalCollectionQuery
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalCollection.js')
const { snapshotArchiveDatabaseNow } = require('../../out/src/storage/snapshot/archive/SnapshotArchiveSql.js')
const cuts = require('./snapshotJournalRetentionCuts.cjs')
const identity = '02' + '11'.repeat(32)
const request = { ceiling: '9223372036854775807', receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 } }
const open = filename =>
  knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
async function collect(k, epoch, floor, stream) {
  let after,
    complete = false,
    examined = 0,
    removed = 0
  function* pages() {
    for (let n = 0; n < 100 && !complete; n++) yield n
  }
  await runInSeries(pages(), async () => {
    const input = { epoch, floor, stream, limit: 32, after },
      result = await k.transaction(t => collectSnapshotJournalTombstones(t, input))
    assert(result)
    assert(result.examined <= 32)
    if (after !== undefined) {
      const sql = snapshotJournalCollectionQuery(k, input).toSQL(),
        plan = await k.raw('EXPLAIN QUERY PLAN ' + sql.sql, sql.bindings)
      assert(plan.some(row => row.detail.includes('SEARCH j USING INDEX sqlite_autoindex_snapshot_journal_')))
      assert(plan.every(row => !row.detail.includes('TEMP B-TREE')))
    }
    examined += result.examined
    removed += result.removed
    after = result.after
    complete = result.complete
  })
  assert(complete)
  return { examined, removed }
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-retention-sqlite-')),
    filename = join(directory, 'wallet.sqlite'),
    k = open(filename),
    peer = open(filename)
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  let first, next, failure
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await k.raw('PRAGMA busy_timeout=0')
    await peer.raw('PRAGMA busy_timeout=0')
    await storage.migrate('native retention WAL fixture', 'synthetic-retention-native')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, other.userId)
    await installSnapshotJournalSqliteGeneration(k, request.ceiling, request.receiptPolicy)
    let finished = false
    function* bootstrap() {
      for (let n = 0; n < 100 && !finished; n++) yield n
    }
    await runInSeries(bootstrap(), async () => {
      finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
    })
    assert(finished)
    await completeSnapshotJournalSqliteGeneration(k, request.receiptPolicy)
    const date = '2026-01-01T00:00:00.000Z'
    await runInSeries(
      Array.from({ length: 6 }, (_, n) => n),
      async n => {
        await k('tx_labels').insert(
          Array.from({ length: 100 }, (_, i) => ({
            txLabelId: 100 + n * 100 + i,
            userId: user.userId,
            label: 'native-retention-' + (n * 100 + i),
            isDeleted: false,
            created_at: date,
            updated_at: date
          }))
        )
      }
    )
    await k('snapshot_journal_clock').where('id', 1).update({ revision: '9007199254740993' })
    first = await storage.openSnapshotJournalSource(identity, request)
    assert(BigInt(first.receipt.highWater) > 9007199254740991n)
    await assert.rejects(
      k.transaction(t => advanceSnapshotJournalFloor(t, String(BigInt(first.receipt.highWater) + 1n)))
    )
    const floor = await k.transaction(t => advanceSnapshotJournalFloor(t, first.receipt.highWater))
    assert.equal(floor.floor, first.receipt.highWater)
    const held = await peer.transaction()
    try {
      await held('snapshot_journal_clock')
        .where('id', 1)
        .update({ revision: held.ref('revision') })
      const started = performance.now()
      await assert.rejects(
        k.transaction(t => advanceSnapshotJournalFloor(t, first.receipt.highWater)),
        error => error.code === 'SQLITE_BUSY'
      )
      assert(performance.now() - started < 2000)
    } finally {
      await held.rollback()
    }
    const pinned = await first.readPage('certificateFields')
    await k('certificate_fields').where({ certificateId: 1, fieldName: 'é' }).delete()
    assert.deepEqual(await first.readPage('certificateFields'), pinned)
    const before = await collect(k, first.receiptBinding.epoch, floor.floor, 'scope')
    assert(before.examined >= 600)
    assert.equal(before.removed, 0)
    const beforePhysical = await collect(k, first.receiptBinding.epoch, floor.floor, 'physical')
    assert(beforePhysical.examined >= 600)
    assert.equal(beforePhysical.removed, 0)
    await first.close()
    first = undefined
    await k('snapshot_journal_receipts').update({ expiresAt: (await snapshotArchiveDatabaseNow(k)) - 1 })
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 1)
    next = await storage.openSnapshotJournalSource(identity, request)
    const advanced = await k.transaction(t => advanceSnapshotJournalFloor(t, next.receipt.highWater)),
      beforeSource = {}
    await runInSeries(tables, async table => {
      beforeSource[table] = await k(table)
    })
    const results = {
      scope: await collect(k, next.receiptBinding.epoch, advanced.floor, 'scope'),
      physical: await collect(k, next.receiptBinding.epoch, advanced.floor, 'physical')
    }
    assert(results.scope.removed > 0)
    assert(results.physical.removed > 0)
    await exact(k)
    await runInSeries(tables, async table => {
      assert.deepEqual(await k(table), beforeSource[table])
    })
    const epoch = next.receiptBinding.epoch
    await next.close()
    next = undefined
    const processLoss = await cuts(k, { backend: 'sqlite', filename, directory, epoch, userId: user.userId })
    assert.deepEqual(await k.raw('PRAGMA foreign_key_check'), [])
    console.log(
      JSON.stringify({
        fixture: 'journal-retention-WAL',
        beyondSafeInteger: true,
        liveReceiptPinned: true,
        lockRefusal: true,
        retainedViewImmutable: true,
        databaseClockExpiry: true,
        primaryKeyRangePlans: true,
        bound: 32,
        allThirteenSourceTablesPreserved: true,
        results,
        processLoss,
        limitations: [
          'internal component fixture',
          'complete mutation and source integration pending',
          'no runtime quotas or registered migration',
          'no production or filesystem power-loss qualification'
        ]
      })
    )
  } catch (error) {
    failure = { error }
  }
  const closed = await Promise.allSettled([
      first?.close(),
      next?.close(),
      storage.destroy(),
      k.destroy(),
      peer.destroy()
    ]),
    errors = closed.filter(result => result.status === 'rejected').map(result => result.reason)
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...errors],
      'WAL retention fixture cleanup failed'
    )
  if (failure !== undefined) throw failure.error
}
module.exports = main
if (require.main?.filename === __filename)
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
