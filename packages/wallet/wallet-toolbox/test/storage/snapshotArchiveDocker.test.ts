import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

interface FixtureDocker {
  executable: string
  context: string
  image: string
  validateContext: (records: unknown) => void
  validateContainer: (actual: unknown, expected: unknown) => void
}
const source = readFileSync(join(__dirname, 'snapshotArchiveDocker.cjs'), 'utf8')
const desktop = '/Applications/Docker.app/Contents/Resources/bin/docker'
const hosted = { TS_STACK_SNAPSHOT_HOSTED_MYSQL: '1', GITHUB_ACTIONS: 'true' }
function load(platform = 'darwin', env: Record<string, string> = {}, available = desktop): FixtureDocker {
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    process: { platform, env },
    require: (name: string) => {
      if (name === 'node:fs') return { existsSync: (candidate: string) => candidate === available }
      if (name === 'node:assert/strict') return assert
      throw new Error('Unexpected fixture dependency')
    }
  })
  return module.exports as FixtureDocker
}
const endpoint = (name: string, host: string) => [{ Name: name, Endpoints: { docker: { Host: host } } }]

test('local fixture retains its explicit Desktop context and known installation path', () => {
  const docker = load()
  expect(docker.context).toBe('desktop-linux')
  expect(docker.executable).toBe(desktop)
  expect(() => docker.validateContext(endpoint('desktop-linux', 'unix:///Users/synthetic/docker.sock'))).not.toThrow()
  expect(() => docker.validateContext(endpoint('desktop-linux', 'tcp://remote.example:2375'))).toThrow()
  expect(() => docker.validateContext(endpoint('default', 'unix:///var/run/docker.sock'))).toThrow()
  expect(() => load('darwin', {}, '/untrusted/path/docker')).toThrow('supported local installation path')
})

test('explicit hosted Linux mode accepts only the runner default Unix socket', () => {
  const docker = load('linux', hosted, '/usr/bin/docker')
  expect(docker.context).toBe('default')
  expect(docker.executable).toBe('/usr/bin/docker')
  expect(() => docker.validateContext(endpoint('default', 'unix:///var/run/docker.sock'))).not.toThrow()
  for (const records of [
    [],
    {},
    endpoint('default', 'unix:///tmp/another.sock'),
    endpoint('default', 'tcp://remote.example:2375'),
    endpoint('desktop-linux', 'unix:///var/run/docker.sock'),
    [...endpoint('default', 'unix:///var/run/docker.sock'), ...endpoint('default', 'unix:///var/run/docker.sock')]
  ])
    expect(() => docker.validateContext(records)).toThrow()
})

test.each([
  ['darwin', hosted],
  ['linux', { ...hosted, GITHUB_ACTIONS: 'false' }],
  ['linux', { ...hosted, TS_STACK_SNAPSHOT_HOSTED_MYSQL: 'arbitrary' }],
  ['linux', { ...hosted, DOCKER_HOST: 'tcp://remote.example:2375' }],
  ['linux', { ...hosted, DOCKER_CONTEXT: 'another' }]
] as Array<[string, Record<string, string>]>)(
  'invalid hosted fixture mode refuses before Docker I/O (%s, %j)',
  (platform, env) => {
    expect(() => load(platform, env, '/usr/bin/docker')).toThrow()
  }
)

test('cleanup requires the exact invocation claim, pinned image and container identity', () => {
  const docker = load()
  const owner = '00000000-0000-4000-8000-000000000001'
  const expected = { name: 'ts569-durable-' + owner, owner, id: 'a'.repeat(64) }
  const actual = {
    Name: '/' + expected.name,
    Id: expected.id,
    Config: {
      Image: docker.image,
      Labels: { 'network-ops.fixture': 'ts-stack-544-durable', 'network-ops.fixture-owner': expected.owner }
    }
  }
  expect(() => docker.validateContainer(actual, expected)).not.toThrow()
  // A lost create reply may omit the ID, but never the complete ownership claim.
  expect(() => docker.validateContainer(actual, { name: expected.name, owner: expected.owner })).not.toThrow()
  for (const changed of [
    { ...actual, Name: '/another' },
    { ...actual, Id: 'b'.repeat(64) },
    { ...actual, Config: { ...actual.Config, Image: 'mysql:latest' } },
    { ...actual, Config: { ...actual.Config, Labels: { ...actual.Config.Labels, 'network-ops.fixture': 'another' } } },
    {
      ...actual,
      Config: { ...actual.Config, Labels: { ...actual.Config.Labels, 'network-ops.fixture-owner': 'another' } }
    }
  ])
    expect(() => docker.validateContainer(changed, expected)).toThrow()
  expect(() =>
    docker.validateContainer({ ...actual, Id: '' }, { name: expected.name, owner: expected.owner })
  ).toThrow()
})
