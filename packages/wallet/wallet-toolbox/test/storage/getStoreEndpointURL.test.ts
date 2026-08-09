/**
 * getStoreEndpointURL / getStores().endpointURL must survive production
 * minification. Class names are rewritten, so constructor.name is not stable.
 */
import { WalletStorageManager } from '../../src/storage/WalletStorageManager'
import { StorageClient as RemoteStorageClient } from '../../src/storage/remoting/StorageClient'
import { StorageClient as MobileStorageClient } from '../../src/storage/remoting/StorageMobile'
import type { WalletInterface } from '@bsv/sdk'

type ManagedStore = NonNullable<WalletStorageManager['_active']>

const wallet = {} as WalletInterface

function provider(properties: Record<string, unknown>): ManagedStore['storage'] {
  return properties as unknown as ManagedStore['storage']
}

function managedStore(storage: ManagedStore['storage'], storageIdentityKey = 'store-key'): ManagedStore {
  return {
    isAvailable: true,
    isStorageProvider: false,
    settings: {
      storageIdentityKey,
      storageName: 'test_store',
      chain: 'test',
      dbName: 'test',
      storageSchemaVersion: 1,
      maxOutputScript: 0
    },
    user: {
      userId: 1,
      identityKey: '02' + '11'.repeat(32),
      activeStorage: storageIdentityKey
    },
    storage
  } as ManagedStore
}

describe('WalletStorageManager.getStoreEndpointURL', () => {
  it.each([
    new RemoteStorageClient(wallet, 'https://store-us-1.bsvb.tech'),
    new MobileStorageClient(wallet, 'https://store-us-1.bsvb.tech')
  ])('returns endpointUrl for remote storage client variant %#', storage => {
    const manager = new WalletStorageManager('identity')
    const store = managedStore(storage)
    expect(manager.getStoreEndpointURL(store)).toBe('https://store-us-1.bsvb.tech')
  })

  it('returns endpointUrl when constructor.name is minified (not StorageClient)', () => {
    // Vite/esbuild minify renames classes to single-letter identifiers.
    class a extends RemoteStorageClient {}
    const storage = new a(wallet, 'https://store-us-1.bsvb.tech/')
    expect(storage.constructor.name).not.toBe('StorageClient')

    const manager = new WalletStorageManager('identity')
    const store = managedStore(storage)
    expect(manager.getStoreEndpointURL(store)).toBe('https://store-us-1.bsvb.tech/')
  })

  it('returns undefined for local providers without endpointUrl', () => {
    const manager = new WalletStorageManager('identity')
    expect(manager.getStoreEndpointURL(managedStore(provider({})))).toBeUndefined()
  })

  it('returns undefined for empty endpointUrl strings', () => {
    const manager = new WalletStorageManager('identity')
    expect(manager.getStoreEndpointURL(managedStore(provider({ endpointUrl: '' })))).toBeUndefined()
  })

  it('exposes endpointURL via getStores even when class name is mangled', () => {
    class a extends RemoteStorageClient {}

    const manager = new WalletStorageManager('identity')
    // Bypass makeAvailable: populate partitions the same way makeAvailable would.
    manager._isAvailable = true
    manager._active = managedStore(provider({}), 'local-key')
    manager._backups = [managedStore(new a(wallet, 'https://store-us-1.bsvb.tech'), 'remote-key')]
    manager._conflictingActives = []

    const stores = manager.getStores()
    expect(stores).toHaveLength(2)

    const local = stores.find(s => s.storageIdentityKey === 'local-key')
    const remote = stores.find(s => s.storageIdentityKey === 'remote-key')
    expect(local?.endpointURL).toBeUndefined()
    expect(remote?.endpointURL).toBe('https://store-us-1.bsvb.tech')
    expect(remote?.isBackup).toBe(true)
  })
})
