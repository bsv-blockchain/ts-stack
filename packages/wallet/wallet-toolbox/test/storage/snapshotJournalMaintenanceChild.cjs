const assert = require('node:assert/strict')
const input = JSON.parse(process.argv[2])
const { maintainSnapshotJournal } = require('../../out/src/storage/snapshot/journal/SnapshotJournalMaintenance.js')
const backend = require('../../out/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.js')
const { inject } = require('./snapshotJournalMaintenanceProcessLoss.cjs')
async function main() {
  assert(['sqlite', 'mysql'].includes(input.backend))
  const k =
    input.backend === 'mysql'
      ? require('./snapshotJournalMysqlConnection.cjs').open(true)
      : require('knex').knex({
          client: 'better-sqlite3',
          connection: { filename: input.filename },
          useNullAsDefault: true,
          pool: { min: 0, max: 1 }
        })
  process.once('disconnect', () => process.exit(1))
  const deadline = setTimeout(() => process.exit(2), 20000)
  deadline.unref()
  const bind = backend.bindSnapshotJournalCaptureBackend
  backend.bindSnapshotJournalCaptureBackend = async (...args) => {
    const value = await bind(...args)
    inject(args[0], input.operation, input.phase)
    return value
  }
  try {
    if (input.backend === 'mysql') {
      assert(['READ COMMITTED', 'REPEATABLE READ'].includes(input.isolation))
      k.client.config.pool = {
        ...k.client.config.pool,
        afterCreate(connection, done) {
          connection.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + input.isolation, error =>
            done(error, connection)
          )
        }
      }
    }
    const operation =
      input.operation === 'floor' ? { kind: 'floor', floor: input.floor } : { kind: 'collect', page: input.request }
    const task = maintainSnapshotJournal(async () => k.client.config, {
      epoch: input.epoch,
      ceiling: input.ceiling,
      receiptPolicy: input.receiptPolicy,
      operation
    })
    await task.result
    await task.closed
    throw new Error('Did not reach owned maintenance process-loss boundary')
  } finally {
    await k.destroy()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
