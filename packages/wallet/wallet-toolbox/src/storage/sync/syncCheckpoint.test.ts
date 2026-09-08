import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { StorageServer } from '../remoting/StorageServer'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { EntitySyncState } from '../schema/entities/EntitySyncState'
import { StorageClient } from '../remoting/StorageClient'
import { validateSyncCheckpoint } from './syncCheckpoint'
import type { RequestSyncChunkArgs, SyncCheckpoint } from '../../sdk/WalletStorage.interfaces'

async function makeStorage(): Promise<StorageIdb> {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  storage.dbName = `sync-checkpoint-${randomUUID()}`
  await storage.migrate('synthetic sync fixture', PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

function checkpoint(): SyncCheckpoint {
  const state = new EntitySyncState()
  state.id = 1
  return state.makeSyncCheckpoint()
}

describe('compact sync checkpoints', () => {
  test('validates offsets and dates and strips unrelated remote fields', () => {
    const c = checkpoint()
    const parsed = validateSyncCheckpoint({ ...c, since: '2026-01-01T00:00:00.000Z', extra: 'ignored' } as never)
    expect(parsed.since).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed.offsets).not.toBe(c.offsets)
    for (const bad of [
      null,
      {},
      { ...c, syncStateId: 0 },
      { ...c, syncStateId: 1.5 },
      { ...c, offsets: [] },
      { ...c, since: 'invalid' },
      { ...c, since: 123 },
      { ...c, offsets: c.offsets.map((r, i) => (i ? r : { ...r, offset: -1 })) },
      { ...c, offsets: c.offsets.map((r, i) => (i ? r : { ...r, offset: Number.MAX_SAFE_INTEGER + 1 })) },
      { ...c, offsets: [...c.offsets].reverse() }
    ]) {
      expect(() => validateSyncCheckpoint(bad as SyncCheckpoint)).toThrow('Invalid sync checkpoint')
    }
    expect(() => validateSyncCheckpoint(c, { syncStateId: 2 })).toThrow()
    expect(() => validateSyncCheckpoint(c, { since: new Date() })).toThrow()
  })

  test('checkpoint size stays bounded as the durable ID map grows and remains user scoped', async () => {
    const storage = await makeStorage()
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const otherKey = PrivateKey.fromRandom().toPublicKey().toString()
    try {
      const { user } = await storage.findOrInsertUser(identityKey)
      const c = await storage.getSyncCheckpoint({ identityKey }, 'source', 'source')
      const rows = await storage.findSyncStates({ partial: { syncStateId: c.syncStateId } })
      const state = new EntitySyncState(rows[0])
      for (let i = 1; i <= 50000; i++) state.syncMap.transaction.idMap[i] = i + 100
      state.syncMap.transaction.count = 50000
      await state.updateStorage(storage)
      const compact = await storage.getSyncCheckpoint({ identityKey }, 'source', 'source')
      expect(JSON.stringify(compact).length).toBeLessThan(1024)
      expect(compact.offsets.find(row => row.name === 'transaction')?.offset).toBe(50000)
      const retained = new EntitySyncState(
        (await storage.findSyncStates({ partial: { syncStateId: c.syncStateId } }))[0]
      )
      expect(Object.keys(retained.syncMap.transaction.idMap)).toHaveLength(50000)
      const other = await storage.getSyncCheckpoint({ identityKey: otherKey, userId: user.userId }, 'source', 'source')
      expect(other.syncStateId).not.toBe(c.syncStateId)
      expect(other.offsets.every(row => row.offset === 0)).toBe(true)
    } finally {
      await storage.destroy()
      await storage.dropAllData()
    }
  })

  test('syncs every page, reuses committed progress, and performs a no-change resync', async () => {
    const reader = await makeStorage()
    const writer = await makeStorage()
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const manager = new WalletStorageManager(identityKey, reader)
    try {
      await manager.makeAvailable()
      const { user } = await reader.findOrInsertUser(identityKey)
      for (let i = 0; i < 27; i++) {
        await reader.findOrInsertTxLabel(user.userId, `synthetic label ${i}`)
      }
      const getChunk = reader.getSyncChunk.bind(reader)
      jest.spyOn(reader, 'getSyncChunk').mockImplementation(args => getChunk({ ...args, maxItems: 5 }))
      const initialCheckpoint = jest.spyOn(writer, 'getSyncCheckpoint')
      const oldCheckpoint = jest.spyOn(writer, 'findOrInsertSyncStateAuth')
      const process = jest.spyOn(writer, 'processSyncChunk')
      const result = await manager.syncToWriter({ identityKey }, writer)
      expect(result.inserts).toBeGreaterThanOrEqual(27)
      expect(process.mock.calls.length).toBeGreaterThan(5)
      expect(initialCheckpoint).toHaveBeenCalledTimes(1)
      expect(oldCheckpoint).toHaveBeenCalledTimes(1)
      const { user: targetUser } = await writer.findOrInsertUser(identityKey)
      expect(await writer.countTxLabels({ partial: { userId: targetUser.userId } })).toBe(27)
      const repeated = await manager.syncToWriter({ identityKey }, writer)
      expect(repeated.inserts).toBe(0)
      expect(repeated.updates).toBe(0)
    } finally {
      await reader.destroy()
      await writer.destroy()
      await reader.dropAllData()
      await writer.dropAllData()
    }
  })

  test.each([false, true])('restores all pages and resyncs with a legacy writer: %s', async legacy => {
    const reader = await makeStorage()
    const writer = await makeStorage()
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const manager = new WalletStorageManager(identityKey, writer)
    try {
      await manager.makeAvailable()
      const { user } = await reader.findOrInsertUser(identityKey)
      for (let i = 0; i < 23; i++) await reader.findOrInsertTxLabel(user.userId, `restore ${i}`)
      const read = reader.getSyncChunk.bind(reader)
      const readSpy = jest.spyOn(reader, 'getSyncChunk').mockImplementation(args => read({ ...args, maxItems: 4 }))
      if (legacy) {
        jest.spyOn(writer, 'getSyncCheckpoint').mockResolvedValue(undefined as never)
        const process = writer.processSyncChunk.bind(writer)
        jest.spyOn(writer, 'processSyncChunk').mockImplementation(async (args, chunk) => {
          const { nextCheckpoint: _, ...result } = await process({ ...args, includeNextCheckpoint: undefined }, chunk)
          return result
        })
      }
      const restored = await manager.syncFromReader(identityKey, reader)
      expect(restored.inserts).toBeGreaterThanOrEqual(23)
      expect(readSpy.mock.calls.length).toBeGreaterThan(5)
      const { user: target } = await writer.findOrInsertUser(identityKey)
      expect(await writer.countTxLabels({ partial: { userId: target.userId } })).toBe(23)
      const repeated = await manager.syncFromReader(identityKey, reader)
      expect(repeated.inserts).toBe(0)
      expect(repeated.updates).toBe(0)
    } finally {
      await reader.destroy()
      await writer.destroy()
      await reader.dropAllData()
      await writer.dropAllData()
    }
  })

  test.each([false, true])(
    'resumes after a failed page, including lost commit acknowledgement: %s',
    async committed => {
      const reader = await makeStorage()
      const writer = await makeStorage()
      const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
      const manager = new WalletStorageManager(identityKey, reader)
      try {
        await manager.makeAvailable()
        const { user } = await reader.findOrInsertUser(identityKey)
        for (let i = 0; i < 12; i++) await reader.findOrInsertTxLabel(user.userId, `resume ${i}`)
        const read = reader.getSyncChunk.bind(reader)
        jest.spyOn(reader, 'getSyncChunk').mockImplementation(args => read({ ...args, maxItems: 4 }))
        const process = writer.processSyncChunk.bind(writer)
        let pages = 0
        const spy = jest.spyOn(writer, 'processSyncChunk').mockImplementation(async (args, chunk) => {
          if (++pages === 2) {
            if (committed) await process(args, chunk)
            throw new Error('synthetic transport failure')
          }
          return process(args, chunk)
        })
        await expect(manager.syncToWriter({ identityKey }, writer)).rejects.toThrow('synthetic transport failure')
        const before = await writer.getSyncCheckpoint(
          { identityKey },
          reader.getSettings().storageIdentityKey,
          reader.getSettings().storageName
        )
        expect(before.offsets.some(row => row.offset > 0)).toBe(true)
        spy.mockRestore()
        await manager.syncToWriter({ identityKey }, writer)
        const { user: target } = await writer.findOrInsertUser(identityKey)
        expect(await writer.countTxLabels({ partial: { userId: target.userId } })).toBe(12)
      } finally {
        await reader.destroy()
        await writer.destroy()
        await reader.dropAllData()
        await writer.dropAllData()
      }
    }
  )

  test('backs up and restores every page through authenticated HTTP with compact committed progress', async () => {
    const remote = await _tu.createSQLiteTestWallet({ databaseName: 'compactCheckpointHttp', dropAll: true })
    const source = await makeStorage()
    const restored = await makeStorage()
    const server = new StorageServer(remote.activeStorage, {
      port: 0,
      wallet: remote.wallet,
      monetize: false,
      logRpcRequests: false,
      calculateRequestPrice: async () => 0
    })
    let client: StorageClient | undefined
    try {
      server.start()
      if (!server.server.listening) await once(server.server, 'listening')
      const address = server.server.address()
      if (address == null || typeof address === 'string') throw new Error('test server did not bind')
      client = new StorageClient(remote.wallet, `http://localhost:${address.port}`, { binaryRequests: true })
      const identityKey = remote.identityKey
      const manager = new WalletStorageManager(identityKey, source)
      await manager.makeAvailable()
      const { user } = await source.findOrInsertUser(identityKey)
      for (let i = 0; i < 37; i++) await source.findOrInsertTxLabel(user.userId, `http fixture ${i}`)
      const read = source.getSyncChunk.bind(source)
      jest.spyOn(source, 'getSyncChunk').mockImplementation(args => read({ ...args, maxItems: 5 }))
      const checkpoints = jest.spyOn(client, 'getSyncCheckpoint')
      const fullStates = jest.spyOn(client, 'findOrInsertSyncStateAuth')
      const backup = await manager.syncToWriter({ identityKey }, client)
      expect(backup.inserts).toBeGreaterThanOrEqual(37)
      expect(checkpoints).toHaveBeenCalledTimes(1)
      expect(fullStates).not.toHaveBeenCalled()
      const remoteRead = remote.activeStorage.getSyncChunk.bind(remote.activeStorage)
      jest.spyOn(remote.activeStorage, 'getSyncChunk').mockImplementation(args => remoteRead({ ...args, maxItems: 5 }))
      const restoreManager = new WalletStorageManager(identityKey, restored)
      await restoreManager.makeAvailable()
      await restoreManager.syncFromReader(identityKey, client)
      const { user: target } = await restored.findOrInsertUser(identityKey)
      expect(await restored.countTxLabels({ partial: { userId: target.userId } })).toBe(37)
      const noChange = await restoreManager.syncFromReader(identityKey, client)
      expect(noChange.inserts).toBe(0)
      expect(noChange.updates).toBe(0)
      // Exercise real authenticated binary uploads independently of entity merge rules.
      const bytes = Array.from({ length: 4096 }, (_, i) => i % 256)
      const process = jest.spyOn(remote.activeStorage, 'processSyncChunk').mockResolvedValueOnce({
        done: true,
        inserts: 0,
        updates: 0,
        maxUpdated_at: undefined
      })
      const authClient = Reflect.get(client, 'authClient') as { fetch: typeof fetch }
      const fetchSpy = jest.spyOn(authClient, 'fetch')
      await client.processSyncChunk(
        { identityKey } as RequestSyncChunkArgs,
        {
          outputs: [{ created_at: new Date(), updated_at: new Date(), lockingScript: bytes }]
        } as never
      )
      expect(process.mock.calls[0][1].outputs?.[0].lockingScript).toEqual(bytes)
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
      expect(body.params[1].outputs[0].lockingScript.$bsvBinary).toBe('base64')
      expect(JSON.stringify(body).length).toBeLessThan(JSON.stringify(bytes).length)
    } finally {
      await client?.destroy()
      await server.close()
      await remote.wallet.destroy()
      await source.destroy()
      await restored.destroy()
      await source.dropAllData()
      await restored.dropAllData()
    }
  }, 60000)

  test('uses advertised support without probing legacy providers or hiding gateway failures', async () => {
    const client = new StorageClient({} as never, 'https://storage.example')
    const rpc = jest.spyOn(client as never, 'rpcCall' as never) as jest.SpyInstance
    rpc.mockResolvedValue({ storageIdentityKey: 'legacy' })
    await expect(client.getSyncCheckpoint({ identityKey: 'synthetic' }, 'source', 'source')).resolves.toBeUndefined()
    await expect(client.getSyncCheckpoint({ identityKey: 'synthetic' }, 'source', 'source')).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('makeAvailable', [])
    const supported = new StorageClient({} as never, 'https://storage.example')
    const freshRpc = jest.spyOn(supported as never, 'rpcCall' as never) as jest.SpyInstance
    freshRpc.mockResolvedValueOnce({ storageIdentityKey: 'current', syncCheckpointVersion: 1 })
    freshRpc.mockRejectedValueOnce(new Error('gateway 502'))
    await expect(supported.getSyncCheckpoint({ identityKey: 'synthetic' }, 'source', 'source')).rejects.toThrow('502')
    freshRpc.mockResolvedValueOnce({})
    await expect(supported.getSyncCheckpoint({ identityKey: 'synthetic' }, 'source', 'source')).rejects.toThrow(
      'Invalid sync checkpoint'
    )
    freshRpc.mockResolvedValueOnce(checkpoint())
    await expect(supported.getSyncCheckpoint({ identityKey: 'synthetic' }, 'source', 'source')).resolves.toEqual(
      checkpoint()
    )
    freshRpc.mockRejectedValueOnce(new Error('gateway 502'))
    await expect(supported.processSyncChunk({} as RequestSyncChunkArgs, {} as never)).rejects.toThrow('502')
    expect(freshRpc.mock.calls.filter(row => row[0] === 'processSyncChunk')).toHaveLength(1)
  })
})
