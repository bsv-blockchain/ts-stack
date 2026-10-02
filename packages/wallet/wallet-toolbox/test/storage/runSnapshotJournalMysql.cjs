// Disposable, loopback-only synthetic MySQL qualification. Never targets an
// operator-supplied database, retains a volume, pulls an image, or builds one.
const { execFile } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { executable, context, image, validateContext, validateContainer } = require('./snapshotArchiveDocker.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const journalFixtureGroups = Object.freeze(['generation', 'server-crash', 'receipts'])
const execute = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 1048576, ...options },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })

async function runFixture(group) {
  assert(journalFixtureGroups.includes(group))
  const secret = randomBytes(32).toString('hex')
  const fixtureEnvironment = { ...process.env, MYSQL_ROOT_PASSWORD: secret, MYSQL_PWD: secret }
  const cancellation = new AbortController()
  const interrupt = () => cancellation.abort(new Error('Snapshot fixture cancelled'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const command = async (args, signal) =>
    (
      await execute(executable, ['--context', context, ...args], {
        timeout: 15000,
        env: fixtureEnvironment,
        ...(signal === undefined ? {} : { signal })
      })
    ).trim()
  const docker = (...args) => command(args, cancellation.signal)
  const cleanup = (...args) => command(args)
  const owner = randomUUID()
  const name = 'ts569-durable-' + owner
  let id
  let creating = false
  let failure
  try {
    validateContext(JSON.parse(await docker('context', 'inspect', context)))
    await docker('image', 'inspect', image)
    creating = true
    id = await docker(
      'run',
      '--pull=never',
      '--detach',
      '--name',
      name,
      '--label',
      'network-ops.fixture=ts-stack-544-durable',
      '--label',
      'network-ops.fixture-owner=' + owner,
      '--memory',
      '1g',
      '--cpus',
      '2',
      '--pids-limit',
      '256',
      '--tmpfs',
      '/var/lib/mysql:rw,nosuid,nodev,size=512m',
      '--env',
      'MYSQL_ROOT_PASSWORD',
      '--env',
      'MYSQL_DATABASE=ts569_snapshot',
      '--publish',
      '127.0.0.1::3306',
      '--entrypoint',
      '/bin/sh',
      image,
      '-c',
      'attempt=0; while [ "$attempt" -lt 32 ]; do attempt=$((attempt + 1)); /usr/local/bin/docker-entrypoint.sh mysqld --pid-file=/var/lib/mysql/fixture.pid & wait "$!"; done; exit 1'
    )
    validateContainer(JSON.parse(await docker('inspect', id))[0], { name, owner, id })
    const deadline = Date.now() + 60000
    let ready = false
    function* pendingReadiness() {
      while (!ready) yield undefined
    }
    await runInSeries(pendingReadiness(), async () => {
      try {
        // TCP specifically excludes the entrypoint's temporary socket-only server.
        await docker(
          'exec',
          '--env',
          'MYSQL_PWD',
          id,
          'mysqladmin',
          '--protocol=tcp',
          '--host=127.0.0.1',
          '--user=root',
          'ping'
        )
        ready = true
      } catch (error) {
        if (cancellation.signal.aborted || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })
    {
      const started = Date.now()
      process.stdout.write(JSON.stringify({ group, status: 'started' }) + '\n')
      const result = await execute(
        process.execPath,
        [
          join(
            __dirname,
            group === 'generation'
              ? 'snapshotJournalMysql.cjs'
              : group === 'server-crash'
                ? 'snapshotJournalMysqlServerCrash.cjs'
                : 'snapshotJournalReceiptMysql.cjs'
          ),
          group
        ],
        {
          env: {
            ...process.env,
            TS_STACK_SNAPSHOT_CONTAINER: name,
            TS_STACK_SNAPSHOT_CONTAINER_ID: id,
            TS_STACK_SNAPSHOT_CONTAINER_OWNER: owner,
            TS_STACK_SNAPSHOT_MYSQL_SECRET: secret
          },
          signal: cancellation.signal,
          timeout: group === 'generation' ? 180000 : group === 'server-crash' ? 240000 : 60000
        }
      )
      process.stdout.write(result)
      process.stdout.write(JSON.stringify({ group, status: 'passed', milliseconds: Date.now() - started }) + '\n')
    }
  } catch (error) {
    failure = error
  }
  let cleanupFailure
  if (creating) {
    // A timed-out create may have succeeded before its reply was lost. Cleanup
    // keeps its own deadline after cancellation and requires the complete claim.
    try {
      const owned = () => cleanup('ps', '-aq', '--filter', 'label=network-ops.fixture-owner=' + owner)
      const pending = await owned()
      if (pending !== '') {
        const containers = JSON.parse(await cleanup('inspect', ...pending.split('\n')))
        assert.equal(containers.length, 1)
        validateContainer(containers[0], { name, owner, id })
        await cleanup('rm', '--force', containers[0].Id)
      }
      assert.equal(await owned(), '')
    } catch (error) {
      cleanupFailure = error
    }
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (cleanupFailure !== undefined)
    throw new AggregateError(
      failure === undefined ? [cleanupFailure] : [failure, cleanupFailure],
      'Snapshot fixture cleanup is unproved'
    )
  if (failure !== undefined) throw failure
  cancellation.signal.throwIfAborted()
}
async function main() {
  await runInSeries(journalFixtureGroups, runFixture)
}
module.exports = main
if (require.main === module)
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
