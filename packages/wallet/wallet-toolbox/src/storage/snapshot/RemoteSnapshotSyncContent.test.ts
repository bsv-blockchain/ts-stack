import { SnapshotCancelledError } from './SnapshotCancelledError'
import { migrateBeforeSnapshotContentReceipts } from '../../../test/utils/snapshotContentReceiptHistoricalFixture'
import * as CaptureBackend from './journal/SnapshotJournalCaptureBackend'
import type { SnapshotArchiveReaderOffer } from './archive/SnapshotArchiveReaderOffer'
import { KnexSnapshotArchiveRpc } from './archive/KnexSnapshotArchiveRpc'
import { SnapshotArchiveTransport } from './archive/SnapshotArchiveTransport'
import { openRemoteSnapshot } from './archive/openRemoteSnapshot'
import { WalletStorageManager } from '../WalletStorageManager'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { KnexRemoteSnapshotSyncRpc } from './KnexRemoteSnapshotSyncRpc'
import { RemoteSnapshotSyncDestination } from './RemoteSnapshotSyncDestination'
import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import { runInSeries } from '../../utility/runInSeries'
import { SNAPSHOT_SYNC_CONTENT_RECEIPTS } from '../schema/snapshotSyncReceiptMigration'
import { remoteSnapshotSyncCapabilities, validateRemoteSnapshotSyncCapabilities } from './RemoteSnapshotSyncProtocol'
import {
  parseRemoteSnapshotSyncContentInput,
  validateRemoteSnapshotSyncContentCapabilities
} from './RemoteSnapshotSyncContentProtocol'
import { snapshotSyncContentPosition } from './SnapshotSyncContentRevision'
import type { SnapshotJournalReconciliationSource } from './journal/SnapshotJournalCapture'

const identity = '02' + '11'.repeat(32),
  foreign = '03' + '22'.repeat(32)
const stores: StorageKnex[] = [],
  directories: string[] = [],
  controllers: Array<{ close: () => Promise<void> }> = [],
  views: SnapshotJournalReconciliationSource[] = []
async function fixture(name: string, content = true) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-snapshot-content-'))
  directories.push(directory)
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  stores.push(storage)
  await storage.knex.raw('PRAGMA journal_mode=WAL')
  if (content) await storage.migrate(name, name)
  else await migrateBeforeSnapshotContentReceipts(storage, name, name)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  await storage.updateUser(user.userId, { activeStorage: 'source' })
  return storage
}
function controller(storage: StorageKnex) {
  const result = new KnexRemoteSnapshotSyncRpc(storage)
  controllers.push(result)
  return result
}
async function source(storage: StorageKnex) {
  const view = await storage.openCurrentSnapshotJournalSource(identity)
  views.push(view)
  return view
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(controllers.splice(0), controller => controller.close())
  await runInSeries(views.splice(0), async view => {
    await view.close()
    await view.closed
  })
  await runInSeries(stores.splice(0), storage => storage.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

const data = {
  version: 1 as const,
  binding: '11'.repeat(32),
  content: '22'.repeat(32),
  metadata: '33'.repeat(32),
  highWater: '100',
  floor: '0'
}
test('content negotiation is separate and strict; wire getters and extra fields cannot execute', () => {
  expect(validateRemoteSnapshotSyncCapabilities(remoteSnapshotSyncCapabilities)).toBe(remoteSnapshotSyncCapabilities)
  expect(() => validateRemoteSnapshotSyncCapabilities({ ...remoteSnapshotSyncCapabilities, source: true })).toThrow()
  expect(
    validateRemoteSnapshotSyncContentCapabilities({ version: 1, source: true, destination: true, maxIoMs: 30000 })
  ).toEqual({ version: 1, source: true, destination: true, maxIoMs: 30000 })
  expect(() =>
    validateRemoteSnapshotSyncContentCapabilities({ version: 1, source: false, destination: false, maxIoMs: 30000 })
  ).toThrow()
  expect(() =>
    parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', [foreign, null], identity, 'test')
  ).toThrow()
  const getter = jest.fn(() => data)
  expect(() =>
    parseRemoteSnapshotSyncContentInput(
      'confirmSnapshotSyncContentReceipt',
      ['source', Object.defineProperty({}, 'version', { get: getter, enumerable: true })],
      identity,
      'test'
    )
  ).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() =>
    parseRemoteSnapshotSyncContentInput(
      'observeSnapshotSyncContent',
      [identity, { ...snapshotSyncContentPosition(data), grant: true }],
      identity,
      'test'
    )
  ).toThrow()
})

test('content RPC arguments must be a closed pair of own data cells before admission', () => {
  const getter = jest.fn(() => identity)
  const accessor = Object.defineProperty([identity, null], '0', { get: getter, enumerable: true })
  expect(() => parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', accessor, identity, 'test')).toThrow()
  expect(getter).not.toHaveBeenCalled()
  const sparse: unknown[] = []
  sparse.length = 2
  sparse[1] = null
  expect(() => parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', sparse, identity, 'test')).toThrow()
  const inherited = Object.setPrototypeOf(sparse, { 0: identity })
  expect(() => parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', inherited, identity, 'test')).toThrow()
  const extra = Object.assign([identity, null], { extra: 'not part of the protocol' })
  expect(() => parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', extra, identity, 'test')).toThrow()
  expect(parseRemoteSnapshotSyncContentInput('observeSnapshotSyncContent', [identity, null], identity, 'test')).toEqual(
    {
      method: 'observeSnapshotSyncContent',
      since: undefined
    }
  )
})

test('real remote destination copy commits the same-view receipt and authenticated confirmation returns the prior durable ACK', async () => {
  const local = await fixture('source'),
    remote = await fixture('destination'),
    server = controller(remote)
  const calls: string[] = []
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params) => {
      calls.push(method)
      return await server.dispatch(
        method,
        method === 'beginSnapshotSyncContent' ? JSON.parse(JSON.stringify(params)) : params,
        identity
      )
    },
    async () => {
      const caps = await server.contentCapabilities()
      return {
        storageIdentityKey: 'destination',
        supportsDestination: true,
        supportsContentSource: caps?.source,
        supportsContentDestination: caps?.destination
      }
    },
    async () => undefined
  )
  const view = await source(local),
    revision = await view.readContentRevision!()
  const result = await runSnapshotSyncSession(
    { view, destination: adapter, activeStorage: 'source', commit: async operation => await operation() },
    {}
  )
  expect(calls).toContain('beginSnapshotSyncContent')
  expect(calls).not.toContain('beginSnapshotSync')
  expect(result.snapshotCheckpoint?.done).toBe(true)
  const prior = await adapter.previousContentReceipt(identity, 'source')
  expect(prior?.source).toEqual(revision)
  expect(prior?.checkpoint).toEqual(result.snapshotCheckpoint)
  await view.close()
  await view.closed
  const observed = await local.observeSnapshotSyncContentRevision(identity, snapshotSyncContentPosition(revision))
  expect(await adapter.confirmContentReceipt(identity, 'source', observed!)).toEqual(result.snapshotCheckpoint)
  expect((await remote.knex(SNAPSHOT_SYNC_CONTENT_RECEIPTS).first()).sourceHighWater).toBe(observed?.highWater)
  await expect(server.dispatch('getSnapshotSyncContentReceipt', [identity, 'source'], foreign)).rejects.toThrow()
  expect(await server.dispatch('getSnapshotSyncContentReceipt', [foreign, 'source'], foreign)).toBeNull()
})

test('unadvertised old destination keeps the original BEGIN and never creates a completion receipt', async () => {
  const local = await fixture('source'),
    remote = await fixture('destination', false),
    server = controller(remote)
  expect(await server.contentCapabilities()).toBeUndefined()
  expect(await server.capabilities()).toEqual(remoteSnapshotSyncCapabilities)
  const calls: string[] = []
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params) => {
      calls.push(method)
      return await server.dispatch(
        method,
        method === 'beginSnapshotSync' ? JSON.parse(JSON.stringify(params)) : params,
        identity
      )
    },
    async () => ({ storageIdentityKey: 'destination', supportsDestination: true }),
    async () => undefined
  )
  const view = await source(local),
    read = jest.spyOn(view, 'readContentRevision')
  const result = await runSnapshotSyncSession(
    { view, destination: adapter, activeStorage: 'source', commit: async operation => await operation() },
    {}
  )
  expect(result.snapshotCheckpoint?.done).toBe(true)
  expect(calls).toContain('beginSnapshotSync')
  expect(calls).not.toContain('beginSnapshotSyncContent')
  expect(read).not.toHaveBeenCalled()
  expect(await remote.knex.schema.hasTable(SNAPSHOT_SYNC_CONTENT_RECEIPTS)).toBe(false)
  await expect(server.dispatch('observeSnapshotSyncContent', [identity, null], identity)).rejects.toThrow(
    'not installed'
  )
})

test('remote observation closes its real source and refuses another authenticated profile', async () => {
  const storage = await fixture('source'),
    server = controller(storage)
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params) => await server.dispatch(method, params, identity),
    async () => ({
      storageIdentityKey: 'source',
      supportsDestination: true,
      supportsContentSource: true,
      supportsContentDestination: true
    }),
    async () => undefined
  )
  const first = await adapter.observeContentRevision(identity)
  expect(first?.content).toMatch(/^[a-f0-9]{64}$/)
  const second = await adapter.observeContentRevision(identity, snapshotSyncContentPosition(first!))
  expect(second?.unchangedSince).toBe(first?.highWater)
  const reopened = await source(storage)
  expect(reopened.isOpen).toBe(true)
  await reopened.close()
  await reopened.closed
  await expect(adapter.observeContentRevision(foreign)).rejects.toThrow()
})

test('manager push confirms the prior completed copy without opening another data view; a later edit copies normally', async () => {
  const local = await fixture('source'),
    remote = await fixture('destination'),
    server = controller(remote)
  const calls: string[] = []
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params) => {
      calls.push(method)
      return await server.dispatch(
        method,
        method === 'beginSnapshotSyncContent' ? JSON.parse(JSON.stringify(params)) : params,
        identity
      )
    },
    async () => ({ storageIdentityKey: 'destination', supportsDestination: true, supportsContentDestination: true }),
    async () => undefined
  )
  // Provider facade represents the remote adapter. The actual SQL controller
  // continues to own its distinct original backend and transaction admission.
  const front = new Proxy(remote, {
    get(target, key) {
      if (key === 'getSnapshotSync') return () => adapter
      if (key === 'supportsSnapshotJournalSync') return async () => false
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const manager = new WalletStorageManager(identity, local, [front])
  await manager.makeAvailable()
  const open = jest.spyOn(local, 'openSnapshotSyncContentSource')
  const first = await manager.syncToWriterResumable({ identityKey: identity }, front)
  expect(first.snapshotCheckpoint?.done).toBe(true)
  expect(first.noChangeReceipt).toBeUndefined()
  const second = await manager.syncToWriterResumable({ identityKey: identity }, front, {
    onProgress: progress => {
      if (progress.noChangeReceipt !== undefined) progress.noChangeReceipt.checkpoint.done = false
    }
  })
  expect(second).toMatchObject({ status: 'completed', mode: 'paged', pages: 0, inserts: 0, updates: 0 })
  expect(second.snapshotCheckpoint).toBeUndefined()
  expect(second.noChangeReceipt?.checkpoint).toEqual(first.snapshotCheckpoint)
  // One copy owner plus one already-drained observation owner; no second data view.
  expect(open).toHaveBeenCalledTimes(2)
  expect(calls.filter(method => method === 'beginSnapshotSyncContent')).toHaveLength(1)
  const user = (await local.findUserByIdentityKey(identity))!
  await local.findOrInsertTxLabel(user.userId, 'copy new data')
  const third = await manager.syncToWriterResumable({ identityKey: identity }, front)
  expect(third.snapshotCheckpoint?.done).toBe(true)
  expect(third.noChangeReceipt).toBeUndefined()
  expect(calls.filter(method => method === 'beginSnapshotSyncContent')).toHaveLength(2)
  expect(await remote.findTxLabels({ partial: { label: 'copy new data' } })).toHaveLength(1)
})

test('manager pull uses an actual digest-bound content archive and the next unchanged pull avoids another capture', async () => {
  const remote = await fixture('source'),
    local = await fixture('destination'),
    server = controller(remote)
  const sourceUser = (await remote.findUserByIdentityKey(identity))!,
    destinationUser = (await local.findUserByIdentityKey(identity))!
  await remote.updateUser(sourceUser.userId, { activeStorage: 'destination' })
  await local.updateUser(destinationUser.userId, { activeStorage: 'destination' })
  const archives = new KnexSnapshotArchiveRpc(remote)
  controllers.push(archives)
  const calls: string[] = []
  const transport = (content: boolean) =>
    new SnapshotArchiveTransport(
      async (method, params) => {
        calls.push(method)
        return await archives.dispatch(method, params, identity)
      },
      identity,
      'source',
      'test',
      true,
      content
    )
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params) => await server.dispatch(method, params, identity),
    async () => ({
      storageIdentityKey: 'source',
      supportsDestination: true,
      supportsContentSource: true,
      supportsContentDestination: true
    }),
    async (_identityKey, options) => await openRemoteSnapshot(transport(false), options),
    async (_identityKey, options) => await openRemoteSnapshot(transport(true), options)
  )
  const front = new Proxy(remote, {
    get(target, key) {
      if (key === 'getSnapshotSync') return () => adapter
      if (key === 'supportsSnapshotJournalSync') return async () => false
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const manager = new WalletStorageManager(identity, local, [front])
  await manager.makeAvailable()
  const first = await manager.syncFromReaderResumable(identity, front)
  expect(first.snapshotCheckpoint?.done).toBe(true)
  expect(calls).toContain('admitSnapshotContentArchive')
  expect(calls).not.toContain('admitSnapshotArchive')
  expect(await remote.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await remote.knex('snapshot_archives')).toHaveLength(0)
  const second = await manager.syncFromReaderResumable(identity, front)
  expect(second.noChangeReceipt?.checkpoint).toEqual(first.snapshotCheckpoint)
  expect(second).toMatchObject({ status: 'completed', pages: 0, inserts: 0, updates: 0 })
  expect(calls.filter(method => method === 'admitSnapshotContentArchive')).toHaveLength(1)
  await remote.findOrInsertTxLabel(sourceUser.userId, 'new remote label')
  const third = await manager.syncFromReaderResumable(identity, front)
  expect(third.snapshotCheckpoint?.done).toBe(true)
  expect(third.noChangeReceipt).toBeUndefined()
  expect(await local.findTxLabels({ partial: { label: 'new remote label' } })).toHaveLength(1)
  expect(await remote.knex('snapshot_archive_owners')).toHaveLength(0)
})

test('altering a captured content revision breaks its archive digest before destination admission', async () => {
  const remote = await fixture('source'),
    archives = new KnexSnapshotArchiveRpc(remote)
  controllers.push(archives)
  const transport = new SnapshotArchiveTransport(
    async (method, params) => {
      const result = await archives.dispatch(method, params, identity)
      if (method !== 'getSnapshotArchiveDirectory') return result
      const directory = result as { bindingJson: string },
        binding = JSON.parse(directory.bindingJson)
      expect(binding.version).toBe(2)
      binding.contentRevision.content = 'ff'.repeat(32)
      return { ...directory, bindingJson: JSON.stringify(binding) }
    },
    identity,
    'source',
    'test',
    true,
    true
  )
  await expect(openRemoteSnapshot(transport)).rejects.toThrow()
  expect(await remote.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await remote.knex('snapshot_archives')).toHaveLength(0)
})

test('cross-replica cancellation retains content archive quota until the actual journal reader connection closes', async () => {
  const storage = await fixture('source'),
    first = new KnexSnapshotArchiveRpc(storage),
    second = new KnexSnapshotArchiveRpc(storage)
  controllers.push(first, second)
  let entered!: () => void, release!: () => void
  const closing = new Promise<void>(resolve => {
      entered = resolve
    }),
    continueClose = new Promise<void>(resolve => {
      release = resolve
    })
  const close = CaptureBackend.closeSnapshotJournalCapturePool
  let held = false
  jest.spyOn(CaptureBackend, 'closeSnapshotJournalCapturePool').mockImplementation(async (owner, connection) => {
    const modes: Array<{ query_only: number }> = await owner.raw('PRAGMA query_only').connection(connection)
    if (modes[0].query_only === 1 && !held) {
      held = true
      entered()
      await continueClose
    }
    await close(owner, connection)
  })
  let sourceClosed: Promise<void> | undefined
  const open = storage.openSnapshotSyncContentSource.bind(storage)
  jest.spyOn(storage, 'openSnapshotSyncContentSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    sourceClosed = source?.closed
    return source
  })
  const issued = (await first.dispatch(
    'getSnapshotContentArchiveReaderOffer',
    [{ version: 1, identityKey: identity, options: { lifetimeMs: 300000, maxBytes: 32768 } }],
    identity
  )) as Extract<SnapshotArchiveReaderOffer, { outcome: 'offered' }>
  expect(issued.outcome).toBe('offered')
  const params = [{ version: 1, identityKey: identity, request: issued.request }]
  await first.dispatch('admitSnapshotContentArchive', params, identity)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual reader close was not reached')), 5000)
      })
    ])
    expect(await storage.knex('snapshot_archive_pages').count('* as count').first()).toMatchObject({ count: 13 })
    expect(await second.dispatch('cancelSnapshotArchiveRequest', params, identity)).toMatchObject({
      outcome: 'cleanup-pending'
    })
    expect(await storage.knex('snapshot_archive_owners')).toHaveLength(1)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
    release()
    await sourceClosed
    expect(await second.dispatch('cancelSnapshotArchiveRequest', params, identity)).toBe(true)
    expect(await storage.knex('snapshot_archive_owners')).toHaveLength(0)
    expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    release()
  }
})

test('cancel requested during an observation waits for its bounded actual reply while foreground work completes', async () => {
  const storage = await fixture('source'),
    server = controller(storage),
    cancel = new AbortController()
  let reached!: () => void, release!: () => void
  const closed = new Promise<void>(resolve => {
      reached = resolve
    }),
    reply = new Promise<void>(resolve => {
      release = resolve
    })
  const observe = storage.observeSnapshotSyncContentRevision.bind(storage)
  jest.spyOn(storage, 'observeSnapshotSyncContentRevision').mockImplementation(async (...args) => {
    const result = await observe(...args)
    reached()
    await reply
    return result
  })
  let transportSignal: AbortSignal | undefined,
    drained = false,
    settled = false
  const adapter = new RemoteSnapshotSyncDestination(
    async (method, params, signal) => {
      transportSignal = signal
      const result = await server.dispatch(method, params, identity)
      drained = true
      return result
    },
    async () => ({ storageIdentityKey: 'source', supportsDestination: true, supportsContentSource: true }),
    async () => undefined
  )
  const pending = adapter.observeContentRevision(identity, undefined, { signal: cancel.signal })
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  try {
    await Promise.race([
      closed,
      pending.then(() => {
        throw new Error('Observation ended before held reply boundary')
      })
    ])
    cancel.abort()
    // Real serving SQL gives the cancelled client's promise a chance to settle;
    // it also proves observation owns no serving writer through the held reply.
    expect(await storage.findUserByIdentityKey(identity)).toBeDefined()
    expect(settled).toBe(false)
    expect(drained).toBe(false)
    expect(transportSignal?.aborted).toBe(false)
    release()
    await expect(pending).rejects.toBeInstanceOf(SnapshotCancelledError)
    expect(drained).toBe(true)
  } finally {
    release()
    await pending.catch(() => undefined)
  }
})
