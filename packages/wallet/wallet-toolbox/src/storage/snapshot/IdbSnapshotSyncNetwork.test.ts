import 'fake-indexeddb/auto'
import { deleteDB } from 'idb'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { IdbSnapshotSyncJournal } from './IdbSnapshotSyncJournal'
import type { Chain } from '../../sdk/types'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { packedIdbStores } from '../idbPackedFields'

const identityKey = '02' + '11'.repeat(32)
const when = new Date('2026-01-01T00:00:00.000Z')

async function storage(chain: Chain, identity: string): Promise<StorageIdb> {
  const result = new StorageIdb({ ...StorageProvider.createStorageBaseOptions(chain), packed: {} })
  result.dbName = 'packed-network-sync-' + crypto.randomUUID()
  await result.migrate('Packed operational network fixture', identity)
  await result.makeAvailable()
  return result
}

test.each<Chain>(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])(
  'actual packed %s providers copy through the manager and retain committed progress on reopen',
  async chain => {
    const source = await storage(chain, 'source'),
      destination = await storage(chain, 'destination')
    try {
      const { user } = await source.findOrInsertUser(identityKey)
      await source.updateUser(user.userId, { activeStorage: 'source' })
      await source.insertOutputBasket({
        basketId: 0,
        userId: user.userId,
        name: 'operational-network-basket',
        created_at: when,
        updated_at: when,
        isDeleted: false,
        numberOfDesiredUTXOs: 7,
        minimumDesiredUTXOValue: 41
      })
      const manager = new WalletStorageManager(identityKey, source)
      const result = await manager.syncToWriterResumable({ identityKey }, destination, { maxItems: 1 })
      expect(result.status).toBe('completed')
      expect(result.mode).toBe('paged')
      expect(result.snapshotCheckpoint?.done).toBe(true)
      const copied = (await destination.findOutputBaskets({ partial: { name: 'operational-network-basket' } }))[0]
      expect(copied).toMatchObject({
        name: 'operational-network-basket',
        numberOfDesiredUTXOs: 7,
        minimumDesiredUTXOValue: 41
      })
      await destination.destroy()
      const journal = await IdbSnapshotSyncJournal.open(destination)
      expect(await journal.checkpoint(identityKey, 'source')).toEqual(result.snapshotCheckpoint)
      const fresh = new WalletStorageManager(identityKey, destination)
      const pulled = await fresh.syncFromReaderResumable(identityKey, source, { maxItems: 1 })
      expect(pulled).toMatchObject({ status: 'completed', mode: 'paged' })
      expect(await destination.findOutputBaskets({ partial: { name: 'operational-network-basket' } })).toHaveLength(1)
    } finally {
      for (const provider of [source, destination]) {
        await provider.destroy()
        await deleteDB(provider.dbName)
      }
    }
  }
)

test('packed journal rejects a different or unknown source network before registering the user', async () => {
  const destination = await storage('regtest', 'destination')
  try {
    const journal = await IdbSnapshotSyncJournal.open(destination)
    const source = {
      version: 1 as const,
      snapshotId: 'aa'.repeat(32),
      expiresAt: Date.now() + 30000,
      user: { userId: 77, identityKey, activeStorage: 'source', created_at: when, updated_at: when },
      sourceStorage: { ...(await destination.readSettings()), storageIdentityKey: 'source' }
    }
    for (const chain of ['test', 'unknown']) {
      await expect(
        journal.begin({ ...source, sourceStorage: { ...source.sourceStorage, chain: chain as Chain } }, 'source')
      ).rejects.toThrow()
      expect(await destination.findUserByIdentityKey(identityKey)).toBeUndefined()
      const tx = getPackedIdbConnection(destination.db!)!.rawTransaction([], 'readonly')
      expect(await tx.objectStore(packedIdbStores.syncSessions).count()).toBe(0)
      await tx.done
    }
  } finally {
    await destination.destroy()
    await deleteDB(destination.dbName)
  }
})
