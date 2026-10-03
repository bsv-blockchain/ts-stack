import { EventEmitter } from 'node:events'
import type { Knex } from 'knex'
import { SnapshotArchiveSourceCleanupError } from './KnexSnapshotArchiveSource'
import {
  assertSnapshotArchiveGuardBackend,
  prepareSnapshotArchiveGuardBackend,
  SnapshotArchiveGuardBusyError,
  withSnapshotArchiveBackendGuard,
  type SnapshotArchiveGuardBinding
} from './SnapshotArchiveGuardBackend'

const uuid = '12345678-1234-1234-1234-123456789abc'
const identity = { serverUuid: uuid, databaseName: 'fixture' }
function fixture() {
  const stream = Object.assign(new EventEmitter(), { destroyed: false, closed: false })
  const connection = { stream }
  const close = () => {
    stream.destroyed = true
    stream.closed = true
    stream.emit('close')
  }
  const reply = jest.fn((sql: string): unknown => {
    if (sql.startsWith('SELECT @@')) return [[identity]]
    if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]]
    return []
  })
  const queries: Array<{ sql: string; values: unknown; connection?: unknown }> = []
  const raw = jest.fn((sql: string, values?: unknown) => {
    const entry = { sql, values, connection: undefined as unknown }
    queries.push(entry)
    return Object.assign(
      Promise.resolve().then(() => reply(sql)),
      {
        connection(value: unknown) {
          entry.connection = value
          return this
        }
      }
    )
  })
  const trx = { executionPromise: Promise.resolve(), rollback: jest.fn(async () => undefined) }
  const destroy = jest.fn(async () => close())
  const client = {
    config: { client: 'mysql2' },
    acquireConnection: jest.fn(async () => connection),
    releaseConnection: jest.fn(async () => undefined)
  }
  const transaction = jest.fn(async () => trx)
  const k = { raw, client, transaction, destroy } as unknown as Knex
  return { k, stream, close, connection, reply, queries, trx, destroy, client, transaction }
}

test('MySQL guard namespaces bind the actual server, database and bounded slot', async () => {
  const f = fixture()
  const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
  expect(binding).toMatchObject({ version: 1, kind: 'mysql', serverUuid: uuid, database: 'fixture' })
  if (binding.kind !== 'mysql') throw new Error('Expected MySQL binding')
  expect(binding.lock).toMatch(/^wallet-snapshot-v1:[0-9a-f]{40}:0$/)
  expect(binding.lock.length).toBeLessThanOrEqual(64)
  expect(await prepareSnapshotArchiveGuardBackend(f.k, 0, JSON.stringify(binding))).toEqual(binding)
  expect(await prepareSnapshotArchiveGuardBackend(f.k, 7, null)).not.toEqual(binding)
  for (const slot of [-1, 8, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(prepareSnapshotArchiveGuardBackend(f.k, slot, null)).rejects.toThrow('identity changed')
  await expect(prepareSnapshotArchiveGuardBackend(f.k, 1, JSON.stringify(binding))).rejects.toThrow('identity changed')
})

test.each([
  undefined,
  { serverUuid: null, databaseName: 'fixture' },
  { serverUuid: 'not-a-server', databaseName: 'fixture' },
  { serverUuid: 'a' + uuid, databaseName: 'fixture' },
  { serverUuid: uuid + 'a', databaseName: 'fixture' },
  { serverUuid: uuid, databaseName: undefined },
  { serverUuid: uuid, databaseName: '' },
  { serverUuid: uuid, databaseName: 'x'.repeat(65) }
])('invalid MySQL identity %j refuses a guard', async row => {
  const f = fixture()
  f.reply.mockReturnValue([[row]])
  await expect(prepareSnapshotArchiveGuardBackend(f.k, 0, null)).rejects.toThrow('identity changed')
})

test.each(['server', 'database'] as const)(
  'physical %s mismatch refuses reads and closes its private connection',
  async field => {
    const f = fixture()
    const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
    f.reply.mockImplementation(sql =>
      sql.startsWith('SELECT @@')
        ? [[field === 'server' ? { ...identity, serverUuid: 'a'.repeat(36) } : { ...identity, databaseName: 'other' }]]
        : [[{ acquired: 1 }]]
    )
    const read = jest.fn()
    await expect(withSnapshotArchiveBackendGuard(f.k, binding, read)).rejects.toThrow('identity changed')
    expect(read).not.toHaveBeenCalled()
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.queries.at(-1)?.connection).toBe(f.connection)
    expect(f.stream.closed).toBe(true)
    expect(f.client.releaseConnection).toHaveBeenCalledWith(f.connection)
  }
)

test.each([0, null, undefined, 2])('MySQL GET_LOCK result %s never admits a read', async acquired => {
  const f = fixture()
  const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
  f.reply.mockImplementation(sql => (sql.startsWith('SELECT @@') ? [[identity]] : [[{ acquired }]]))
  const read = jest.fn()
  const work = withSnapshotArchiveBackendGuard(f.k, binding, read)
  if (acquired === 0) await expect(work).rejects.toBeInstanceOf(SnapshotArchiveGuardBusyError)
  else await expect(work).rejects.toThrow('identity changed')
  expect(read).not.toHaveBeenCalled()
  expect(f.transaction).not.toHaveBeenCalled()
  expect(f.stream.closed).toBe(true)
})

test('a graceful quit and a destroyed socket still wait for physical close before rollback or success', async () => {
  const f = fixture()
  const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
  let quit!: () => void
  const quitting = new Promise<void>(resolve => {
    quit = resolve
  })
  f.destroy.mockImplementation(async () => {
    f.stream.destroyed = true
    quit()
  })
  let settled = false
  const work = withSnapshotArchiveBackendGuard(f.k, binding, async trx => {
    expect(trx).toBe(f.trx)
    return 42
  }).finally(() => {
    settled = true
  })
  void work.catch(() => undefined)
  try {
    await quitting
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(f.trx.rollback).not.toHaveBeenCalled()
    expect(f.stream.listenerCount('close')).toBe(1)
    expect(f.queries.slice(1).map(query => query.sql)).toEqual([
      'SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName',
      'SELECT GET_LOCK(?, 0) AS acquired',
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'
    ])
    expect(f.queries.slice(1).every(query => query.connection === f.connection)).toBe(true)
    expect(f.queries[2].values).toEqual([(binding as Extract<SnapshotArchiveGuardBinding, { kind: 'mysql' }>).lock])
    expect(f.transaction).toHaveBeenCalledWith({ connection: f.connection })
    f.close()
    await expect(work).resolves.toBe(42)
    expect(f.trx.rollback).toHaveBeenCalledTimes(1)
    expect(f.stream.listenerCount('close')).toBe(0)
  } finally {
    if (!f.stream.closed) f.close()
    await work.catch(() => undefined)
  }
})

test('a socket destroyed before cleanup still waits for its pending close event', async () => {
  const f = fixture()
  const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
  let cleanup!: () => void
  const started = new Promise<void>(resolve => {
    cleanup = resolve
  })
  f.destroy.mockImplementation(async () => {
    cleanup()
  })
  const work = withSnapshotArchiveBackendGuard(f.k, binding, async () => {
    f.stream.destroyed = true
    return 'read'
  })
  void work.catch(() => undefined)
  try {
    await started
    expect(f.stream.listenerCount('close')).toBe(1)
    expect(f.trx.rollback).not.toHaveBeenCalled()
    f.close()
    await expect(work).resolves.toBe('read')
  } finally {
    if (!f.stream.closed) f.close()
    await work.catch(() => undefined)
  }
})

test.each([new Error('read failed'), undefined])(
  'proved close preserves the exact independent read failure %s',
  async failure => {
    const f = fixture()
    const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
    f.trx.rollback.mockRejectedValue(new Error('connection already closed'))
    await expect(
      withSnapshotArchiveBackendGuard(f.k, binding, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(f.stream.closed).toBe(true)
    expect(f.stream.listenerCount('close')).toBe(0)
  }
)

test.each(['destroy', 'release'] as const)(
  'a %s failure retains the manual transaction and reports cleanup failure',
  async phase => {
    const f = fixture()
    const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
    const failure = new Error('native cleanup failed')
    f.destroy.mockImplementation(async () => undefined)
    if (phase === 'destroy') f.destroy.mockRejectedValue(failure)
    else f.client.releaseConnection.mockRejectedValue(failure)
    try {
      await expect(withSnapshotArchiveBackendGuard(f.k, binding, async () => 1)).rejects.toBeInstanceOf(
        SnapshotArchiveSourceCleanupError
      )
      expect(f.trx.rollback).not.toHaveBeenCalled()
      expect(f.stream.closed).toBe(false)
      expect(f.stream.listenerCount('close')).toBe(0)
    } finally {
      f.close()
    }
  }
)

test('a previously closed socket does not need another close event', async () => {
  const f = fixture()
  const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
  f.destroy.mockImplementation(async () => undefined)
  await expect(
    withSnapshotArchiveBackendGuard(f.k, binding, async () => {
      f.close()
      return 3
    })
  ).resolves.toBe(3)
  expect(f.stream.listenerCount('close')).toBe(0)
  await assertSnapshotArchiveGuardBackend(f.k, binding)
  expect(f.queries.at(-1)?.connection).toBeUndefined()
})

test('unsupported backend refuses before acquiring a source', async () => {
  const f = fixture()
  f.client.config.client = 'other'
  await expect(prepareSnapshotArchiveGuardBackend(f.k, 0, null)).rejects.toThrow('require better-sqlite3 WAL or MySQL')
  expect(f.client.acquireConnection).not.toHaveBeenCalled()
})

test.each([1, 64])('MySQL accepts a valid database name of exactly %s characters', async length => {
  const f = fixture()
  const databaseName = 'd'.repeat(length)
  f.reply.mockReturnValue([[{ serverUuid: uuid.toUpperCase(), databaseName }]])
  expect(await prepareSnapshotArchiveGuardBackend(f.k, 0, null)).toMatchObject({
    kind: 'mysql',
    serverUuid: uuid.toUpperCase(),
    database: databaseName
  })
})

test.each(['missing-stream', 'unproved-event'] as const)(
  'MySQL cleanup refuses %s without treating the read transaction as released',
  async kind => {
    const f = fixture()
    const binding = await prepareSnapshotArchiveGuardBackend(f.k, 0, null)
    if (kind === 'missing-stream') Reflect.deleteProperty(f.connection, 'stream')
    else
      f.destroy.mockImplementation(async () => {
        f.stream.emit('close')
      })
    try {
      await expect(withSnapshotArchiveBackendGuard(f.k, binding, async () => 1)).rejects.toMatchObject({
        name: 'SnapshotArchiveSourceCleanupError',
        cause: { message: 'Snapshot archive source connection did not close' }
      })
      expect(f.trx.rollback).not.toHaveBeenCalled()
      expect(f.stream.listenerCount('close')).toBe(0)
    } finally {
      f.close()
    }
  }
)
