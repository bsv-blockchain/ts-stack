import { StorageKnex } from '../../../src'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('setActive deterministic storage switching', () => {
  const env = _tu.getEnv('test')
  const chain = env.chain
  const rootKeyHex = env.devKeys[env.identityKey]
  let setup: {
    a: TestWalletNoSetup
    b: TestWalletNoSetup
    c: TestWalletNoSetup
  }
  let store: { a: StorageKnex; b: StorageKnex; c: StorageKnex }
  let storeKey: { a: string; b: string; c: string }

  beforeEach(async () => {
    const testName = expect.getState().currentTestName ?? 'setActive'
    const a = await _tu.createSQLiteTestWallet({
      databaseName: `${testName}_a`,
      chain,
      rootKeyHex,
      dropAll: true
    })
    const b = await _tu.createSQLiteTestWallet({
      databaseName: `${testName}_b`,
      chain,
      rootKeyHex,
      dropAll: true
    })
    const c = await _tu.createSQLiteTestWallet({
      databaseName: `${testName}_c`,
      chain,
      rootKeyHex,
      dropAll: true
    })
    setup = { a, b, c }
    store = { a: a.activeStorage, b: b.activeStorage, c: c.activeStorage }
    storeKey = {
      a: store.a._settings!.storageIdentityKey,
      b: store.b._settings!.storageIdentityKey,
      c: store.c._settings!.storageIdentityKey
    }
  })

  afterEach(async () => {
    await setup.a.wallet.destroy()
    await setup.b.wallet.destroy()
    await setup.c.wallet.destroy()
  })

  test('cycles the active provider over three new SQLite wallets', async () => {
    const walletOnly = await _tu.createWalletOnly({
      chain,
      rootKeyHex,
      active: store.a,
      backups: [store.b, store.c]
    })

    try {
      expect(walletOnly.storage.isAvailable()).toBe(true)
      expect(walletOnly.storage.isActiveEnabled).toBe(false)

      for (const active of [storeKey.b, storeKey.c, storeKey.a]) {
        await walletOnly.storage.setActive(active)
        expect(walletOnly.storage.getActiveStore()).toBe(active)
        expect(walletOnly.storage.isActiveEnabled).toBe(true)
      }
    } finally {
      await walletOnly.wallet.destroy()
    }
  })
})
