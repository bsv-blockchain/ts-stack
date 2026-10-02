const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const cuts = require('./snapshotJournalRetentionCuts.cjs')
const {
  open,
  StorageKnex,
  StorageProvider,
  seedArchiveClosure,
  tables,
  exact
} = require('./snapshotJournalMysqlConnection.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  installSnapshotJournalMysqlGeneration,
  completeSnapshotJournalMysqlGeneration
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.js')
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
const identity = '02' + '11'.repeat(32)
const request = { ceiling: '9223372036854775807', receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 } }
async function collect(k, epoch, floor, stream) {
  let after,
    complete = false,
    examined = 0,
    removed = 0
  function* pages() {
    for (let n = 0; n < 100 && !complete; n++) yield n
  }
  await runInSeries(pages(), async () => {
    const input = { epoch, floor, stream, limit: 32, after }
    const result = await k.transaction(t => collectSnapshotJournalTombstones(t, input))
    assert(result)
    assert(result.examined <= 32)
    if (after !== undefined) {
      const sql = snapshotJournalCollectionQuery(k, input).toSQL()
      const [plan] = await k.raw('EXPLAIN ' + sql.sql, sql.bindings)
      assert.equal(plan[0].key, 'PRIMARY')
      assert.equal(plan[0].type, 'range')
      assert(!String(plan[0].Extra).includes('filesort'))
    }
    examined += result.examined
    removed += result.removed
    after = result.after
    complete = result.complete
  })
  assert(complete, 'bounded collector did not finish in one hundred pages')
  return { examined, removed }
}
module.exports = async function main(isolation) {
  assert(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation))
  const directory = await mkdtemp(join(tmpdir(), 'ts569-retention-mysql-'))
  const k = open(true),
    peer = open(true)
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  let first, next, failure
  try {
    await storage.migrate('native retention fixture', 'synthetic-retention-native')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, other.userId)
    await installSnapshotJournalMysqlGeneration(k, request.ceiling, request.receiptPolicy)
    let finished = false
    function* bootstrap() {
      for (let n = 0; n < 100 && !finished; n++) yield n
    }
    await runInSeries(bootstrap(), async () => {
      finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
    })
    assert(finished)
    await completeSnapshotJournalMysqlGeneration(k, request.ceiling, request.receiptPolicy)
    const date = new Date('2026-01-01T00:00:00Z')
    const labels = Array.from({ length: 600 }, (_, n) => ({
      txLabelId: n + 100,
      userId: user.userId,
      label: 'native-retention-' + n,
      isDeleted: false,
      created_at: date,
      updated_at: date
    }))
    await k('tx_labels').insert(labels)
    await k.raw('ALTER TABLE snapshot_journal_events AUTO_INCREMENT=9007199254740993')
    await peer.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
    const old = await peer.transaction()
    try {
      assert.equal((await old('snapshot_journal_receipts')).length, 0)
      first = await storage.openSnapshotJournalSource(identity, request)
      assert(BigInt(first.receipt.highWater) > 9007199254740991n)
      const started = performance.now()
      await assert.rejects(advanceSnapshotJournalFloor(old, String(BigInt(first.receipt.highWater) + 1n)))
      assert(performance.now() - started < 2000)
    } finally {
      await old.rollback()
    }
    const floor = await k.transaction(t => advanceSnapshotJournalFloor(t, first.receipt.highWater))
    assert.equal(floor.floor, first.receipt.highWater)
    const held = await peer.transaction()
    try {
      await held('snapshot_journal_clock').where('id', 1).forUpdate().first()
      const started = performance.now()
      await assert.rejects(
        k.transaction(t => advanceSnapshotJournalFloor(t, first.receipt.highWater)),
        error => error.code === 'ER_LOCK_NOWAIT'
      )
      assert(performance.now() - started < 2000)
    } finally {
      await held.rollback()
    }
    const pinned = (await first.readPage('certificateFields')).rows
    await k('certificate_fields').where({ certificateId: 1, fieldName: 'é' }).delete()
    assert.deepEqual((await first.readPage('certificateFields')).rows, pinned)
    for (const stream of ['scope', 'physical']) {
      const before = await collect(k, first.receiptBinding.epoch, first.receipt.highWater, stream)
      assert.equal(before.removed, 0, 'newer tombstones must survive an older floor')
      assert(before.examined >= 600)
    }
    await first.close()
    first = undefined
    const now = await snapshotArchiveDatabaseNow(k)
    await k('snapshot_journal_receipts').update({ expiresAt: now - 1 })
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 1)
    next = await storage.openSnapshotJournalSource(identity, request)
    await k.transaction(t => advanceSnapshotJournalFloor(t, next.receipt.highWater))
    const beforeSource = {}
    await runInSeries(tables, async table => {
      beforeSource[table] = await k(table)
    })
    const results = {}
    await runInSeries(['scope', 'physical'], async stream => {
      results[stream] = await collect(k, next.receiptBinding.epoch, next.receipt.highWater, stream)
      assert(results[stream].removed > 0)
      assert(results[stream].examined >= 600)
    })
    await exact(k)
    await runInSeries(tables, async table => {
      assert.deepEqual(await k(table), beforeSource[table])
    })
    const epoch = next.receiptBinding.epoch
    await next.close()
    next = undefined
    const processLoss = await cuts(k, { backend: 'mysql', isolation, directory, epoch, userId: user.userId })
    console.log(
      JSON.stringify({
        fixture: 'journal-retention-native',
        isolation,
        beyondSafeInteger: true,
        liveReceiptPinned: true,
        currentReadAfterOldSnapshot: true,
        lockRefusal: true,
        retainedViewImmutable: true,
        newerTombstonePreserved: true,
        databaseClockExpiry: true,
        primaryKeyRangePlans: true,
        bound: 32,
        exactLiveMetadata: true,
        allThirteenSourceTablesPreserved: true,
        results,
        processLoss,
        limitations: [
          'internal component fixture',
          'complete mutation and source integration pending',
          'no runtime quotas or registered migration',
          'synthetic MySQL8.4; no production/PXC/failover qualification'
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
  ])
  const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason)
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...errors],
      'Native retention fixture cleanup failed'
    )
  if (failure !== undefined) throw failure.error
}
