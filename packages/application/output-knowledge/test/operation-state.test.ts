import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { type OutputJSONObject } from '@bsv/sdk'
import {
  MemoryOperationStateStore,
  IndexedDBOperationStateStore,
  type OperationStateStore,
  type OperationStateLimits
} from '../src/operations/index.js'
import { SQLiteOperationStateStore } from '../src/operations/SQLiteOperationStateStore.js'
import { OperationStateCodec } from '../src/operations/OperationStateCodec.js'

const binding = { profile: 'test-workflow/1', journal: 'receipts', generation: '4' }
const initial = { job: '0', phase: 'idle' }
const stores: OperationStateStore[] = []
const directories: string[] = []
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'operation-state-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}
function keep<T extends OperationStateStore>(store: T): T {
  stores.push(store)
  return store
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe.each(['memory', 'sqlite', 'indexeddb'] as const)('%s operation state contract', kind => {
  async function open(limits: Partial<OperationStateLimits> = {}): Promise<OperationStateStore> {
    if (kind === 'memory')
      return keep(new MemoryOperationStateStore('client-a', binding, initial, limits))
    if (kind === 'sqlite')
      return keep(SQLiteOperationStateStore.create(path(), 'client-a', binding, initial, limits))
    return keep(
      await IndexedDBOperationStateStore.create('workflows', 'client-a', binding, initial, {
        factory: new IDBFactory(),
        limits
      })
    )
  }

  it('owns state before asynchronous storage and returns independent snapshots', async () => {
    const store = await open()
    expect(store.durability).toBe(kind === 'memory' ? 'volatile' : 'durable')
    const value = { job: '1', pending: { cursor: 'original' } }
    const write = store.compareAndSwap('0', value)
    value.pending.cursor = 'mutated'
    expect(await write).toEqual({ status: 'updated', revision: '1' })
    const snapshot = await store.read()
    expect(snapshot.value).toEqual({ job: '1', pending: { cursor: 'original' } })
    snapshot.value.job = 'changed'
    expect((await store.read()).value.job).toBe('1')
  })

  it('exposes owned immutable configuration for safe composition of workflow ports', async () => {
    const store = await open({ stateBytes: 1000 })
    expect(store.configuration).toEqual({
      binding,
      limits: { stateBytes: 1000, configurationBytes: 2097152 }
    })
    const configuration = store.configuration
    configuration.binding.generation = 'changed'
    configuration.limits.stateBytes = 4194304
    expect(store.configuration.binding).toEqual(binding)
    expect(store.configuration.limits.stateBytes).toBe(1000)
    await expect(store.compareAndSwap('0', { value: 'x'.repeat(1000) })).rejects.toThrow()
    expect((await store.read()).revision).toBe('0')
  })

  it('recognizes an exact lost-ack retry without allowing stale writes or ABA', async () => {
    const store = await open(),
      next = { job: '1' }
    expect(await store.read()).toEqual({ revision: '0', value: initial })
    await store.compareAndSwap('0', next)
    expect(await store.compareAndSwap('0', next)).toEqual({ status: 'replayed', revision: '1' })
    expect(await store.compareAndSwap('0', { job: 'different' })).toEqual({
      status: 'conflict',
      revision: '1'
    })
    await store.compareAndSwap('1', initial)
    expect(await store.compareAndSwap('0', next)).toEqual({ status: 'conflict', revision: '2' })
    expect(await store.read()).toEqual({ revision: '2', value: initial })
    await store.compareAndSwap('2', next)
    expect(await store.compareAndSwap('0', next)).toEqual({ status: 'conflict', revision: '3' })
  })

  it('serializes competing writes and never merges their values', async () => {
    const store = await open()
    const results = await Promise.all([
      store.compareAndSwap('0', { job: 'left' }),
      store.compareAndSwap('0', { job: 'right' })
    ])
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'updated'])
    const winner = results[0].status === 'updated' ? 'left' : 'right'
    expect(await store.read()).toEqual({ revision: '1', value: { job: winner } })
  })

  it('counts UTF-8 bytes, preserves state on limits, and accepts the exact byte boundary', async () => {
    const store = await open({ stateBytes: 64 })
    // {"x":""} occupies eight UTF-8 bytes; each é occupies two.
    await expect(store.compareAndSwap('0', { x: 'é'.repeat(29) })).rejects.toThrow()
    expect(await store.read()).toEqual({ revision: '0', value: initial })
    expect(await store.compareAndSwap('0', { x: 'é'.repeat(28) })).toEqual({
      status: 'updated',
      revision: '1'
    })
  })

  it.each(['-1', '01', '18446744073709551616'])(
    'rejects malformed revision %s before writing',
    async expected => {
      const store = await open()
      await expect(store.compareAndSwap(expected, { job: 'bad' })).rejects.toThrow()
      expect((await store.read()).revision).toBe('0')
    }
  )

  it('rejects non-object, accessor and cyclic values without executing getters', async () => {
    const store = await open()
    let invoked = false
    const accessor = {
      get secret() {
        invoked = true
        return 'secret'
      }
    }
    const cycle: OutputJSONObject = {}
    cycle.self = cycle
    for (const value of [null, [], accessor, cycle])
      await expect(store.compareAndSwap('0', value as OutputJSONObject)).rejects.toThrow()
    expect(invoked).toBe(false)
    expect((await store.read()).revision).toBe('0')
  })

  it('rejects primitive control state with an actionable local schema error', async () => {
    const store = await open()
    for (const value of [false, true, 0, 1, 'state', null, []])
      await expect(
        store.compareAndSwap('0', value as unknown as OutputJSONObject)
      ).rejects.toMatchObject({
        code: 'invalid',
        message: 'Operation state must be a JSON object'
      })
  })

  it('cannot be used after close', async () => {
    const store = await open()
    await store.close()
    await expect(store.read()).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Operation state store is closed'
    })
    await expect(store.compareAndSwap('0', initial)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe.each(['sqlite', 'indexeddb'] as const)('%s durable operation recovery', kind => {
  function fixture() {
    const file = path(),
      factory = new IDBFactory()
    const create = async (
      namespace = 'client-a',
      config = binding,
      value = initial,
      limits: Partial<OperationStateLimits> = {}
    ) =>
      keep(
        kind === 'sqlite'
          ? SQLiteOperationStateStore.create(file, namespace, config, value, limits)
          : await IndexedDBOperationStateStore.create('workflows', namespace, config, value, {
              factory,
              limits
            })
      )
    const recover = async (
      namespace = 'client-a',
      config = binding,
      limits: Partial<OperationStateLimits> = {}
    ) =>
      keep(
        kind === 'sqlite'
          ? SQLiteOperationStateStore.open(file, namespace, config, limits)
          : await IndexedDBOperationStateStore.open('workflows', namespace, config, {
              factory,
              limits
            })
      )
    return { file, factory, create, recover }
  }

  it('retains exact state after close and idempotent initialization never rewinds it', async () => {
    const f = fixture(),
      store = await f.create()
    await store.compareAndSwap('0', { job: '1', phase: 'response-pending' })
    await store.close()
    const reopened = await f.recover()
    expect(await reopened.read()).toEqual({
      revision: '1',
      value: { job: '1', phase: 'response-pending' }
    })
    const retried = await f.create()
    expect(await retried.read()).toEqual(await reopened.read())
    await expect(
      f.create('client-a', binding, { ...initial, phase: 'other' })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects changed binding or capacity and does not affect an independent namespace', async () => {
    const f = fixture(),
      first = await f.create(),
      second = await f.create('client-b')
    await expect(f.recover('client-a', { ...binding, generation: '5' })).rejects.toMatchObject({
      code: 'context-changed'
    })
    await expect(f.recover('client-a', binding, { stateBytes: 1000 })).rejects.toMatchObject({
      code: 'context-changed'
    })
    await first.compareAndSwap('0', { job: '1' })
    expect(await second.read()).toEqual({ revision: '0', value: initial })
  })

  it('compares atomically across separately opened connections', async () => {
    const f = fixture(),
      left = await f.create(),
      right = await f.recover()
    const results = await Promise.all([
      left.compareAndSwap('0', { worker: 'left' }),
      right.compareAndSwap('0', { worker: 'right' })
    ])
    expect(results.map(row => row.status).sort()).toEqual(['conflict', 'updated'])
    expect(await left.read()).toEqual(await right.read())
  })

  it('does not initialize a lost database or missing namespace during recovery', async () => {
    const f = fixture()
    await expect(f.recover()).rejects.toThrow()
    if (kind === 'sqlite') expect(existsSync(f.file)).toBe(false)
    else expect(await f.factory.databases()).toEqual([])
    const first = await f.create()
    await expect(f.recover('missing')).rejects.toMatchObject({ code: 'reset-required' })
    expect(await first.read()).toEqual({ revision: '0', value: initial })
  })
})

describe('operation storage integrity and process recovery', () => {
  it('preserves the independently calculated version-one storage frame and UTF-8 digests', () => {
    // SHA-256 values were calculated independently with Python hashlib. This
    // fixed local-format fixture detects accidental encoding/domain migrations.
    const codec = new OperationStateCodec('fixture', { workflow: 'example/1' })
    const row = {
      configuration:
        '{"binding":{"workflow":"example/1"},"format":"output-operation-state/1","limits":{"configurationBytes":2097152,"stateBytes":4194304},"namespace":"fixture"}',
      initialDigest: 'db23eaf93854a4132f5c2b90e2e0ca6d8d73f20dc6f6ad8de923fdbf6d6ebeb9',
      revision: '0',
      text: '{"label":"café"}',
      digest: 'db23eaf93854a4132f5c2b90e2e0ca6d8d73f20dc6f6ad8de923fdbf6d6ebeb9',
      checksum: '38a83102db461f6bd89d226fe55b58c28cb290437a5192ff1a3c4e849c20444c'
    }
    expect(codec.initial({ label: 'café' })).toEqual(row)
    expect(codec.snapshot(row)).toEqual({ revision: '0', value: { label: 'café' } })
  })

  it('releases IndexedDB connections on version change and rejects unsupported or invalid opens', async () => {
    const factory = new IDBFactory()
    const store = keep(
      await IndexedDBOperationStateStore.create('upgrade', 'client', binding, initial, { factory })
    )
    const upgraded = await idbResult(factory.open('upgrade', 2))
    upgraded.close()
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      IndexedDBOperationStateStore.open('upgrade', 'client', binding, { factory })
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      IndexedDBOperationStateStore.open('unsupported', 'client', binding)
    ).rejects.toMatchObject({ code: 'unsupported' })
    for (const openTimeoutMs of [0, 60001, 0.5])
      await expect(
        IndexedDBOperationStateStore.create('invalid', 'client', binding, initial, {
          factory,
          openTimeoutMs
        })
      ).rejects.toThrow('timeout')
  })

  it('does not create late IndexedDB state after a blocked open has timed out', async () => {
    const factory = new IDBFactory()
    const held = await idbResult(factory.open('blocked', 1))
    const deletion = factory.deleteDatabase('blocked')
    const deleted = idbResult(deletion)
    await new Promise<void>(resolve => {
      deletion.onblocked = () => resolve()
    })
    await expect(
      IndexedDBOperationStateStore.create('blocked', 'client', binding, initial, {
        factory,
        openTimeoutMs: 20
      })
    ).rejects.toThrow('deadline')
    held.close()
    await deleted
    // An additional open queues behind the timed-out request. Its upgrade shows
    // that the late request did not create a database or persist initialization.
    const request = factory.open('blocked', 1)
    let oldVersion: number | undefined
    request.onupgradeneeded = event => {
      oldVersion = event.oldVersion
    }
    const database = await idbResult(request)
    expect(oldVersion).toBe(0)
    expect(database.objectStoreNames).toHaveLength(0)
    database.close()
  })

  it('preserves prior IndexedDB state when a storage request aborts the transaction', async () => {
    const factory = new IDBFactory()
    const store = keep(
      await IndexedDBOperationStateStore.create('abort', 'client', binding, initial, { factory })
    )
    // Inject a native constraint failure through the storage port; it must abort
    // the whole transaction, with no premature successful CAS acknowledgement.
    const failWrite = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
      this: IDBObjectStore,
      value
    ) {
      return this.add(value)
    })
    await expect(store.compareAndSwap('0', { job: 'new' })).rejects.toMatchObject({
      code: 'unavailable'
    })
    failWrite.mockRestore()
    expect(await store.read()).toEqual({ revision: '0', value: initial })
  })

  it('rejects changed persisted IndexedDB metadata without acknowledging a write', async () => {
    const factory = new IDBFactory()
    const store = keep(
      await IndexedDBOperationStateStore.create('corrupt', 'client', binding, initial, { factory })
    )
    const database = await idbResult(factory.open('corrupt', 1))
    const transaction = database.transaction('operation-state', 'readwrite')
    const complete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
    const request = transaction.objectStore('operation-state').get('client')
    request.onsuccess = () =>
      transaction.objectStore('operation-state').put({ ...request.result, revision: '1' })
    await complete
    database.close()
    await expect(store.read()).rejects.toMatchObject({ code: 'reset-required' })
    await expect(store.compareAndSwap('1', { job: 'new' })).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('checks bounded framing, immutable initialization, checksums and exact U64 saturation', () => {
    const codec = new OperationStateCodec('client', binding)
    const row = codec.initial(initial)
    for (const update of [
      { text: '{"job":"altered"}' },
      { digest: '0'.repeat(64) },
      { initialDigest: '0'.repeat(64) },
      { initialDigest: 'bad' },
      { revision: '00' },
      { revision: '1' },
      { checksum: '0'.repeat(64) },
      { text: ' ' + row.text },
      { configuration: 'different' }
    ])
      expect(() => codec.snapshot({ ...row, ...update })).toThrow()
    expect(() => codec.plan(row, '18446744073709551615', codec.encode({}))).toThrow()
    for (const limits of [
      { stateBytes: 0 },
      { configurationBytes: -1 },
      { stateBytes: 4194305 },
      { stateBytes: 1.5 },
      { unexpected: 5 } as Partial<OperationStateLimits>
    ])
      expect(() => new OperationStateCodec('client', binding, limits)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Invalid operation state limit' })
      )
    expect(() => new OperationStateCodec('client', {}, { configurationBytes: 10 })).toThrow()
    expect(new OperationStateCodec('client', binding, { stateBytes: 1 }).limits.stateBytes).toBe(1)
    expect(() => codec.snapshot({ ...row, initialDigest: 'invalid' })).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: 'Invalid operation initialization digest'
      })
    )
    expect(() => codec.snapshot({ ...row, text: ' ' + row.text })).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: 'Operation state integrity failed'
      })
    )
  })

  it('creates SQLite files owner-only and rejects corrupt or oversized persisted state', async () => {
    const file = path(),
      store = keep(
        SQLiteOperationStateStore.create(file, 'client', binding, initial, { stateBytes: 64 })
      )
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const database = new DatabaseSync(file)
    try {
      database.prepare('UPDATE output_operation_state SET state = ?').run('x'.repeat(65))
      await expect(store.read()).rejects.toMatchObject({ code: 'reset-required' })
    } finally {
      database.close()
    }
    for (const filePath of [':memory:', 'file:shared'])
      expect(() => SQLiteOperationStateStore.create(filePath, 'client', binding, initial)).toThrow(
        'file path'
      )
  })

  it('retains a committed response across process exit without a close or acknowledgement', async () => {
    const file = path(),
      store = keep(SQLiteOperationStateStore.create(file, 'client', binding, initial))
    await store.close()
    const script = `
      import { SQLiteOperationStateStore } from './dist/operations/SQLiteOperationStateStore.js';
      const store = SQLiteOperationStateStore.open(process.argv[1], 'client', JSON.parse(process.argv[2]));
      await store.compareAndSwap('0', { job: '1', phase: 'response-pending' });
      process.exit(42);
    `
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, file, JSON.stringify(binding)],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(42)
    const recovered = keep(SQLiteOperationStateStore.open(file, 'client', binding))
    expect(await recovered.read()).toEqual({
      revision: '1',
      value: { job: '1', phase: 'response-pending' }
    })
    expect(await recovered.compareAndSwap('0', { job: '1', phase: 'response-pending' })).toEqual({
      status: 'replayed',
      revision: '1'
    })
  })
})
