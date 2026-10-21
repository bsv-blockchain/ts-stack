import { readFileSync } from 'node:fs'
import { SQLiteRootEvictionStore } from '../../dist/root-eviction/SQLiteRootEvictionStore.js'
import { SQLiteRootEvictionDatabase } from '../../dist/root-eviction/SQLiteRootEvictionDatabase.js'
import { RootEvictionContracts } from '../../dist/root-eviction/RootEvictionContracts.js'

const setup = JSON.parse(readFileSync('worker.json', 'utf8'))
const originalRun = SQLiteRootEvictionDatabase.prototype.run
if (setup.mode === 'before-contract-insert') {
  SQLiteRootEvictionDatabase.prototype.run = function (sql, ...values) {
    if (sql === 'INSERT INTO root_contracts VALUES (?,?,?,?)') {
      // The request row is already written inside the open transaction. The
      // parent kills this process here to exercise SQLite rollback on restart.
      process.send({ kind: 'before-contract-insert' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)
      throw new Error('Parent did not stop the coordination worker')
    }
    return originalRun.call(this, sql, ...values)
  }
}
const store = SQLiteRootEvictionStore.open('root.db', setup.configuration)
const contracts = new RootEvictionContracts({
  ...setup.trust,
  rules: new Map([
    [
      setup.rulesId,
      parameters => {
        if (JSON.stringify(parameters) !== JSON.stringify({ mode: 'manual' }))
          throw new Error('Unexpected fixture rules')
      }
    ]
  ])
})
try {
  const retained = await store.retainCoordinated(
    setup.packet,
    setup.requester,
    setup.selection,
    contracts,
    {
      expectedPolicyDigest: setup.policy,
      clock: () => '150',
      authorize: () => true,
      contextCurrent: () => true
    }
  )
  process.send({ kind: 'committed', digest: retained.value.digest })
  await new Promise(resolve => setTimeout(resolve, 10000))
} finally {
  SQLiteRootEvictionDatabase.prototype.run = originalRun
  await store.close()
  process.disconnect()
}
