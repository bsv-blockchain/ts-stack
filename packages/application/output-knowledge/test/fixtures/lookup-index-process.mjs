import { DatabaseSync } from 'node:sqlite'
import { SQLiteLookupIndex } from '../../dist/lookup/SQLiteLookupIndex.js'

const input = JSON.parse(process.argv[2])
const store = SQLiteLookupIndex.open(input.path, 'index', input.binding)
function crash() {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('Process termination unexpectedly returned')
}
const prepare = DatabaseSync.prototype.prepare
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.prepare = function (sql) {
  if (input.stage === 'before-group' && sql.startsWith('INSERT INTO output_lookup_groups')) crash()
  if (input.stage === 'during-compaction' && sql.startsWith('SELECT older.row_key')) crash()
  return prepare.call(this, sql)
}
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql)
  if (input.stage === 'after-commit' && sql === 'COMMIT') crash()
  return result
}
process.send({ status: 'ready' })
await new Promise(resolve => process.once('message', resolve))
try {
  if (input.stage === 'during-compaction')
    await store.compact('500', { groups: 1024, versions: 1024, pins: 1024 })
  else {
    const result = await store.commit(input.mutation)
    process.send({ status: 'committed', sequence: result.sequence })
  }
} catch (error) {
  process.send({ status: 'failed', code: error.code, message: error.message })
} finally {
  await store.close()
  process.disconnect()
}
