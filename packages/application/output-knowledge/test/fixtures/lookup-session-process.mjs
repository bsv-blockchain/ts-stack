import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { OUTPUT_LOOKUP_PROFILE } from '@bsv/sdk'
import { SQLiteLookupIndex } from '../../dist/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../../dist/lookup/SQLiteLookupSessions.js'
import { LookupSessionCodec } from '../../dist/lookup/LookupSessionCodec.js'

const input = JSON.parse(process.argv[2])
const body = input.opening.contract.manifest.body
const codec = new LookupSessionCodec({
  baseURL: body.baseURL,
  identity: body.identity,
  chain: body.chain,
  kind: 'lookup',
  service: input.opening.open.service,
  profile: OUTPUT_LOOKUP_PROFILE,
  rules: new Map(body.services.map(service => [service.rules.id, () => {}])),
  maximumAgeSeconds: '200',
  clockSkewSeconds: '2'
})
const index = SQLiteLookupIndex.open(input.path, 'records', input.binding)
const sessions = SQLiteLookupSessions.open(index, codec, () =>
  input.clockFile ? readFileSync(input.clockFile, 'utf8') : input.now
)
function crash() {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('Process termination unexpectedly returned')
}
const prepare = DatabaseSync.prototype.prepare
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.prepare = function (sql) {
  if (input.stage === 'before-payload' && sql.startsWith('INSERT INTO output_lookup_sessions'))
    crash()
  if (input.stage === 'during-compaction' && sql.startsWith('DELETE FROM output_lookup_sessions'))
    crash()
  return prepare.call(this, sql)
}
DatabaseSync.prototype.exec = function (sql) {
  if (input.clockFile && sql === 'BEGIN IMMEDIATE') process.send({ status: 'locking' })
  const result = exec.call(this, sql)
  if (input.stage === 'after-commit' && sql === 'COMMIT') crash()
  return result
}
const authorization = {
  principal: input.opening.principal,
  access: input.opening.access,
  guards: input.opening.guards
}
process.send({ status: 'ready' })
await new Promise(resolve => process.once('message', resolve))
try {
  if (input.stage === 'during-compaction') {
    await sessions.compact(1)
    process.send({ status: 'compacted' })
  } else if (input.stage === 'close') {
    await sessions.closeSession(input.opening.session, authorization)
    process.send({ status: 'closed' })
  } else if (input.stage === 'serialize') {
    await sessions.serialize(input.opening.session, authorization, input.opening.first)
    process.send({ status: 'serialized' })
  } else {
    const result = await sessions.commit(input.opening)
    process.send({ status: 'committed', session: result.session })
  }
} catch (error) {
  process.send({ status: 'failed', code: error.code, message: error.message })
} finally {
  await index.close()
  process.disconnect()
}
