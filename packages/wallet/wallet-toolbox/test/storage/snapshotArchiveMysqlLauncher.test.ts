import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const source = readFileSync(join(__dirname, 'runSnapshotArchiveMysql.cjs'), 'utf8')
const dockerSource = readFileSync(join(__dirname, 'snapshotArchiveDocker.cjs'), 'utf8')
const owner = '00000000-0000-4000-8000-000000000001'
const id = 'a'.repeat(64)
type Failure = 'none' | 'image' | 'create-reply' | 'child' | 'cleanup-identity' | 'cancel'
interface Call {
  executable: string
  args: string[]
  options: Record<string, unknown>
}
function fixture(failure: Failure) {
  const helper = { exports: {} }
  runInNewContext(dockerSource, {
    module: helper,
    process: { platform: 'darwin', env: {} },
    require: (name: string) => (name === 'node:assert/strict' ? assert : { existsSync: () => true })
  })
  const docker = helper.exports as { image: string }
  const metadata = {
    Id: id,
    Name: '/ts569-durable-' + owner,
    Config: {
      Image: docker.image,
      Labels: { 'network-ops.fixture': 'ts-stack-544-durable', 'network-ops.fixture-owner': owner }
    }
  }
  const calls: Call[] = []
  const signals = new Map<string, () => void>()
  const error = new Error('synthetic ' + failure)
  let exists = false
  let childFinished = false
  const perform = (executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args, options })
    if (executable === '/synthetic/node') {
      childFinished = true
      if (failure === 'child') throw error
      return 'synthetic native proof\n'
    }
    assert.deepEqual(Array.from(args.slice(0, 2)), ['--context', 'desktop-linux'])
    switch (args[2]) {
      case 'context':
        return JSON.stringify([
          { Name: 'desktop-linux', Endpoints: { docker: { Host: 'unix:///synthetic/docker.sock' } } }
        ])
      case 'image':
        if (failure === 'image') throw error
        return '[]'
      case 'run':
        exists = true
        if (failure === 'create-reply') throw error
        return id
      case 'inspect':
        return JSON.stringify([
          { ...metadata, Id: childFinished && failure === 'cleanup-identity' ? 'b'.repeat(64) : id }
        ])
      case 'exec':
        return 'mysqld is alive'
      case 'ps':
        return exists ? id : ''
      case 'rm':
        assert.equal(args[4], id)
        exists = false
        return id
      default:
        throw new Error('Unexpected Docker command')
    }
  }
  const execFile = (
    executable: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: unknown, stdout: string) => void
  ) => {
    if (executable === '/synthetic/node' && failure === 'cancel') {
      calls.push({ executable, args, options })
      const signal = options.signal as AbortSignal
      signal.addEventListener('abort', () => callback(error, ''), { once: true })
      queueMicrotask(() => signals.get('SIGTERM')?.())
      return
    }
    Promise.resolve()
      .then(() => perform(executable, args, options))
      .then(
        value => callback(null, value),
        error => callback(error, '')
      )
  }
  const module = { exports: undefined as unknown }
  const dependencies: Record<string, unknown> = {
    'node:assert/strict': assert,
    'node:child_process': { execFile },
    'node:crypto': { randomBytes: () => Buffer.alloc(32), randomUUID: () => owner },
    'node:path': { join },
    './snapshotArchiveDocker.cjs': helper.exports,
    '../../out/src/utility/runInSeries.js': {
      runInSeries: async (items: Iterable<unknown>, visit: (value: unknown) => Promise<void>) => {
        for (const item of items) await visit(item)
      }
    }
  }
  runInNewContext(source, {
    module,
    __dirname,
    setTimeout,
    AbortController,
    process: {
      env: {},
      execPath: '/synthetic/node',
      stdout: { write: () => undefined },
      once: (name: string, listener: () => void) => signals.set(name, listener),
      removeListener: (name: string) => signals.delete(name)
    },
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name))
      return dependencies[name]
    }
  })
  return { run: module.exports as () => Promise<void>, calls, error, exists: () => exists, signals }
}

test('successful fixture retains bounds and proves exact-owner removal after its child finishes', async () => {
  const f = fixture('none')
  await expect(f.run()).resolves.toBeUndefined()
  expect(f.exists()).toBe(false)
  const creation = f.calls.find(call => call.args[2] === 'run')!
  for (const value of [
    '--pull=never',
    '127.0.0.1::3306',
    '1g',
    '2',
    '256',
    '/var/lib/mysql:rw,nosuid,nodev,size=512m',
    'network-ops.fixture-owner=' + owner
  ]) {
    expect(creation.args).toContain(value)
  }
  const child = f.calls.find(call => call.executable === '/synthetic/node')!
  expect(child.options.timeout).toBe(60000)
  expect(child.options.env).toMatchObject({
    TS_STACK_SNAPSHOT_CONTAINER_OWNER: owner,
    TS_STACK_SNAPSHOT_CONTAINER_ID: id
  })
  expect(
    f.calls.filter(call => call.executable !== '/synthetic/node').every(call => call.options.timeout === 15000)
  ).toBe(true)
  expect(f.calls.filter(call => call.args[2] === 'rm')).toHaveLength(1)
})

test.each(['create-reply', 'child'] as const)(
  'a %s failure removes only the claimed container and preserves the failure',
  async failure => {
    const f = fixture(failure)
    await expect(f.run()).rejects.toBe(f.error)
    expect(f.exists()).toBe(false)
    expect(f.calls.filter(call => call.args[2] === 'rm')).toHaveLength(1)
  }
)

test('image inspection failure allocates no container and does not attempt removal', async () => {
  const f = fixture('image')
  await expect(f.run()).rejects.toBe(f.error)
  expect(f.exists()).toBe(false)
  expect(f.calls.some(call => ['run', 'rm'].includes(call.args[2]))).toBe(false)
})

test('an unexpected cleanup identity refuses removal and reports unproved cleanup', async () => {
  const f = fixture('cleanup-identity')
  await expect(f.run()).rejects.toThrow('cleanup is unproved')
  expect(f.exists()).toBe(true)
  expect(f.calls.some(call => call.args[2] === 'rm')).toBe(false)
})

test('SIGTERM cancels owned work, awaits independently bounded cleanup and removes listeners', async () => {
  const f = fixture('cancel')
  await expect(f.run()).rejects.toBe(f.error)
  expect(f.exists()).toBe(false)
  expect(f.signals.size).toBe(0)
  const child = f.calls.find(call => call.executable === '/synthetic/node')!
  expect((child.options.signal as AbortSignal).aborted).toBe(true)
  const removal = f.calls.find(call => call.args[2] === 'rm')!
  expect(removal.options.signal).toBeUndefined()
  expect(removal.options.timeout).toBe(15000)
})
