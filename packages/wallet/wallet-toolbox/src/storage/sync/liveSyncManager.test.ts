import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { WERR_INTERNAL, WERR_NETWORK_CHAIN } from '../../sdk/WERR_errors'

async function makeStorage(chain: 'main' | 'test' = 'test'): Promise<StorageIdb> {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions(chain))
  storage.dbName = `live-sync-${chain}-${randomUUID()}`
  await storage.migrate(`${chain} live sync fixture`, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

describe('WalletStorageManager live sync guards', () => {
  test('throws WERR_NETWORK_CHAIN before any chunk when live-sync chains differ', async () => {
    const reader = await makeStorage('test')
    const writer = await makeStorage('main')
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const manager = new WalletStorageManager(identityKey, reader)
    try {
      await manager.makeAvailable()
      const getChunk = jest.spyOn(reader, 'getSyncChunk')
      const process = jest.spyOn(writer, 'processSyncChunk')
      await expect(manager.syncToWriter({ identityKey }, writer)).rejects.toBeInstanceOf(WERR_NETWORK_CHAIN)
      const restoreManager = new WalletStorageManager(identityKey, writer)
      await restoreManager.makeAvailable()
      await expect(restoreManager.syncFromReader(identityKey, reader)).rejects.toBeInstanceOf(WERR_NETWORK_CHAIN)
      expect(getChunk).not.toHaveBeenCalled()
      expect(process).not.toHaveBeenCalled()
    } finally {
      await reader.destroy()
      await writer.destroy()
      await reader.dropAllData()
      await writer.dropAllData()
    }
  })

  test('throws ProcessSyncChunkResult.error from a custom writer and stops the live-sync loop', async () => {
    const reader = await makeStorage()
    const writer = await makeStorage()
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const manager = new WalletStorageManager(identityKey, reader)
    const customError = new WERR_INTERNAL('custom writer failed')
    try {
      await manager.makeAvailable()
      const process = jest.spyOn(writer, 'processSyncChunk').mockResolvedValue({
        done: false,
        maxUpdated_at: undefined,
        updates: 0,
        inserts: 0,
        error: customError
      })
      await expect(manager.syncToWriter({ identityKey }, writer)).rejects.toBe(customError)
      expect(process).toHaveBeenCalledTimes(1)
    } finally {
      await reader.destroy()
      await writer.destroy()
      await reader.dropAllData()
      await writer.dropAllData()
    }
  })
})
