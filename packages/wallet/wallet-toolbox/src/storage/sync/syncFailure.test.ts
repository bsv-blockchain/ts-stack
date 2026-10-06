import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { WalletError } from '../../sdk/WalletError'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { WERR_INTERNAL, WERR_NETWORK_CHAIN } from '../../sdk/WERR_errors'
import type { Chain } from '../../sdk/types'
import type { ProcessSyncChunkResult } from '../../sdk/WalletStorage.interfaces'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { throwSyncResultError } from './syncFailure'

const stores: StorageIdb[] = []
const identityKey = PrivateKey.fromRandom().toPublicKey().toString()

async function makeStorage(chain: Chain = 'test'): Promise<StorageIdb> {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions(chain))
  storage.dbName = `sync-failure-${randomUUID()}`
  stores.push(storage)
  await storage.migrate('sync failure fixture', PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

afterEach(async () => {
  jest.restoreAllMocks()
  for (const storage of stores.splice(0)) {
    await storage.destroy()
    await storage.dropAllData()
  }
})

describe.each(['to', 'from'] as const)('sync %s failure contracts', direction => {
  function copy(reader: StorageIdb, writer: StorageIdb): Promise<unknown> {
    const manager = new WalletStorageManager(identityKey, direction === 'to' ? reader : writer)
    return direction === 'to'
      ? manager.syncToWriter({ identityKey }, writer)
      : manager.syncFromReader(identityKey, reader)
  }

  test.each<Chain>(['main', 'stn', 'ttn', 'tstn', 'mock'])(
    'rejects test/%s before user registration, checkpoint creation or a chunk read',
    async chain => {
      const reader = await makeStorage(chain)
      const writer = await makeStorage()
      const read = jest.spyOn(reader, 'getSyncChunk')
      const process = jest.spyOn(writer, 'processSyncChunk')
      const register = jest.spyOn(writer, 'findOrInsertUser')
      await expect(copy(reader, writer)).rejects.toBeInstanceOf(WERR_NETWORK_CHAIN)
      expect(read).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
      expect(await writer.countUsers({ partial: {} })).toBe(0)
      expect(await writer.countSyncStates({ partial: {} })).toBe(0)
    }
  )

  test.each([undefined, 'invalid'])('does not guess an absent or unrecognized chain: %s', async chain => {
    const reader = await makeStorage()
    const writer = await makeStorage()
    jest.spyOn(reader, 'makeAvailable').mockResolvedValue({ ...reader.getSettings(), chain } as never)
    await expect(copy(reader, writer)).rejects.toBeInstanceOf(WERR_NETWORK_CHAIN)
    expect(await writer.countUsers({ partial: {} })).toBe(0)
    expect(await writer.countSyncStates({ partial: {} })).toBe(0)
  })

  test.each(['returned', 'serialized', 'thrown'] as const)(
    'preserves a %s failure and resumes only from the durable checkpoint',
    async mode => {
      const reader = await makeStorage()
      const writer = await makeStorage()
      const { user } = await reader.findOrInsertUser(identityKey)
      await reader.findOrInsertTxLabel(user.userId, 'retained across failure')
      const settings = reader.getSettings()
      const before = await writer.getSyncCheckpoint({ identityKey }, settings.storageIdentityKey, settings.storageName)
      const original = new WERR_NETWORK_CHAIN('custom provider rejected the page')
      const error = mode === 'serialized' ? JSON.parse(WalletError.unknownToJson(original)) : original
      const process = jest.spyOn(writer, 'processSyncChunk').mockImplementationOnce(async () => {
        if (mode === 'thrown') throw error
        return {
          error,
          done: true,
          inserts: 999,
          updates: 999,
          maxUpdated_at: new Date(),
          nextCheckpoint: { syncStateId: -1 }
        } as ProcessSyncChunkResult
      })
      try {
        await copy(reader, writer)
        throw new Error('sync ignored the provider failure')
      } catch (caught) {
        expect(caught).toBeInstanceOf(WERR_NETWORK_CHAIN)
        expect((caught as Error).message).toBe(original.message)
        if (mode !== 'serialized') expect(caught).toBe(original)
      }
      expect(process).toHaveBeenCalledTimes(1)
      expect(
        await writer.getSyncCheckpoint({ identityKey }, settings.storageIdentityKey, settings.storageName)
      ).toEqual(before)
      expect(await writer.countTxLabels({ partial: {} })).toBe(0)
      process.mockRestore()
      await copy(reader, writer)
      expect(await writer.countTxLabels({ partial: {} })).toBe(1)
      await copy(reader, writer)
      expect(await writer.countTxLabels({ partial: {} })).toBe(1)
    }
  )
})

test('checks all managed chains before registering a user on any store', async () => {
  const active = await makeStorage('main')
  const backup = await makeStorage('test')
  const manager = new WalletStorageManager(identityKey, active, [backup])
  await expect(manager.makeAvailable()).rejects.toBeInstanceOf(WERR_NETWORK_CHAIN)
  expect(await active.countUsers({ partial: {} })).toBe(0)
  expect(await backup.countUsers({ partial: {} })).toBe(0)
})

test('preserves normal errors, rejects malformed returned failures, and retains JSON identity', () => {
  const original = new Error('custom failure')
  expect(() => throwSyncResultError({ error: original } as ProcessSyncChunkResult)).toThrow(original)
  expect(() => throwSyncResultError({ error: 'malformed' } as never)).toThrow(WERR_INTERNAL)
  expect(() => throwSyncResultError({} as ProcessSyncChunkResult)).not.toThrow()
  const encoded = WalletError.unknownToJson(new WERR_NETWORK_CHAIN())
  expect(WalletErrorFromJson(JSON.parse(encoded))).toBeInstanceOf(WERR_NETWORK_CHAIN)
})
