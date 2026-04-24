import knex from 'knex'
import { sdk, Setup, StorageKnex, wait } from '../../../src'
import { _tu, logger, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

let done0 = false
const waitFor0 = async () => {
  while (!done0) await wait(100)
}
let done1 = false
const waitFor1 = async () => {
  while (!done1) await wait(100)
}
let done2 = false
const waitFor2 = async () => {
  while (!done2) await wait(100)
}

describe('setActive tests', () => {
  jest.setTimeout(99999999)

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
  const testName = () => expect.getState().currentTestName || 'test'

  beforeEach(async () => {
    const a = await _tu.createSQLiteTestWallet({
      databaseName: `${testName()}_a`,
      chain,
      rootKeyHex,
      dropAll: true
    })
    const b = await _tu.createSQLiteTestWallet({
      databaseName: `${testName()}_b`,
      chain,
      rootKeyHex,
      dropAll: true
    })
    const c = await _tu.createSQLiteTestWallet({
      databaseName: `${testName()}_c`,
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

  test('0 cycle active over three new sqlite wallets', async () => {
    const s = await _tu.createWalletOnly({
      chain,
      rootKeyHex,
      active: store.a,
      backups: [store.b, store.c]
    })
    let first: boolean = true
    for (const active of [storeKey.b, storeKey.c, storeKey.a]) {
      expect(s.storage.isAvailable() === true)
      expect(s.storage.isActiveEnabled === !first)
      const log = await s.storage.setActive(active)
      logger(log)
      expect(s.storage.getActiveStore()).toBe(active)
      expect(s.storage.isActiveEnabled === true)
      first = false
    }
  })

  test.skip('1 setActive on main storage wallet with local backup', async () => {
    const chain: sdk.Chain = 'main'
    if (Setup.noEnv(chain)) return
    const env = _tu.getEnv(chain)
    if (!env.filePath) return

    try {
      const s = await _tu.createTestWallet({
        chain,
        rootKeyHex: env.devKeys[env.identityKey],
        filePath: env.filePath,
        setActiveClient: true,
        addLocalBackup: false,
        useMySQLConnectionForClient: true
      })

      {
        const log = await s.storage.setActive(s.clientStorageIdentityKey!)
        logger(log)
      }
      {
        const log = await s.storage.setActive(s.localStorageIdentityKey!)
        logger(log)
      }
      {
        const log = await s.storage.setActive(s.clientStorageIdentityKey!)
        logger(log)
      }
      expect(s.storage.isActiveEnabled)

      await s.wallet.destroy()
    } finally {
      done1 = true
    }
  })

  test.skip('2 setActive between two local backups', async () => {
    await waitFor1()
    try {
      if (Setup.noEnv('main')) return
      const env = _tu.getEnv('main')
      const s = await _tu.createKnexTestWallet({
        knex: _tu.createLocalSQLite(env.filePath!),
        databaseName: `envFilePath for ${env.identityKey}`,
        chain: env.chain
      })
      const envStorageIdentityKey = s.storage.getActiveStore()
      const filePath = '/Users/tone/Kz/tone42_backup.sqlite'
      const localStore = (
        await _tu.createKnexTestWallet({
          knex: _tu.createLocalSQLite(filePath),
          databaseName: `sqlite for ${env.identityKey}`,
          chain: env.chain
        })
      ).activeStorage
      await s.storage.addWalletStorageProvider(localStore)
      {
        const log = await s.storage.setActive(envStorageIdentityKey)
        logger(log)
      }
      {
        const log = await s.storage.setActive(localStore._settings!.storageIdentityKey)
        logger(log)
      }
      {
        const log = await s.storage.setActive(envStorageIdentityKey)
        logger(log)
      }
      expect(s.storage.isActiveEnabled)
      await s.wallet.destroy()
    } finally {
      done2 = true
    }
  })

  test.skip('3 compare wallet balances', async () => {
    await waitFor2()
    const chain: sdk.Chain = 'test'
    if (Setup.noEnv(chain)) return

    const s = await _tu.createTestWallet(chain)

    await s.wallet.destroy()
  })
})
