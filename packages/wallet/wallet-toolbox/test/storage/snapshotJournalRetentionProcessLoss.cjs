const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { open } = require('node:fs/promises')
const { join } = require('node:path')

// These hooks belong only to the disposable fixture's own native pool.
function inject(k, operation, phase) {
  assert(['floor', 'scope', 'physical'].includes(operation))
  assert(['after-first-delete', 'before-commit', 'after-commit'].includes(phase))
  assert(operation !== 'floor' || phase !== 'after-first-delete')
  const prefix =
    operation === 'floor' ? 'update `snapshot_journal_retention`' : 'delete from `snapshot_journal_' + operation + '`'
  let changed = false
  const park = () => {
    writeFileSync(4, phase)
    process.kill(process.pid, 'SIGKILL')
  }
  k.on('query', q => {
    if (q.sql.startsWith(prefix)) changed = true
    if (changed && q.sql === 'COMMIT;' && phase === 'before-commit') park()
  })
  k.on('query-response', (_response, q) => {
    if (q.sql.startsWith(prefix) && phase === 'after-first-delete') park()
  })
  const transaction = k.client.transaction
  k.client.transaction = function (...parameters) {
    const trx = transaction.apply(this, parameters)
    const commit = trx.commit
    trx.commit = async function (...values) {
      const result = await commit.apply(this, values)
      if (changed && phase === 'after-commit') {
        await this.transactor.executionPromise
        park()
      }
      return result
    }
    return trx
  }
}
async function killAt(input) {
  const { marker, ...childInput } = input
  const output = await open(marker, 'wx+', 0o600)
  const child = fork(join(__dirname, 'snapshotJournalRetentionChild.cjs'), [JSON.stringify(childInput)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc', output.fd]
  })
  let stderr = ''
  child.stderr.on('data', data => {
    stderr += data
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(result.signal, 'SIGKILL', stderr)
    const bytes = Buffer.alloc(64)
    const { bytesRead } = await output.read(bytes, 0, bytes.length, 0)
    assert.equal(bytes.subarray(0, bytesRead).toString('utf8'), input.phase)
  } finally {
    clearTimeout(timer)
    await output.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
module.exports = { inject, killAt }
