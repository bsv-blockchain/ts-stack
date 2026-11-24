import { readFileSync } from 'node:fs'
import { SQLiteRootEvictionLocalRules } from '../../dist/root-eviction/SQLiteRootEvictionLocalRules.js'
import { SQLiteRootEvictionDatabase } from '../../dist/root-eviction/SQLiteRootEvictionDatabase.js'

const setup = JSON.parse(readFileSync('worker.json', 'utf8'))
const original = SQLiteRootEvictionDatabase.prototype.run
if (setup.mode === 'before-invalidation') {
  SQLiteRootEvictionDatabase.prototype.run = function (sql, ...values) {
    if (sql === 'UPDATE root_rule_meta SET epoch=? WHERE id=1') {
      process.send({ kind: 'before-invalidation' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)
      throw new Error('Parent did not stop the local rule worker')
    }
    return original.call(this, sql, ...values)
  }
}
const rules = SQLiteRootEvictionLocalRules.open('root.db', setup.configuration)
try {
  const retained = await rules.install(setup.input, {
    expectedPolicyDigest: setup.policy,
    clock: () => '150',
    authorize: () => true,
    contextCurrent: () => true
  })
  process.send({ kind: 'committed', decisionId: retained.value.decisionId })
  await new Promise(resolve => setTimeout(resolve, 10000))
} finally {
  SQLiteRootEvictionDatabase.prototype.run = original
  await rules.close()
  process.disconnect()
}
