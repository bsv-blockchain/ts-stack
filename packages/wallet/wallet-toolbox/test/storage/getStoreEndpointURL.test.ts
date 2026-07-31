/**
 * getStoreEndpointURL / getStores().endpointURL must survive production
 * minification. Class names are rewritten, so constructor.name is not stable.
 */
import { WalletStorageManager } from '../../src/storage/WalletStorageManager'

function managedStore(storage: object, storageIdentityKey = 'store-key') {
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
  } as any
}

describe('WalletStorageManager.getStoreEndpointURL', () => {
  it('returns endpointUrl for a StorageClient-shaped provider', () => {
    class StorageClient {
      endpointUrl = 'https://store-us-1.bsvb.tech'
    }
    const manager = new WalletStorageManager('identity')
    const store = managedStore(new StorageClient())
    expect(manager.getStoreEndpointURL(store)).toBe('https://store-us-1.bsvb.tech')
  })

  it('returns endpointUrl when constructor.name is minified (not StorageClient)', () => {
    // Vite/esbuild minify renames classes to single-letter identifiers.
    class a {
      endpointUrl = 'https://store-us-1.bsvb.tech/'
    }
    expect(new a().constructor.name).not.toBe('StorageClient')

    const manager = new WalletStorageManager('identity')
    const store = managedStore(new a())
    expect(manager.getStoreEndpointURL(store)).toBe('https://store-us-1.bsvb.tech/')
  })

  it('returns undefined for local providers without endpointUrl', () => {
    class StorageKnex {}
    const manager = new WalletStorageManager('identity')
    expect(manager.getStoreEndpointURL(managedStore(new StorageKnex()))).toBeUndefined()
  })

  it('returns undefined for empty endpointUrl strings', () => {
    const manager = new WalletStorageManager('identity')
    expect(manager.getStoreEndpointURL(managedStore({ endpointUrl: '' }))).toBeUndefined()
  })

  it('exposes endpointURL via getStores even when class name is mangled', () => {
    class a {
      endpointUrl = 'https://store-us-1.bsvb.tech'
    }
    class LocalStore {}

    const manager = new WalletStorageManager('identity')
    // Bypass makeAvailable: populate partitions the same way makeAvailable would.
    ;(manager as any)._isAvailable = true
    ;(manager as any)._active = managedStore(new LocalStore(), 'local-key')
    ;(manager as any)._backups = [managedStore(new a(), 'remote-key')]
    ;(manager as any)._conflictingActives = []

    const stores = manager.getStores()
    expect(stores).toHaveLength(2)

    const local = stores.find(s => s.storageIdentityKey === 'local-key')
    const remote = stores.find(s => s.storageIdentityKey === 'remote-key')
    expect(local?.endpointURL).toBeUndefined()
    expect(remote?.endpointURL).toBe('https://store-us-1.bsvb.tech')
    expect(remote?.isBackup).toBe(true)
  })
})
