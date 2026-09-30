import { knex } from 'knex'
import { StorageKnex, type StorageKnexOptions } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
const pendingOperations: Promise<unknown>[] = []
function observe<T>(operation: Promise<T>): Promise<T> {
  // Keep secondary cleanup failures attached when a preceding fault assertion
  // fails. Every primary result is still awaited/asserted by its owning test.
  void operation.catch(() => undefined)
  pendingOperations.push(operation)
  return operation
}
async function waitForBoundary(boundary: Promise<void>, operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    boundary,
    operation.then(() => {
      throw new Error('Operation completed before the required concurrency boundary')
    })
  ])
}
const stores: StorageKnex[] = []
function mysql(telemetry?: StorageKnexOptions['telemetry']) {
  const store = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    telemetry,
    knex: knex({
      client: 'mysql2',
      connection: { host: '127.0.0.1', database: 'synthetic', user: 'unit', password: 'synthetic-only' },
      pool: { min: 0, max: 1 }
    })
  })
  stores.push(store)
  return store
}
function view(): WalletReadSnapshot {
  const closed = gate()
  let open = true
  return {
    version: 1,
    snapshotId: 'a'.repeat(64),
    sourceStorage: {} as WalletReadSnapshot['sourceStorage'],
    user: {} as WalletReadSnapshot['user'],
    expiresAt: Date.now() + 10000,
    get isOpen() {
      return open
    },
    closed: closed.promise,
    close: async () => {
      open = false
      closed.resolve()
    },
    readPage: jest.fn()
  }
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const store of stores.splice(0)) await store.destroy()
  await Promise.allSettled(pendingOperations.splice(0))
})

test('the dedicated MySQL reader preserves hidden credentials and leaves original pool capacity intact', async () => {
  const capture = jest.fn()
  let enabled = true
  const source = mysql({ sink: { capture }, enabled: () => enabled })
  const result = view()
  const opening = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockImplementation(async function (
    this: StorageKnex
  ) {
    const connection = this.knex.client.config.connection as object
    const password = Object.getOwnPropertyDescriptor(connection, 'password')!
    expect(password.value).toBe('synthetic-only')
    expect(password.enumerable).toBe(false)
    expect(this.knex.client.config.pool.max).toBe(1)
    expect(this.getSnapshotSync()).toBeUndefined()
    this.knex.emit('query', { __knexQueryUid: 'synthetic', method: 'select', sql: 'private data' })
    this.knex.emit('query-response', [], { __knexQueryUid: 'synthetic' })
    return result
  })
  const opened = (await source.getSnapshotSync()!.openSource('identity'))!
  const child = opening.mock.contexts[0] as StorageKnex
  expect(child).not.toBe(source)
  expect(source.knex.client.config.pool.max).toBe(1)
  expect(capture).toHaveBeenCalled()
  expect(JSON.stringify(capture.mock.calls)).not.toContain('private data')
  enabled = false
  expect(child.telemetry.enabled).toBe(false)
  const cleanup = jest.spyOn(child, 'destroy')
  await opened.close()
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(opened.isOpen).toBe(false)
})

test('dynamic connection providers and externally shared pools retain the legacy path', async () => {
  const source = mysql()
  const original = source.knex.client.config.connection
  const open = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot')
  source.knex.client.config.connection = async () => original
  expect(await source.getSnapshotSync()!.openSource('identity')).toBeUndefined()
  source.knex.client.config.connection = original
  source.knex.client.config.connectionPool = { externallyOwned: true }
  expect(await source.getSnapshotSync()!.openSource('identity')).toBeUndefined()
  delete source.knex.client.config.connectionPool
  source.knex.client.config.connection = { user: 'unit' }
  expect(await source.getSnapshotSync()!.openSource('identity')).toBeUndefined()
  expect(open).not.toHaveBeenCalled()
})

test.each([undefined, '', ':memory:', 'file:synthetic-snapshot'])(
  'SQLite filename %s cannot open an independent retained reader',
  async filename => {
    const source = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({ client: 'better-sqlite3', connection: { filename: filename as string }, useNullAsDefault: true })
    })
    stores.push(source)
    const opening = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot')
    const query = jest.spyOn(source.knex.client, 'raw')
    expect(await source.getSnapshotSync()!.openSource('identity')).toBeUndefined()
    expect(opening).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  }
)

test('destroy fences a source that has not finished opening and drains its private reader', async () => {
  const source = mysql()
  const waiting = gate()
  const started = gate()
  const result = view()
  const closing = jest.spyOn(result, 'close')
  jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockImplementation(async () => {
    started.resolve()
    await waiting.promise
    return result
  })
  const opening = observe(source.getSnapshotSync()!.openSource('identity'))
  let destroying: Promise<void> | undefined
  try {
    await waitForBoundary(started.promise, opening)
    destroying = observe(source.destroy())
  } finally {
    waiting.resolve()
  }
  await expect(opening).rejects.toThrow('destruction')
  await destroying
  expect(closing).toHaveBeenCalled()
  expect(result.isOpen).toBe(false)
})

test('physical reader cleanup retains the admission slot until it finishes', async () => {
  const source = mysql()
  const result = view()
  const waiting = gate()
  const cleaning = gate()
  const opening = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockResolvedValue(result)
  const opened = (await source.getSnapshotSync()!.openSource('identity'))!
  const child = opening.mock.contexts[0] as StorageKnex
  const original = child.destroy.bind(child)
  jest.spyOn(child, 'destroy').mockImplementation(async () => {
    cleaning.resolve()
    await waiting.promise
    await original()
  })
  const closing = observe(opened.close())
  try {
    await waitForBoundary(cleaning.promise, closing)
    await expect(source.getSnapshotSync()!.openSource('identity')).rejects.toThrow('already has')
  } finally {
    waiting.resolve()
  }
  await closing
})

test('failed physical cleanup fences further source admission', async () => {
  const source = mysql()
  const result = view()
  const opening = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockResolvedValue(result)
  const opened = (await source.getSnapshotSync()!.openSource('identity'))!
  const child = opening.mock.contexts[0] as StorageKnex
  const cleanup = jest.spyOn(child, 'destroy').mockRejectedValue(new Error('synthetic cleanup failure'))
  await expect(opened.close()).rejects.toThrow('synthetic cleanup failure')
  await expect(source.getSnapshotSync()!.openSource('identity')).rejects.toThrow('destruction')
  cleanup.mockRestore()
  await child.destroy()
})

test('monotonic setup expiry releases admission before allocating a reader even if wall time is unchanged', async () => {
  const source = mysql()
  const open = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockResolvedValue(view())
  const wall = jest.spyOn(Date, 'now').mockReturnValue(2000000)
  const monotonic = jest.spyOn(performance, 'now').mockReturnValueOnce(1).mockReturnValue(1001)
  await expect(source.getSnapshotSync()!.openSource('identity', { lifetimeMs: 1000 })).rejects.toThrow(
    'expired during connection setup'
  )
  expect(open).not.toHaveBeenCalled()
  monotonic.mockRestore()
  wall.mockRestore()
  const fresh = (await source.getSnapshotSync()!.openSource('identity'))!
  await fresh.close()
  expect(open).toHaveBeenCalledTimes(1)
})

test.each([1, 3600000])(
  'the exact lifetime boundary %s and cancellation signal reach the dedicated reader',
  async lifetimeMs => {
    const source = mysql()
    const controller = new AbortController()
    jest.spyOn(Date, 'now').mockReturnValue(5000)
    jest.spyOn(performance, 'now').mockReturnValue(100)
    const open = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot').mockResolvedValue(view())
    const opened = (await source.getSnapshotSync()!.openSource('identity', { lifetimeMs, signal: controller.signal }))!
    expect(open).toHaveBeenCalledWith('identity', { lifetimeMs, signal: controller.signal })
    await opened.close()
  }
)

test('wall-clock setup expiry also fences opening when the monotonic clock does not advance', async () => {
  const source = mysql()
  jest.spyOn(performance, 'now').mockReturnValue(100)
  jest.spyOn(Date, 'now').mockReturnValueOnce(5000).mockReturnValue(6000)
  const open = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot')
  await expect(source.getSnapshotSync()!.openSource('identity', { lifetimeMs: 1000 })).rejects.toThrow(
    'expired during connection setup'
  )
  expect(open).not.toHaveBeenCalled()
})

test.each([null, 7])('unsupported connection value %p refuses before constructing another reader', async connection => {
  const source = mysql()
  const original = source.knex.client.config.connection
  source.knex.client.config.connection = connection
  const open = jest.spyOn(StorageKnex.prototype, 'openWalletReadSnapshot')
  try {
    expect(await source.getSnapshotSync()!.openSource('identity')).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  } finally {
    source.knex.client.config.connection = original
  }
})
