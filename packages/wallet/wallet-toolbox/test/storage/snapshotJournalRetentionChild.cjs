const assert = require('node:assert/strict')
const input = JSON.parse(process.argv[2])
const { advanceSnapshotJournalFloor } = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')
const {
  collectSnapshotJournalTombstones
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalCollection.js')
const { inject } = require('./snapshotJournalRetentionProcessLoss.cjs')
async function main() {
  assert(['sqlite', 'mysql'].includes(input.backend))
  const k =
    input.backend === 'mysql'
      ? require('./snapshotJournalMysqlConnection.cjs').open(true)
      : require('knex').knex({
          client: 'better-sqlite3',
          connection: { filename: input.filename },
          useNullAsDefault: true,
          pool: { min: 1, max: 1 }
        })
  process.once('disconnect', () => process.exit(1))
  const deadline = setTimeout(() => process.exit(2), 20000)
  deadline.unref()
  try {
    if (input.backend === 'sqlite') await k.raw('PRAGMA busy_timeout=0')
    else {
      assert(['READ COMMITTED', 'REPEATABLE READ'].includes(input.isolation))
      await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + input.isolation)
    }
    inject(k, input.operation, input.phase)
    await k.transaction(t =>
      input.operation === 'floor'
        ? advanceSnapshotJournalFloor(t, input.floor)
        : collectSnapshotJournalTombstones(t, input.request)
    )
    throw new Error('Did not reach retention process-loss boundary')
  } catch (error) {
    try {
      await k.destroy()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Retention child cleanup failed')
    }
    throw error
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
