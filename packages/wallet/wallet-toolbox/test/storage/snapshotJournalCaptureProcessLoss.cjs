const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')

// The parent supplies an exclusive marker descriptor at stdio[4]; children
// cannot choose a filesystem write path through command-line arguments.
// Instrument only pools constructed after the foreground provider in this
// disposable child. SQL hooks never enter production code.
module.exports = function captureProcessLoss(phase) {
  assert(['before-commit', 'after-commit', 'opened'].includes(phase))
  const native = require('knex'),
    original = native.knex
  let pools = 0
  const park = () => {
    writeFileSync(4, phase)
    process.kill(process.pid, 'SIGKILL')
  }
  native.knex = (...args) => {
    pools++
    const owned = original(...args)
    let receiptWritten = false
    owned.on('query', q => {
      if (q.sql.startsWith('insert into `snapshot_journal_receipts`')) receiptWritten = true
      if (receiptWritten && q.sql === 'COMMIT;' && phase === 'before-commit') park()
    })
    // Internal transaction COMMIT bypasses query-response. Await both SQL and
    // executionPromise before terminating, while the provider still awaits its
    // commit call and cannot publish the source.
    const transaction = owned.client.transaction
    owned.client.transaction = function (...parameters) {
      const trx = transaction.apply(this, parameters)
      const commit = trx.commit
      trx.commit = async function (...values) {
        const result = await commit.apply(this, values)
        if (receiptWritten && phase === 'after-commit') {
          await this.transactor.executionPromise
          park()
        }
        return result
      }
      return trx
    }
    return owned
  }
  return {
    park,
    get pools() {
      return pools
    }
  }
}
