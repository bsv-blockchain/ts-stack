const { execFileSync } = require('node:child_process')
const { knex } = require('knex')
const { executable, context, validateContext, validateContainer } = require('./snapshotArchiveDocker.cjs')
const container = process.env.TS_STACK_SNAPSHOT_CONTAINER
const expectedId = process.env.TS_STACK_SNAPSHOT_CONTAINER_ID
const owner = process.env.TS_STACK_SNAPSHOT_CONTAINER_OWNER
const secret = process.env.TS_STACK_SNAPSHOT_MYSQL_SECRET
if (!container || !expectedId || !owner || !secret) throw new Error('Use the bounded fixture launcher')
const docker = (...args) =>
  execFileSync(executable, ['--context', context, ...args], { encoding: 'utf8', timeout: 15000 })
validateContext(JSON.parse(docker('context', 'inspect', context)))
const actual = JSON.parse(docker('inspect', container))[0]
validateContainer(actual, { name: container, owner, id: expectedId })
const port = Number(docker('port', expectedId, '3306/tcp').trim().split(':').at(-1))
const connection = {
  host: '127.0.0.1',
  port,
  user: 'root',
  password: secret,
  database: 'ts569_snapshot',
  timezone: 'Z'
}

const open = () => knex({ client: 'mysql2', connection, pool: { min: 1, max: 1 }, acquireConnectionTimeout: 5000 })
module.exports = { open, ...require('./snapshotJournalNativeFixture.cjs') }
