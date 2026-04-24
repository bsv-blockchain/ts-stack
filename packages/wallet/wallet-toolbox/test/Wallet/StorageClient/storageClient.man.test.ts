/* eslint-disable @typescript-eslint/no-unused-vars */
import { sdk, StorageClient } from '../../../src/index.all'
import { _tu, TestWalletOnly } from '../../utils/TestUtilsWalletStorage'

/**
 * WARNING: This test hangs the commit to master automated test run cycle if included in regular tests...
 */

describe('walletStorageClient test', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const testName = () => expect.getState().currentTestName || 'test'

  const ctxs: TestWalletOnly[] = []

  beforeAll(async () => {
    //_tu.mockPostServicesAsSuccess(ctxs)
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('1 backup to client', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('walletStorageClient1')
    ctxs.push(ctx)
    const { wallet, storage } = ctx

    {
      const client = new StorageClient(wallet, 'https://staging-storage.babbage.systems')
      await storage.addWalletStorageProvider(client)
      await storage.updateBackups()
    }
  })

  test('2 create storage client backup for test wallet', async () => {
    const ctx = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: '1'.repeat(64),
      endpointUrl: 'https://staging-storage.babbage.systems'
    })
    ctxs.push(ctx)
    const { wallet, storage } = ctx

    {
      const auth = await storage.getAuth()
      expect(auth.userId).toBeTruthy()
    }
  })

  test('3 create storage client backup for main wallet', async () => {
    const filePath = process.env.MY_MAIN_FILEPATH
    const identityKey = process.env.MY_MAIN_IDENTITY || ''
    const rootKeyHex = env.devKeys[identityKey]
    expect(filePath && identityKey && rootKeyHex)

    const chain: sdk.Chain = 'main'

    const main = await _tu.createSQLiteTestWallet({
      filePath,
      databaseName: 'tone42',
      chain,
      rootKeyHex
    })
    ctxs.push(main)

    {
      const client = new StorageClient(main.wallet, 'https://storage.babbage.systems')
      await main.storage.addWalletStorageProvider(client)
      await main.storage.updateBackups()
    }
  })
})
