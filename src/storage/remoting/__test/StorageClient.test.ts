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

describe('StorageClient to tagged revision tests', () => {
  jest.setTimeout(99999999)

  test('0 repeatable createAction xyzzy42', async () => {
    if (_tu.noEnv('main')) return
    const env = _tu.getEnv('main')
    const tag = 'v1-0-144'
    const endpointUrl = `https://${tag}---prod-storage-921101068003.us-west1.run.app`
    const s = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: env.devKeys[env.identityKey],
      endpointUrl,
      chain: 'main'
    })

    const testCode = 'xyzzy42'
    const k = s.wallet.keyDeriver.derivePrivateKey([0, testCode], '1', 'self')
    const address = k.toPublicKey().toAddress()
    const p2pkh = new P2PKH()
    const lock = p2pkh.lock(address)

    for (let i = 0; i < 30; i++) {
      const balance = await s.wallet.balance()
      expect(balance).toBeGreaterThan(10000)
      const outputs = await s.wallet.listOutputs({ basket: 'xyzzy42', include: 'entire transactions' })
      if (outputs.totalOutputs === 0) {
        // Create an output in the xyzzy42 basket if it doesn't exist
        const car = await s.wallet.createAction({
          labels: [testCode],
          description: `create ${testCode}`,
          outputs: [
            {
              basket: testCode,
              lockingScript: lock.toHex(),
              satoshis: 1,
              outputDescription: testCode,
              tags: [testCode]
            }
          ],
          options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
          },
        })
        expect(car.txid).toBeTruthy()
        console.log(`Created outpoint: ${car.txid}:0`)
      } else {
        const o = outputs.outputs[0]
        if (o && o.outpoint && outputs.BEEF) {
          // Consume the first output found...
          const unlock = _tu.getUnlockP2PKH(k, o.satoshis)
          const unlockingScriptLength = await unlock.estimateLength()
          // Create an output in the xyzzy42 basket if it doesn't exist
          const cas = await s.wallet.createAction({
            labels: [testCode],
            description: `consume ${testCode}`,
            inputBEEF: outputs.BEEF,
            inputs: [
              {
                unlockingScriptLength,
                outpoint: outputs.outputs[0].outpoint,
                inputDescription: `consume ${testCode}`,
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false
            },
          })
          expect(cas.signableTransaction).toBeTruthy()
          if (cas.signableTransaction) {
            const st = cas.signableTransaction!
            expect(st.reference).toBeTruthy()
            const atomicBeef = Beef.fromBinary(st.tx)
            const tx = atomicBeef.txs[atomicBeef.txs.length - 1].tx!
            tx.inputs[0].unlockingScriptTemplate = unlock
            await tx.sign()
            const unlockingScript = tx.inputs[0].unlockingScript!.toHex()
            const signArgs: SignActionArgs = {
              reference: st.reference,
              spends: { 0: { unlockingScript } },
              options: {
                returnTXIDOnly: true,
                noSend: false,
                acceptDelayedBroadcast: false
              }
            }
            const sr = await s.wallet.signAction(signArgs)
            expect(sr.txid).toBeTruthy()
            console.log(`Consumed outpoint: ${o.outpoint} in ${sr.txid}`)
          }
        }
      }
    }

    await s.wallet.destroy()
  })
})
