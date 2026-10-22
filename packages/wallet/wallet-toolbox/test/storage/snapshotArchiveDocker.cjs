const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')

// Hosted qualification is explicit and may use only the runner's local daemon.
const mode = process.env.TS_STACK_SNAPSHOT_HOSTED_MYSQL
if (mode !== undefined) {
  assert.equal(mode, '1', 'Unsupported snapshot fixture Docker mode')
  assert.equal(process.platform, 'linux', 'Hosted fixture requires Linux')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Hosted fixture requires GitHub Actions')
  assert.equal(process.env.DOCKER_HOST, undefined, 'An external Docker host is not supported')
  assert.equal(process.env.DOCKER_CONTEXT, undefined, 'An external Docker context is not supported')
}
const context = mode === '1' ? 'default' : 'desktop-linux'
const image = 'mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d'

// Fixture executables use known installation paths rather than searching PATH.
const executable = [
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker'
].find(candidate => existsSync(candidate))

if (executable === undefined) throw new Error('Install Docker at a supported local installation path')

function validateContext(records) {
  assert.equal(Array.isArray(records) && records.length, 1, 'Expected one local Docker context')
  assert.equal(records[0].Name, context)
  const host = records[0].Endpoints?.docker?.Host
  if (mode === '1') assert.equal(host, 'unix:///var/run/docker.sock', 'Hosted fixture requires the local Unix socket')
  else
    assert.equal(
      typeof host === 'string' && host.startsWith('unix:///'),
      true,
      'Desktop fixture requires a local Unix socket'
    )
}

function validateContainer(actual, expected) {
  assert.match(expected.owner, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.equal(expected.name, 'ts569-durable-' + expected.owner)
  assert.equal(actual.Name, '/' + expected.name)
  assert.equal(actual.Config.Labels['network-ops.fixture'], 'ts-stack-544-durable')
  assert.equal(actual.Config.Labels['network-ops.fixture-owner'], expected.owner)
  assert.equal(actual.Config.Image, image)
  if (expected.id !== undefined) assert.equal(actual.Id, expected.id)
  assert.match(actual.Id, /^[a-f0-9]{64}$/)
}

module.exports = { executable, context, image, validateContext, validateContainer }

// The launcher never pulls. Provision this exact image only in an explicit
// hosted-runner step, before the disposable fixture acquires any resources.
if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ['provision-hosted-image'])
  assert.equal(mode, '1', 'Image provisioning requires explicit hosted mode')
  const { execFileSync } = require('node:child_process')
  validateContext(
    JSON.parse(
      execFileSync(executable, ['--context', context, 'context', 'inspect', context], {
        encoding: 'utf8',
        timeout: 15000
      })
    )
  )
  execFileSync(executable, ['--context', context, 'pull', image], { timeout: 240000, stdio: 'inherit' })
}
