const { maintainSnapshotJournal } = require('../../out/src/storage/snapshot/journal/SnapshotJournalMaintenance.js')
async function maintain(k, input, operation) {
  const task = maintainSnapshotJournal(async () => k.client.config, {
    epoch: input.epoch,
    ceiling: input.ceiling,
    receiptPolicy: input.receiptPolicy,
    operation
  })
  const result = await task.result
  await task.closed
  return result.value
}
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const { tables, exact } = require('./snapshotJournalNativeFixture.cjs')
const { killAt } = require('./snapshotJournalMaintenanceProcessLoss.cjs')
const { collectSnapshotJournalReceipts } = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')

const { snapshotArchiveDatabaseNow } = require('../../out/src/storage/snapshot/archive/SnapshotArchiveSql.js')
const { snapshotJournalRevisionText } = require('../../out/src/storage/snapshot/journal/SnapshotJournalRevisionSql.js')
async function source(k) {
  const rows = {}
  await runInSeries(tables, async table => {
    rows[table] = await k(table)
  })
  return rows
}
async function newest(k) {
  let prefix = '0'
  await runInSeries(['scope', 'physical'], async stream => {
    const table = 'snapshot_journal_' + stream
    const row = await k(table)
      .select({ revisionText: snapshotJournalRevisionText(k, 'revision') })
      .orderBy(table + '.revision', 'desc')
      .first()
    if (row !== undefined && BigInt(row.revisionText) > BigInt(prefix)) prefix = row.revisionText
  })
  assert(BigInt(prefix) > 0n)
  return prefix
}
module.exports = async function cuts(k, input) {
  await k('snapshot_journal_receipts').update({ expiresAt: (await snapshotArchiveDatabaseNow(k)) - 1 })
  await k.transaction(t => collectSnapshotJournalReceipts(t))
  assert.equal((await k('snapshot_journal_receipts')).length, 0)
  const results = []
  const clock = async () =>
    (
      await k('snapshot_journal_clock')
        .select({ revision: snapshotJournalRevisionText(k, 'revision') })
        .first()
    ).revision
  await runInSeries(['before-commit', 'after-commit'], async phase => {
    await k('tx_labels')
      .where('txLabelId', 1)
      .update({ label: 'floor process loss ' + phase })
    const floor = await newest(k),
      previous = String((await k('snapshot_journal_retention').first()).floor),
      beforeClock = input.backend === 'sqlite' ? await clock() : undefined
    const beforeSource = await source(k)
    await killAt({ ...input, operation: 'floor', phase, floor, marker: join(input.directory, 'floor-' + phase) })
    assert.equal(
      String((await k('snapshot_journal_retention').first()).floor),
      phase === 'after-commit' ? floor : previous
    )
    if (input.backend === 'sqlite')
      assert.equal(await clock(), phase === 'after-commit' ? String(BigInt(beforeClock) + 1n) : beforeClock)
    assert.deepEqual(await source(k), beforeSource)
    const recovered = await maintain(k, input, { kind: 'floor', floor })
    assert.equal(recovered.floor, floor)
    await exact(k)
    results.push({ operation: 'floor', phase, atomic: true, lostAcknowledgementRecovered: phase === 'after-commit' })
  })
  let firstId = 1000
  await runInSeries(['scope', 'physical'], async stream => {
    await runInSeries(['after-first-delete', 'before-commit', 'after-commit'], async phase => {
      const ids = [firstId++, firstId++, firstId++],
        date = input.backend === 'mysql' ? new Date('2026-01-01T00:00:00Z') : '2026-01-01T00:00:00.000Z'
      await k('tx_labels').insert(
        ids.map(id => ({
          txLabelId: id,
          userId: input.userId,
          label: 'gc process loss ' + id,
          isDeleted: false,
          created_at: date,
          updated_at: date
        }))
      )
      await k('tx_labels').whereIn('txLabelId', ids).delete()
      const floor = await newest(k)
      await maintain(k, input, { kind: 'floor', floor })
      const key = {
        tableId: 3,
        ...(stream === 'scope' ? { userId: input.userId } : {}),
        id1: ids[0] - 1,
        id2: 0,
        exactText: ''
      }
      const request = { epoch: input.epoch, floor, stream, limit: 3, after: { epoch: input.epoch, floor, stream, key } }
      const table = 'snapshot_journal_' + stream,
        order =
          stream === 'scope' ? ['tableId', 'userId', 'id1', 'id2', 'exactText'] : ['tableId', 'id1', 'id2', 'exactText']
      const before = await k(table).orderBy(order),
        beforeSource = await source(k),
        beforeClock = input.backend === 'sqlite' ? await clock() : undefined
      const deleted = row =>
        Number(row.tableId) === 3 &&
        ids.includes(Number(row.id1)) &&
        (stream !== 'scope' || Number(row.userId) === input.userId)
      assert.equal(before.filter(deleted).length, 3)
      assert(before.filter(deleted).every(row => Number(row.present) === 0))
      await killAt({ ...input, operation: stream, phase, request, marker: join(input.directory, stream + '-' + phase) })
      assert.deepEqual(
        await k(table).orderBy(order),
        phase === 'after-commit' ? before.filter(row => !deleted(row)) : before
      )
      if (input.backend === 'sqlite')
        assert.equal(await clock(), phase === 'after-commit' ? String(BigInt(beforeClock) + 1n) : beforeClock)
      assert.deepEqual(await source(k), beforeSource)
      const recovered = await maintain(k, input, { kind: 'collect', page: request })
      assert.equal(recovered.removed, phase === 'after-commit' ? 0 : 3)
      assert(recovered.examined <= 3)
      await exact(k)
      assert.deepEqual(await source(k), beforeSource)
      await k('tx_labels')
        .where('txLabelId', 1)
        .update({ label: 'writer after ' + stream + ' ' + phase })
      await exact(k)
      results.push({
        operation: stream,
        phase,
        atomic: true,
        sourcePreserved: true,
        recovered: true,
        writerProgress: true
      })
    })
  })
  return results
}
