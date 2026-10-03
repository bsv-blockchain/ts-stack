import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import { maintainSnapshotJournal, type SnapshotJournalMaintenanceRequest } from './SnapshotJournalMaintenance'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import * as Sqlite from './SnapshotJournalSqliteGeneration'
import * as Mysql from './SnapshotJournalMysqlGeneration'
import * as Backend from './SnapshotJournalCaptureBackend'
import * as Connections from './SnapshotJournalConnections'
import * as Fence from './SnapshotJournalMaintenanceFence'
import * as Receipts from './SnapshotJournalReceipt'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'

const identity = '02' + '11'.repeat(32),
  ceiling = snapshotJournalRevision('1000000')
const receiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 600000 }
const epoch = '00000000-0000-4000-8000-000000000000'
const input = (id = epoch): SnapshotJournalMaintenanceRequest => ({
  epoch: id,
  ceiling,
  receiptPolicy,
  operation: { kind: 'floor', floor: snapshotJournalRevision('0') }
})
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
async function fixture(complete = true) {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-maintenance-'))
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  try {
    await storage.migrate('owned maintenance', 'synthetic-maintenance')
    await storage.makeAvailable()
    await k.raw('PRAGMA journal_mode=WAL')
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, other.userId)
    await Sqlite.installSnapshotJournalSqliteGeneration(k, ceiling, receiptPolicy)
    let state = await Sqlite.readSnapshotJournalSqliteGeneration(k, receiptPolicy)
    if (complete) {
      let finished = false
      for (let n = 0; n < 80 && !finished; n++) finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
      expect(finished).toBe(true)
      state = await Sqlite.completeSnapshotJournalSqliteGeneration(k, receiptPolicy)
    }
    return {
      k,
      storage,
      request: input(state.epoch),
      async close() {
        await storage.destroy()
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await storage.destroy()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
afterEach(() => jest.restoreAllMocks())

test('the provider uses owned WAL transactions for floor and bounded collection', async () => {
  const f = await fixture()
  try {
    const result = await f.storage.maintainSnapshotJournal(f.request)
    expect(result).toMatchObject({ kind: 'floor', value: { floor: '0' } })
    await f.storage.awaitSnapshotJournalMaintenanceCleanup()
    const page = await f.storage.maintainSnapshotJournal({
      ...f.request,
      operation: {
        kind: 'collect',
        page: { epoch: f.request.epoch, floor: snapshotJournalRevision('0'), stream: 'scope', limit: 2 }
      }
    })
    expect(page).toMatchObject({ kind: 'collect', value: { examined: 2, removed: 0, complete: false } })
    expect(await f.k('snapshot_journal_receipts')).toHaveLength(0)
  } finally {
    await f.close()
  }
})
test('request binding is validated before native configuration or allocation', () => {
  const resolve = jest.fn<Promise<Knex.Config | undefined>, []>()
  for (const value of [
    { ...input(), epoch: 'bad' },
    { ...input(), epoch: 'prefix' + epoch },
    { ...input(), epoch: epoch + 'suffix' },
    { ...input(), epoch: { toString: () => epoch } },
    { ...input(), ceiling: '0' },
    { ...input(), operation: { kind: 'bad' } },
    {
      ...input(),
      operation: {
        kind: 'bad',
        page: { epoch, floor: '0', stream: 'scope', limit: 2 }
      }
    },
    {
      ...input(),
      operation: {
        kind: 'collect',
        page: { epoch: '10000000-0000-4000-8000-000000000000', floor: '0', stream: 'scope', limit: 2 }
      }
    }
  ])
    expect(() => maintainSnapshotJournal(resolve, value as SnapshotJournalMaintenanceRequest)).toThrow()
  expect(resolve).not.toHaveBeenCalled()
})
test('request fields are detached before asynchronous configuration work', async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate()
  try {
    const original = f.request
    const task = maintainSnapshotJournal(async () => {
      entered.resolve()
      await release.promise
      return f.k.client.config
    }, original)
    await entered.promise
    original.epoch = epoch
    original.receiptPolicy.receiptLimit = 1
    original.operation = { kind: 'floor', floor: snapshotJournalRevision('999999') }
    release.resolve()
    expect(await task.result).toMatchObject({ kind: 'floor', value: { floor: '0' } })
    await task.closed
  } finally {
    release.resolve()
    receiptPolicy.receiptLimit = 128
    await f.close()
  }
})
test('unsupported configuration refuses before creating a native owner', async () => {
  const task = maintainSnapshotJournal(async () => undefined, input())
  await expect(task.result).rejects.toThrow('requires file-backed')
  await expect(task.closed).rejects.toThrow('requires file-backed')
})
test.each(['incomplete', 'stale epoch', 'wrong ceiling', 'changed source DDL'] as const)(
  'refuses %s without advancing retention',
  async state => {
    const f = await fixture(state !== 'incomplete')
    try {
      if (state === 'stale epoch') f.request.epoch = epoch
      if (state === 'wrong ceiling') f.request.ceiling = snapshotJournalRevision('999999')
      if (state === 'changed source DDL')
        await f.k.schema.alterTable('tx_labels', table => table.integer('unowned_column'))
      await expect(f.storage.maintainSnapshotJournal(f.request)).rejects.toThrow()
      await expect(f.storage.awaitSnapshotJournalMaintenanceCleanup()).resolves.toBeUndefined()
      expect((await f.k('snapshot_journal_retention').first()).floor).toBe('0')
    } finally {
      await f.close()
    }
  }
)
test('disabled generation commits no floor or metadata deletion', async () => {
  const f = await fixture()
  try {
    await f.k('snapshot_journal_clock').update({ enabled: 0, reason: 'capacity-exhausted' })
    expect(await f.storage.maintainSnapshotJournal(f.request)).toEqual({ kind: 'floor', value: undefined })
    expect((await f.k('snapshot_journal_retention').first()).floor).toBe('0')
  } finally {
    await f.close()
  }
})
test('cancellation retains source admission through rollback and physical cleanup', async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate(),
    abort = new AbortController()
  const advance = Receipts.advanceSnapshotJournalFloor
  jest.spyOn(Receipts, 'advanceSnapshotJournalFloor').mockImplementation(async (...args) => {
    const value = await advance(...args)
    entered.resolve()
    await release.promise
    return value
  })
  try {
    const opening = f.storage.maintainSnapshotJournal(f.request, { signal: abort.signal }),
      rejection = expect(opening).rejects.toThrow('cancelled')
    await entered.promise
    abort.abort()
    await rejection
    await expect(f.storage.maintainSnapshotJournal(f.request)).rejects.toThrow('already')
    await expect(f.storage.openSnapshotJournalSource(identity, { ceiling, receiptPolicy })).rejects.toThrow('already')
    let drained = false
    const cleanup = f.storage.awaitSnapshotJournalMaintenanceCleanup().then(() => {
      drained = true
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(drained).toBe(false)
    release.resolve()
    await cleanup
    expect((await f.k('snapshot_journal_retention').first()).floor).toBe('0')
  } finally {
    release.resolve()
    await f.close()
  }
})
test('physical cleanup failure remains observable and permanently fences admission', async () => {
  const f = await fixture(),
    close = Backend.closeSnapshotJournalCapturePool,
    failure = new Error('synthetic pool closure failure')
  jest.spyOn(Backend, 'closeSnapshotJournalCapturePool').mockImplementation(async (...args) => {
    await close(...args)
    throw failure
  })
  try {
    await expect(f.storage.maintainSnapshotJournal(f.request)).rejects.toBeInstanceOf(
      Connections.SnapshotJournalConnectionCleanupError
    )
    await expect(f.storage.awaitSnapshotJournalMaintenanceCleanup()).rejects.toBeInstanceOf(
      Connections.SnapshotJournalConnectionCleanupError
    )
    await expect(f.storage.maintainSnapshotJournal(f.request)).rejects.toThrow('destruction')
    await expect(f.storage.destroy()).rejects.toBeInstanceOf(Connections.SnapshotJournalConnectionCleanupError)
  } finally {
    jest.restoreAllMocks()
    await f.storage.destroy().catch(() => undefined)
    await rm((f.k.client.config.connection as Knex.Sqlite3ConnectionConfig).filename.replace(/\/wallet\.sqlite$/, ''), {
      recursive: true,
      force: true
    })
  }
})

function mysqlOwner() {
  let completed = false
  const execution = Promise.resolve()
  const trx = {
    executionPromise: execution,
    isCompleted: jest.fn(() => completed),
    commit: jest.fn(async () => {
      completed = true
    }),
    rollback: jest.fn(async () => {
      completed = true
    })
  }
  const writer = { transaction: jest.fn(async () => trx), destroy: jest.fn(async () => undefined) },
    reader = { destroy: jest.fn(async () => undefined) }
  const factory = jest.requireActual<{ knex: typeof knex }>('knex')
  jest
    .spyOn(factory, 'knex')
    .mockReturnValueOnce(writer as unknown as Knex)
    .mockReturnValueOnce(reader as unknown as Knex)
  jest.spyOn(Backend, 'prepareSnapshotJournalCaptureBackend').mockResolvedValue({ kind: 'mysql' })
  jest.spyOn(Backend, 'bindSnapshotJournalCaptureBackend').mockResolvedValue('a'.repeat(64))
  jest
    .spyOn(Connections, 'withSnapshotJournalConnections')
    .mockImplementation(async (_writer, _reader, active, run) => {
      active()
      return await run({}, {})
    })
  jest.spyOn(Fence, 'lockSnapshotJournalMaintenanceOwner').mockResolvedValue()
  jest.spyOn(Mysql, 'readSnapshotJournalMysqlGeneration').mockResolvedValue({
    epoch,
    source: 'a'.repeat(64),
    plan: 'b'.repeat(64),
    ceiling,
    complete: true,
    enabled: true,
    nextObject: 59
  })
  jest.spyOn(Receipts, 'advanceSnapshotJournalFloor').mockResolvedValue({
    floor: snapshotJournalRevision('0'),
    highWater: snapshotJournalRevision('1'),
    examined: 0,
    liveReceipts: 0
  })
  const config: Knex.Config = {
    client: 'mysql2',
    connection: { database: 'synthetic' },
    pool: { min: 8, max: 9 },
    acquireConnectionTimeout: 12000
  }
  return { trx, writer, reader, config, factory }
}
test('MySQL setup preserves connection descriptors and bounds owned pool capacity and acquisition', async () => {
  const m = mysqlOwner()
  Object.defineProperty(m.config.connection, 'password', { enumerable: false, get: () => 'synthetic-secret' })
  const task = maintainSnapshotJournal(async () => m.config, input())
  expect(await task.result).toMatchObject({ kind: 'floor', value: { highWater: '1' } })
  await task.closed
  for (const [config] of (m.factory.knex as unknown as jest.Mock).mock.calls) {
    expect(config.pool).toMatchObject({ min: 0, max: 1 })
    expect(config.acquireConnectionTimeout).toBe(5000)
    expect(Object.getOwnPropertyDescriptor(config.connection, 'password')).toEqual(
      Object.getOwnPropertyDescriptor(m.config.connection, 'password')
    )
  }
  expect(m.config.pool).toMatchObject({ min: 8, max: 9 })
  expect(m.trx.commit).toHaveBeenCalledTimes(1)
  expect(m.trx.rollback).not.toHaveBeenCalled()
  expect(m.writer.destroy).toHaveBeenCalledTimes(1)
  expect(m.reader.destroy).toHaveBeenCalledTimes(1)
})
test.each(['backend', 'begin', 'generation', 'operation', 'commit', 'execution'] as const)(
  'retains %s failure and drains owned pools',
  async phase => {
    const m = mysqlOwner(),
      failure = new Error('source ' + phase)
    if (phase === 'backend') jest.spyOn(Backend, 'bindSnapshotJournalCaptureBackend').mockRejectedValue(failure)
    else if (phase === 'begin') m.writer.transaction.mockRejectedValue(failure)
    else if (phase === 'generation') jest.spyOn(Mysql, 'readSnapshotJournalMysqlGeneration').mockRejectedValue(failure)
    else if (phase === 'operation') jest.spyOn(Receipts, 'advanceSnapshotJournalFloor').mockRejectedValue(failure)
    else if (phase === 'commit') m.trx.commit.mockRejectedValue(failure)
    else {
      m.trx.executionPromise = Promise.reject(failure)
      void m.trx.executionPromise.catch(() => undefined)
    }
    const task = maintainSnapshotJournal(async () => m.config, input())
    await expect(task.result).rejects.toBe(failure)
    await expect(task.closed).rejects.toBe(failure)
    expect(m.writer.destroy).toHaveBeenCalledTimes(1)
    expect(m.reader.destroy).toHaveBeenCalledTimes(1)
  }
)
test('rollback failure retains the operation and cleanup causes', async () => {
  const m = mysqlOwner(),
    source = new Error('source failure'),
    cleanup = new Error('rollback failure')
  jest.spyOn(Receipts, 'advanceSnapshotJournalFloor').mockRejectedValue(source)
  m.trx.rollback.mockRejectedValue(cleanup)
  const task = maintainSnapshotJournal(async () => m.config, input())
  const error = await task.result.then(
    () => {
      throw new Error('Expected cleanup failure')
    },
    value => value as Connections.SnapshotJournalConnectionCleanupError
  )
  expect(error).toBeInstanceOf(Connections.SnapshotJournalConnectionCleanupError)
  expect((error.cause as AggregateError).errors).toEqual([source, cleanup])
  await expect(task.closed).rejects.toBe(error)
})
test('pool destruction failure retains an undefined source rejection and its native cause', async () => {
  const m = mysqlOwner(),
    cleanup = new Error('pool destroy failure')
  jest.spyOn(Receipts, 'advanceSnapshotJournalFloor').mockRejectedValue(undefined)
  m.writer.destroy.mockRejectedValue(cleanup)
  const task = maintainSnapshotJournal(async () => m.config, input())
  const error = await task.result.then(
    () => {
      throw new Error('Expected cleanup failure')
    },
    value => value as Connections.SnapshotJournalConnectionCleanupError
  )
  expect(error).toBeInstanceOf(Connections.SnapshotJournalConnectionCleanupError)
  expect((error.cause as AggregateError).errors).toEqual([undefined, cleanup])
  await expect(task.closed).rejects.toBe(error)
})
test('missing operation result fails closed after native providers drain', async () => {
  const m = mysqlOwner()
  jest.spyOn(Connections, 'withSnapshotJournalConnections').mockResolvedValue(undefined)
  const task = maintainSnapshotJournal(async () => m.config, input())
  await expect(task.result).rejects.toThrow('generation')
  await expect(task.closed).rejects.toThrow('generation')
  expect(m.writer.destroy).toHaveBeenCalledTimes(1)
})
test('cleanup-only pool failure cannot publish an otherwise committed result', async () => {
  const m = mysqlOwner(),
    cleanup = new Error('native pool closure failed')
  m.reader.destroy.mockRejectedValue(cleanup)
  const task = maintainSnapshotJournal(async () => m.config, input())
  const error = await task.result.then(
    () => {
      throw new Error('Expected cleanup failure')
    },
    value => value as Connections.SnapshotJournalConnectionCleanupError
  )
  expect((error.cause as AggregateError).errors).toEqual([cleanup])
  await expect(task.closed).rejects.toBe(error)
  expect(m.trx.commit).toHaveBeenCalledTimes(1)
})
test('a driver that still reports an active transaction must drain it before returning', async () => {
  const m = mysqlOwner(),
    cleanup = new Error('active transaction cleanup failed')
  m.trx.isCompleted.mockReturnValue(false)
  m.trx.rollback.mockRejectedValue(cleanup)
  const task = maintainSnapshotJournal(async () => m.config, input())
  const error = await task.result.then(
    () => {
      throw new Error('Expected cleanup failure')
    },
    value => value as Connections.SnapshotJournalConnectionCleanupError
  )
  expect((error.cause as AggregateError).errors).toEqual([cleanup])
  await expect(task.closed).rejects.toBe(error)
  expect(m.trx.commit).toHaveBeenCalledTimes(1)
  expect(m.trx.rollback).toHaveBeenCalledTimes(1)
})
