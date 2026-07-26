import { Beef, CreateActionArgs, P2PKH, PublicKey, SignActionArgs, Validation, WalletLoggerInterface } from '@bsv/sdk'
import { _tu, TestWalletNoSetup, TestWalletOnly } from '../../../../test/utils/TestUtilsWalletStorage'
import { verifyOne, wait } from '../../../utility/utilityHelpers'
import { WalletLogger } from '../../../WalletLogger'
import { StorageServer, WalletStorageServerOptions } from '../StorageServer'
import { StorageClient } from '../StorageClient'
import { WalletError } from '../../../sdk/WalletError'
import { actionBatchBlobDigest, actionBatchManifestDigest } from '../../../utility/actionBatchDigest'
import { KnexSessionManager } from '../KnexSessionManager'

describe('StorageClient tests', () => {
  jest.setTimeout(99999999)

  let server: { setup: TestWalletNoSetup, server: StorageServer }

  let client: TestWalletOnly
  let attacker: TestWalletOnly

  let logSpy: jest.SpyInstance
  const capturedLogs: string[] = []
  let errorSpy: jest.SpyInstance
  const capturedErrors: string[] = []

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
    attacker = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: '2'.repeat(64),
      endpointUrl: 'http://localhost:8042',
      chain: server.setup.chain
    })
  })

  afterAll(async () => {
    // console.log('All captured logs:', capturedLogs);
    // console.log('All captured errors:', capturedErrors);
    logSpy.mockRestore()
    errorSpy.mockRestore()

    await attacker.wallet.destroy()
    await client.wallet.destroy()
    await server.server.close()
    await server.setup.wallet.destroy()
  })

  test('0 repeatable createAction', async () => {
    const storageClient = client.storage.getActive() as StorageClient
    const u = await storageClient.findOrInsertUser(server.setup.identityKey)
    expect(u).toBeTruthy()
    expect(capturedLogs.some(line => line.includes('StorageServer POST handler'))).toBe(false)
  })

  test('0a basket reads are scoped to the authenticated remote user', async () => {
    const attackerStorage = attacker.storage.getActive() as StorageClient
    const attackerUser = await server.setup.activeStorage.findUserByIdentityKey(attacker.identityKey)
    expect(attackerUser).toBeDefined()
    expect(attackerUser!.userId).not.toBe(server.setup.userId)

    const baskets = await attacker.storage.findOutputBaskets({ partial: { name: 'default' } })
    expect(baskets.length).toBeGreaterThan(0)
    expect(baskets.every(basket => basket.userId === attackerUser!.userId)).toBe(true)
    expect(baskets.some(basket => basket.userId === server.setup.userId)).toBe(false)

    // Preserve old clients that used the unscoped RPC method name, but bind
    // their claimed auth object to the authenticated identity on the server.
    const legacyBaskets = await Reflect.get(attackerStorage, 'rpcCall').call(
      attackerStorage,
      'findOutputBaskets',
      [
        { identityKey: attacker.identityKey, userId: server.setup.userId },
        { partial: { name: 'default' } }
      ]
    )
    expect(legacyBaskets.every((basket: any) => basket.userId === attackerUser!.userId)).toBe(true)
    expect(legacyBaskets.some((basket: any) => basket.userId === server.setup.userId)).toBe(false)
  })

  test('1 repeatable createAction', async () => {
    const wallet = client.wallet
    // wallet.makeLogger = () => console
    wallet.makeLogger = () => new WalletLogger()
    wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
    const root = '02135476'
    const kp = _tu.getKeyPair(root.repeat(8))
    const createArgs: CreateActionArgs = {
      description: 'repeatable',
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
    expect(cr.txid).toBe('4f428a93c43c2d120204ecdc06f7916be8a5f4542cc8839a0fd79bd1b44582f3')
    const sent = await wallet.createAction({
      description: 'commit repeatable action batch',
      options: { sendWith: [cr.txid!] }
    })
    expect(sent.sendWithResults).toHaveLength(1)
  })

  test('1b authenticated binary action batch blob upload', async () => {
    const firstAction = Validation.validateCreateActionArgs({
      description: 'stage binary action batch blob',
      outputs: [{
        satoshis: 1,
        lockingScript: '51',
        outputDescription: 'binary upload test output'
      }],
      options: { noSend: true }
    })
    const batchId = `binary-${Date.now()}`
    const begun = await client.storage.beginActionBatch({ batchId, firstAction })
    const bytes = Array.from({ length: 64 * 1024 }, (_, index) => index & 0xff)
    const dependencyBeefDigest = actionBatchBlobDigest(bytes)
    const withoutDigest = {
      batchId,
      actions: [],
      dependencyBeefDigest,
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    const prepared = await client.storage.prepareActionBatchCommit(manifest)
    expect(prepared.missingDigests).toEqual([dependencyBeefDigest])

    await client.storage.putActionBatchBlob({ batchId, digest: dependencyBeefDigest, bytes })
    const batch = await server.setup.activeStorage.findActionBatch(server.setup.userId, begun.batchId)
    expect(batch).toBeDefined()
    const blob = await server.setup.activeStorage.findActionBatchBlobRecord(batch!.actionBatchId, dependencyBeefDigest)
    expect(blob?.bytes).toHaveLength(bytes.length)
    await client.storage.abortActionBatch(batchId)
  })

  test('1bb authenticated packed upload accepts authorized compressed repetitive bytes', async () => {
    const firstAction = Validation.validateCreateActionArgs({
      description: 'stage generic packed action batch bytes',
      outputs: [{
        satoshis: 1,
        lockingScript: '51',
        outputDescription: 'packed upload test output'
      }],
      options: { noSend: true }
    })
    const batchId = `packed-${Date.now()}`
    const begun = await client.storage.beginActionBatch({ batchId, firstAction })
    const values = [
      Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 13),
      Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 29)
    ]
    const items = values.map(bytes => ({
      digest: actionBatchBlobDigest(bytes),
      bytes
    }))

    const pack = {
      batchId,
      items,
      maxPackBytes: 8 * 1024 * 1024,
      maxItems: 4096,
      preferredEncodings: ['brotli', 'gzip', 'identity'] as ['brotli', 'gzip', 'identity']
    }
    await expect(client.storage.putActionBatchPack(pack))
      .rejects.toThrow('prepared action batch manifest')
    const logicalBytes = values.flatMap(bytes => Array.from(bytes))
    const dependencyBeefDigest = actionBatchBlobDigest(logicalBytes)
    const withoutDigest = {
      batchId,
      actions: [],
      dependencyBeefDigest,
      blobChunks: { [dependencyBeefDigest]: items.map(item => item.digest) },
      sendWith: [],
      isDelayed: true
    }
    await client.storage.prepareActionBatchCommit({
      ...withoutDigest,
      digest: actionBatchManifestDigest(withoutDigest)
    })
    await client.storage.putActionBatchPack(pack)

    const batch = await server.setup.activeStorage.findActionBatch(server.setup.userId, begun.batchId)
    const stored = await server.setup.activeStorage.findActionBatchBlobRecords(
      batch!.actionBatchId,
      items.map(item => item.digest)
    )
    expect(stored).toHaveLength(items.length)
    expect(stored.map(blob => Array.from(blob.bytes.subarray(0, 64))))
      .toEqual(values.map(bytes => Array.from(bytes.subarray(0, 64))))
    await client.storage.abortActionBatch(batchId)
  })

  test('1bc authenticated packed upload rejects a non-binary request body', async () => {
    const storageClient = client.storage.getActive() as StorageClient
    const authClient = Reflect.get(storageClient, 'authClient')
    const response = await authClient.fetch(
      'http://localhost:8042/action-batch/not-binary/pack',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bytes: [0x41, 0x42, 0x50, 0x31] })
      }
    )

    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toContain('binary action batch body required')
  })

  test('1c batch RPCs are authenticated, user-bound, and restricted to the public protocol', async () => {
    const batchId = `auth-bound-${Date.now()}`
    await client.storage.beginActionBatch({ batchId, firstAction: Validation.validateCreateActionArgs({
      description: 'protect victim action batch',
      outputs: [{
        satoshis: 1,
        lockingScript: '51',
        outputDescription: 'protected batch output'
      }],
      options: { noSend: true }
    }) })

    const unauthenticated = await fetch('http://localhost:8042', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'abortActionBatch',
        params: [{ userId: server.setup.userId, isActive: true }, batchId],
        id: 1
      })
    })
    expect(unauthenticated.status).toBe(401)

    const attackerStorage = attacker.storage.getActive() as StorageClient
    await expect(Reflect.get(attackerStorage, 'rpcCall').call(
      attackerStorage,
      'findActionBatch',
      [server.setup.userId, batchId]
    )).rejects.toThrow('network error 400')

    await expect(attackerStorage.abortActionBatch(
      { userId: server.setup.userId, isActive: true } as any,
      batchId
    )).resolves.toEqual({ aborted: true })
    expect((await server.setup.activeStorage.findActionBatch(server.setup.userId, batchId))?.status).toBe('active')

    const attackerUser = await server.setup.activeStorage.findUserByIdentityKey(attacker.identityKey)
    expect(attackerUser).toBeDefined()
    await server.setup.activeStorage.updateUser(attackerUser!.userId, { activeStorage: 'inactive-storage' })
    await expect(attackerStorage.abortActionBatch(
      { userId: server.setup.userId, isActive: true } as any,
      batchId
    )).rejects.toThrow('authenticated user\'s active storage provider')
    await server.setup.activeStorage.updateUser(attackerUser!.userId, {
      activeStorage: server.setup.activeStorage.getSettings().storageIdentityKey
    })

    await client.storage.abortActionBatch(batchId)
  })

  test('1a error createAction', async () => {
    if (_tu.noEnv('main')) return

    const wallet = client.wallet
    // wallet.makeLogger = () => console
    wallet.makeLogger = () => new WalletLogger()
    wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
    const root = '02135476'
    const kp = _tu.getKeyPair(root.repeat(8))
    const createArgs: CreateActionArgs = {
      description: 'error',
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

  test('2 fragmented-wallet batch funding converges and commits across the remote boundary', async () => {
    const basket = verifyOne(await server.setup.activeStorage.findOutputBaskets({
      partial: { userId: server.setup.userId, name: 'default' }
    }))
    await server.setup.activeStorage.updateOutputBasket(basket.basketId, {
      numberOfDesiredUTXOs: 144,
      minimumDesiredUTXOValue: 40
    })
    server.setup.activeStorage.feeModel = { model: 'sat/kb', value: 100 }

    for (let i = 0; i < 20; i++) {
      await server.setup.wallet.createAction({
        description: `remote fragmentation churn ${i}`,
        outputs: [{
          satoshis: 1,
          lockingScript: '7551',
          outputDescription: 'remote churn output'
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
    }

    const spendable = await server.setup.activeStorage.findOutputs({
      partial: {
        userId: server.setup.userId,
        basketId: basket.basketId,
        change: true,
        spendable: true
      }
    })
    expect(spendable.filter(output => output.satoshis < 100).length).toBeGreaterThanOrEqual(50)
    expect(spendable.some(output => output.satoshis >= 1000)).toBe(true)

    client.wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
    const extend = jest.spyOn(client.storage, 'extendActionBatch')
    const txids: string[] = []
    for (let i = 0; i < 16; i++) {
      const staged = await client.wallet.createAction({
        description: `remote fragmented batch action ${i}`,
        outputs: [{
          satoshis: 1,
          lockingScript: '7551',
          outputDescription: 'remote workload output'
        }],
        options: { noSend: true, randomizeOutputs: false }
      })
      if (staged.txid == null) throw new Error('remote batch action is missing its txid')
      txids.push(staged.txid)
    }
    expect(extend).toHaveBeenCalled()

    const committed = await client.wallet.createAction({
      description: 'commit remote fragmented batch sequence',
      options: { sendWith: txids, acceptDelayedBroadcast: false }
    })
    expect(committed.sendWithResults).toHaveLength(16)
  })
})

async function createStorageServer (): Promise<{ setup: TestWalletNoSetup, server: StorageServer }> {
  const setup = await _tu.createLegacyWalletSQLiteCopy('StorageClientTest')
  _tu.mockPostServicesAsSuccess([setup])
  jest.spyOn(setup.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true } as any)
  jest.spyOn(setup.activeStorage, 'getServices').mockReturnValue(setup.services)

  const options: WalletStorageServerOptions = {
    port: Number(8042),
    wallet: setup.wallet,
    monetize: false,
    logRpcRequests: false,
    sessionManager: new KnexSessionManager(setup.activeStorage.knex),
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
