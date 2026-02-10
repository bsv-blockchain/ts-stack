import { Beef, CreateActionArgs, P2PKH, PublicKey, SignActionArgs, WalletLoggerInterface } from '@bsv/sdk'
import { _tu, TestWalletNoSetup, TestWalletOnly } from '../../../../test/utils/TestUtilsWalletStorage'
import { wait } from '../../../utility/utilityHelpers'
import { WalletLogger } from '../../../WalletLogger'
import { StorageServer, WalletStorageServerOptions } from '../StorageServer'
import { StorageClient } from '../StorageClient'
import { WalletError } from '../../../sdk/WalletError'

describe('StorageClient tests', () => {
  jest.setTimeout(99999999)

  let server: { setup: TestWalletNoSetup; server: StorageServer }

  let client: TestWalletOnly

  let logSpy: jest.SpyInstance
  let capturedLogs: string[] = []
  let errorSpy: jest.SpyInstance
  let capturedErrors: string[] = []

  beforeAll(async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '))
    })
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      capturedErrors.push(args.map(String).join(' '))
    })

    server = await createStorageServer()

    client = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: server.setup.rootKey.toHex(),
      endpointUrl: 'http://localhost:8042',
      chain: server.setup.chain
    })
  })

  afterAll(async () => {
    //console.log('All captured logs:', capturedLogs);
    //console.log('All captured errors:', capturedErrors);
    logSpy.mockRestore()
    errorSpy.mockRestore()

    await client.wallet.destroy()
    await server.server.close()
    await server.setup.wallet.destroy()
  })

  test('0 repeatable createAction', async () => {
    const storageClient = client.storage.getActive() as StorageClient
    const u = await storageClient.findOrInsertUser(server.setup.identityKey)
    expect(u).toBeTruthy()
  })

  test('1 repeatable createAction', async () => {
    const wallet = client.wallet
    //wallet.makeLogger = () => console
    wallet.makeLogger = () => new WalletLogger()
    wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
    const root = '02135476'
    const kp = _tu.getKeyPair(root.repeat(8))
    const createArgs: CreateActionArgs = {
      description: `repeatable`,
      outputs: [
        {
          satoshis: 45,
          lockingScript: _tu.getLockP2PKH(kp.address).toHex(),
          outputDescription: 'pay echo'
        }
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: true,
        noSend: true
      }
    }

    const cr = await wallet.createAction(createArgs)
    expect(cr.txid === '4f428a93c43c2d120204ecdc06f7916be8a5f4542cc8839a0fd79bd1b44582f3')
  })

  test('1a error createAction', async () => {
    if (_tu.noEnv('main')) return

    const wallet = client.wallet
    //wallet.makeLogger = () => console
    wallet.makeLogger = () => new WalletLogger()
    wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
    const root = '02135476'
    const kp = _tu.getKeyPair(root.repeat(8))
    const createArgs: CreateActionArgs = {
      description: `error`,
      outputs: [
        {
          satoshis: 45,
          lockingScript: _tu.getLockP2PKH(kp.address).toHex(),
          outputDescription: 'pay echo'
        }
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: true,
        noSend: false,
        acceptDelayedBroadcast: false
      }
    }

    try {
      const cr = await wallet.createAction(createArgs)
      expect(cr.txid === '4f428a93c43c2d120204ecdc06f7916be8a5f4542cc8839a0fd79bd1b44582f3')
    } catch (eu: unknown) {
      const e = WalletError.fromUnknown(eu)
      expect(e.code).toBe('WERR_REVIEW_ACTIONS')
    }
  })
})

async function createStorageServer(): Promise<{ setup: TestWalletNoSetup; server: StorageServer }> {
  const setup = await _tu.createLegacyWalletSQLiteCopy('StorageClientTest')

  const options: WalletStorageServerOptions = {
    port: Number(8042),
    wallet: setup.wallet,
    monetize: false,
    adminIdentityKeys: [],
    calculateRequestPrice: async () => {
      return 0 // Monetize your server here! Price is in satoshis.
    },
    makeLogger: (log?: string | WalletLoggerInterface) => new WalletLogger(log)
  }
  const server = new StorageServer(setup.activeStorage, options)

  server.start()

  return { setup, server }
}