// Disposable, loopback-only synthetic MySQL qualification. Never targets an
// operator-supplied database, retains a volume, pulls an image, or builds one.
const { execFileSync } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const executable = require('./snapshotArchiveDocker.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const secret = randomBytes(32).toString('hex')
const fixtureEnvironment = { ...process.env, MYSQL_ROOT_PASSWORD: secret, MYSQL_PWD: secret }
const image = 'mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d'
const docker = (...args) =>
  execFileSync(executable, ['--context', 'desktop-linux', ...args], {
    encoding: 'utf8',
    env: fixtureEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
async function main() {
  assert.equal(docker('context', 'show'), 'desktop-linux', 'This fixture requires the local Docker Desktop context')
  docker('image', 'inspect', image)
  const name = 'ts569-durable-' + randomUUID().slice(0, 8)
  const id = docker(
    'run',
    '--pull=never',
    '--detach',
    '--name',
    name,
    '--label',
    'network-ops.fixture=ts-stack-544-durable',
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
    image
  )
  try {
    const deadline = Date.now() + 60000
    let ready = false
    function* pendingReadiness() {
      while (!ready) yield undefined
    }
    await runInSeries(pendingReadiness(), async () => {
      try {
        // TCP specifically excludes the entrypoint's temporary socket-only server.
        docker(
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
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })
    const result = execFileSync(process.execPath, [join(__dirname, 'snapshotArchiveMysql.cjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TS_STACK_SNAPSHOT_CONTAINER: name,
        TS_STACK_SNAPSHOT_CONTAINER_ID: id,
        TS_STACK_SNAPSHOT_MYSQL_SECRET: secret
      },
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    process.stdout.write(result)
  } finally {
    docker('rm', '--force', id)
    assert.equal(docker('ps', '-aq', '--filter', 'id=' + id), '')
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
