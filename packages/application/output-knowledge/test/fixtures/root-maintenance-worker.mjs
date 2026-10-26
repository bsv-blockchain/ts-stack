import { readFileSync } from 'node:fs'
import { SQLiteRootEvictionMaintenance } from '../../dist/root-eviction/SQLiteRootEvictionMaintenance.js'
import { SQLiteRootEvictionDatabase } from '../../dist/root-eviction/SQLiteRootEvictionDatabase.js'

const setup = JSON.parse(readFileSync('worker.json', 'utf8'))
const originalRun = SQLiteRootEvictionDatabase.prototype.run
if (setup.mode === 'before-terminal-insert') {
  SQLiteRootEvictionDatabase.prototype.run = function (sql, ...values) {
    if (sql === 'INSERT INTO root_actions VALUES (?,?,?,?,?,?,?)') {
      // The revision has advanced in this still-open transaction. The parent
      // kills the worker here; neither revision nor terminal action may survive.
      process.send({ kind: 'before-terminal-insert' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)
      throw new Error('Parent did not stop the maintenance worker')
    }
    return originalRun.call(this, sql, ...values)
  }
}
const worker = SQLiteRootEvictionMaintenance.open('root.db', setup.configuration)
try {
  const result = await worker.expirePending(setup.digest, {
    clock: () => '200',
    authorize: () => true
  })
  process.send({ kind: 'committed', result })
  await new Promise(resolve => setTimeout(resolve, 10000))
} finally {
  SQLiteRootEvictionDatabase.prototype.run = originalRun
  await worker.close()
  process.disconnect()
}
