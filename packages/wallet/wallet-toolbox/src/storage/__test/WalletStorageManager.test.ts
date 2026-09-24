import * as bsv from '@bsv/sdk'
import { wait } from '../..'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageProvider } from '../StorageProvider'
import { StorageReaderWriter } from '../StorageReaderWriter'
import { TableProvenTx } from '../schema/tables'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'

import * as dotenv from 'dotenv'

function canonicalReproof(ctx: TestWalletNoSetup, ptx: TableProvenTx) {
  const merklePath = new bsv.MerklePath(ptx.height + 1, [[{ offset: 0, hash: ptx.txid, txid: true }]])
  const header = toBinaryBaseBlockHeader({
    version: 1,
    previousHash: '0'.repeat(64),
    merkleRoot: merklePath.computeRoot(ptx.txid),
    time: 0,
    bits: 0,
    nonce: 0
  })
  const services = ctx.storage.getServices()
  const isValidRootForHeight = jest.fn(async () => true)
  jest.spyOn(services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight } as bsv.ChainTracker)
  jest.spyOn(services, 'getHeaderForHeight').mockResolvedValue(header)
  const lookup = jest.spyOn(services, 'getValidatedMerklePath').mockImplementation(async (_txid, validate) => {
    const result = { name: 'canonical reproof fixture', merklePath }
    await validate(result)
    return result
  })
  return { lookup, isValidRootForHeight, height: merklePath.blockHeight, blockHash: asString(doubleSha256BE(header)) }
}

dotenv.config()
describe('WalletStorageManager tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnvFlags('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('walletStorageManagerTestSource', 'legacy'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('walletStorageManagerTestSource', 'legacy'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  const root = '02135476'
  const kp = _tu.getKeyPair(root.repeat(8))
  const fredsAddress = kp.address

  test('BRC-177 storage entry points fail closed when authority or persistence support is absent', async () => {
    const { activeStorage: provider, storage: manager } = ctxs[0]
    const inactive = { userId: 1, isActive: false }
    const active = { userId: 1, isActive: true }

    await expect(provider.prepareNoSendExpiry(inactive, {} as any)).rejects.toThrow('active storage provider')
    await expect(provider.activateNoSendExpiry(inactive, {} as any)).rejects.toThrow('active storage provider')
    await expect(provider.armNoSendExpiry(inactive, {} as any)).rejects.toThrow('active storage provider')

    expect((StorageProvider.prototype as any).supportsNoSendExpiryPersistence.call(provider)).toBe(false)
    await expect(
      StorageReaderWriter.prototype.compareAndSetNoSendExpiryState.call(manager, 1, 'signed', 'reclaiming')
    ).rejects.toThrow('BRC-177 atomic lifecycle persistence')

    const persistence = jest.spyOn(provider as any, 'supportsNoSendExpiryPersistence').mockReturnValue(false)
    try {
      expect(await provider.getCapabilities()).not.toHaveProperty('brc177NoSendExpiry')
      await expect(provider.prepareNoSendExpiry(active, {} as any)).rejects.toThrow('atomic lifecycle persistence')
      await expect(provider.activateNoSendExpiry(active, {} as any)).rejects.toThrow('atomic lifecycle persistence')
      await expect(provider.armNoSendExpiry(active, {} as any)).rejects.toThrow('atomic lifecycle persistence')
    } finally {
      persistence.mockRestore()
    }

    const writer = jest.spyOn(manager, 'runAsWriter').mockImplementation(async callback => await callback({} as any))
    try {
      await expect(manager.prepareNoSendExpiry({} as any)).rejects.toThrow('does not support BRC-177')
      await expect(manager.activateNoSendExpiry({} as any)).rejects.toThrow('does not support BRC-177')
      await expect(manager.armNoSendExpiry({} as any)).rejects.toThrow('does not support BRC-177')
    } finally {
      writer.mockRestore()
    }
  })

  test.each(['runAsReader', 'runAsWriter', 'runAsStorageProvider'] as const)(
    '%s returns a rejection for synchronous callback errors and releases ownership',
    async method => {
      for (const { storage } of ctxs) {
        const failure = new Error('synchronous callback failure')
        const operation = storage[method](() => {
          throw failure
        })
        expect(operation).toBeInstanceOf(Promise)
        await expect(operation).rejects.toBe(failure)
        await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
      }
    }
  )

  test.each(['runAsReader', 'runAsWriter', 'runAsStorageProvider'] as const)(
    '%s holds ownership through asynchronous rejection, then releases the waiting writer',
    async method => {
      for (const { storage } of ctxs) {
        let reject!: (error: Error) => void
        let entered!: () => void
        const started = new Promise<void>(resolve => {
          entered = resolve
        })
        const pending = new Promise<void>((_resolve, fail) => {
          reject = fail
        })
        const operation = storage[method](() => {
          entered()
          return pending
        })
        await started
        const next = jest.fn(async () => 'next writer')
        const waiting = storage.runAsWriter(next)
        await Promise.resolve()
        expect(next).not.toHaveBeenCalled()
        const failure = new Error('asynchronous callback failure')
        const rejected = expect(operation).rejects.toBe(failure)
        reject(failure)
        await rejected
        await expect(waiting).resolves.toBe('next writer')
        expect(next).toHaveBeenCalledTimes(1)
      }
    }
  )

  test.each(['migrate', 'getCapabilities', 'findProvenTxReqs'] as const)(
    '%s preserves synchronous provider failures as rejected promises and releases ownership',
    async method => {
      const { storage } = ctxs[0]
      const failure = new Error('provider failed synchronously')
      const dispatch = jest.spyOn(storage.getActive(), method).mockImplementation(() => {
        throw failure
      })
      try {
        const args = method === 'migrate' ? ['name', 'identity'] : method === 'getCapabilities' ? [] : [{}]
        const operation = Reflect.get(storage, method).apply(storage, args)
        expect(operation).toBeInstanceOf(Promise)
        await expect(operation).rejects.toBe(failure)
        expect(dispatch).toHaveBeenCalledTimes(1)
        await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
      } finally {
        dispatch.mockRestore()
      }
    }
  )

  test('writer authorization failure never dispatches and releases the next writer', async () => {
    for (const { storage } of ctxs) {
      const failure = new Error('authorization unavailable')
      const auth = jest.spyOn(storage, 'getAuth').mockRejectedValueOnce(failure)
      const dispatch = jest.spyOn(storage.getActive(), 'createAction')
      try {
        await expect(storage.createAction({} as any)).rejects.toBe(failure)
        expect(auth).toHaveBeenCalledWith(true)
        expect(dispatch).not.toHaveBeenCalled()
        await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
      } finally {
        auth.mockRestore()
        dispatch.mockRestore()
      }
    }
  })

  test('writer authorization is evaluated only after the preceding writer releases ownership', async () => {
    const { storage } = ctxs[0]
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = storage.runAsWriter(async () => {
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    await started
    const auth = jest.spyOn(storage, 'getAuth')
    const failure = new Error('provider refused action')
    const dispatch = jest.spyOn(storage.getActive(), 'createAction').mockImplementation(() => {
      throw failure
    })
    try {
      const action = storage.createAction({} as any)
      const rejected = expect(action).rejects.toBe(failure)
      await Promise.resolve()
      expect(auth).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      release()
      await held
      await rejected
      expect(auth).toHaveBeenCalledWith(true)
      expect(dispatch).toHaveBeenCalledTimes(1)
      await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
    } finally {
      release()
      await held
      auth.mockRestore()
      dispatch.mockRestore()
    }
  })

  test('reader authorization still precedes queue admission while provider work waits for ownership', async () => {
    const { storage } = ctxs[0]
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = storage.runAsWriter(async () => {
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    await started
    const auth = jest.spyOn(storage, 'getAuth')
    const failure = new Error('reader provider refused request')
    const dispatch = jest.spyOn(storage.getActive(), 'findOutputsAuth').mockImplementation(() => {
      throw failure
    })
    try {
      const result = storage.findOutputs({} as any)
      const rejected = expect(result).rejects.toBe(failure)
      expect(auth).toHaveBeenCalledWith()
      await Promise.resolve()
      expect(dispatch).not.toHaveBeenCalled()
      release()
      await held
      await rejected
      expect(dispatch).toHaveBeenCalledTimes(1)
      await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
    } finally {
      release()
      await held
      auth.mockRestore()
      dispatch.mockRestore()
    }
  })

  test('reader authorization rejection never dispatches provider work', async () => {
    const { storage } = ctxs[0]
    const failure = new Error('reader authorization unavailable')
    const auth = jest.spyOn(storage, 'getAuth').mockRejectedValueOnce(failure)
    const dispatch = jest.spyOn(storage.getActive(), 'findOutputsAuth')
    try {
      const result = storage.findOutputs({} as any)
      expect(result).toBeInstanceOf(Promise)
      await expect(result).rejects.toBe(failure)
      expect(dispatch).not.toHaveBeenCalled()
      await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
    } finally {
      auth.mockRestore()
      dispatch.mockRestore()
    }
  })

  test('borrowed sync callback throws remain asynchronous rejections', async () => {
    const { storage } = ctxs[0]
    const failure = new Error('borrowed callback failed')
    const operation = storage.runAsSync(() => {
      throw failure
    }, storage.getActive())
    expect(operation).toBeInstanceOf(Promise)
    await expect(operation).rejects.toBe(failure)
    await expect(storage.runAsWriter(async () => 'next writer')).resolves.toBe('next writer')
  })

  test('1_runAsReader runAsWriter runAsSync interlock correctly', async () => {
    const { storage } = await _tu.createSQLiteTestSetup1Wallet({
      databaseName: 'syncTest1'
    })

    interface Result {
      i: number
      t: 'reader' | 'writer' | 'sync'
      start: number
      end: number
    }
    const result: Result[] = []
    const promises: Array<Promise<Result>> = []

    const now = Date.now()

    const makeReader = (i: number, duration: number): void => {
      promises.push(
        storage.runAsReader(async _reader => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'reader', i }
          result.push(r)
          return r
        })
      )
    }

    const makeWriter = (i: number, duration: number): void => {
      promises.push(
        storage.runAsWriter(async _sync => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'writer', i }
          result.push(r)
          return r
        })
      )
    }

    const makeSync = (i: number, duration: number): void => {
      promises.push(
        storage.runAsSync(async _sync => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'sync', i }
          result.push(r)
          return r
        })
      )
    }

    let i = 0
    for (let j = 0; j < 5; j++) makeReader(i++, 10 + j * 10)
    makeSync(i++, 5000)
    for (let j = 0; j < 5; j++) {
      makeReader(i++, 10 + j * 10)
      makeWriter(i++, 30 + j * 500)
    }
    makeSync(i++, 5000)
    for (let j = 0; j < 5; j++) makeReader(i++, 10 + j * 10)

    await Promise.all(promises)
    expect(result).toBeTruthy()

    let log = ''
    for (const r of result) {
      const overlaps = result.filter(
        r2 => r2.i != r.i && (r2.t != 'reader' || r.t != 'reader') && r.start > r2.start && r.start < r2.end
      )
      if (overlaps.length > 0) {
        log += `${r.i} ${r.t} ${r.start} overlaps:\n`
        for (const o of overlaps) log += `  ${o.i} ${o.t} ${o.start} ${o.end}\n`
      }
    }

    if (log.length > 0) {
      console.log(log)
      expect(log).toHaveLength(0)
    }

    await storage.destroy()
  })

  test('1a_runAsReader runAsWriter runAsSync interlock correctly with low durations', async () => {
    const { storage } = await _tu.createSQLiteTestSetup1Wallet({
      databaseName: 'syncTest1a'
    })

    interface Result {
      i: number
      t: 'reader' | 'writer' | 'sync'
      start: number
      end: number
    }
    const result: Result[] = []
    const promises: Array<Promise<Result>> = []

    const now = Date.now()

    const makeReader = (i: number, duration: number): void => {
      promises.push(
        storage.runAsReader(async _reader => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'reader', i }
          result.push(r)
          return r
        })
      )
    }

    const makeWriter = (i: number, duration: number): void => {
      promises.push(
        storage.runAsWriter(async _sync => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'writer', i }
          result.push(r)
          return r
        })
      )
    }

    const makeSync = (i: number, duration: number): void => {
      promises.push(
        storage.runAsSync(async _sync => {
          const start = Date.now() - now
          await wait(duration)
          const end = Date.now() - now
          const r: Result = { start, end, t: 'sync', i }
          result.push(r)
          return r
        })
      )
    }

    let i = 0
    for (let j = 0; j < 5; j++) makeReader(i++, j)
    makeSync(i++, 5000)
    for (let j = 0; j < 5; j++) {
      makeReader(i++, j)
      makeWriter(i++, j)
    }
    makeSync(i++, 5000)
    for (let j = 0; j < 5; j++) makeReader(i++, j)

    await Promise.all(promises)
    expect(result).toBeTruthy()

    let log = ''
    for (const r of result) {
      const overlaps = result.filter(
        r2 => r2.i != r.i && (r2.t != 'reader' || r.t != 'reader') && r.start > r2.start && r.start < r2.end
      )
      if (overlaps.length > 0) {
        log += `${r.i} ${r.t} ${r.start} overlaps:\n`
        for (const o of overlaps) log += `  ${o.i} ${o.t} ${o.start} ${o.end}\n`
      }
    }

    if (log.length > 0) {
      console.log(log)
      expect(log).toHaveLength(0)
    }

    await storage.destroy()
  })

  test('2_internalizes concurrent AtomicBEEF payments within the supported batch', async () => {
    for (const { wallet } of ctxs) {
      const fred = await _tu.createSQLiteTestWallet({
        chain: 'test',
        databaseName: 'syncTest2Fred',
        rootKeyHex: '2'.repeat(64),
        dropAll: true
      })
      // Keep this concurrency test independent of public chaintracks availability.
      // AtomicBEEF proof validity is covered separately; this case verifies that
      // parallel internalization stays within the supported writer batch.
      const getChainTracker = jest.fn(async () => ({
        isValidRootForHeight: async (_root: string, _height: number) => true
      }))
      fred.services.getChainTracker = getChainTracker
      const promises: Array<Promise<number>> = []
      const result: Array<{ i: number; r: any }> = []
      const crs1: bsv.CreateActionResult[] = []
      const maxI = 6

      const makeWriter2 = async (
        fred: TestWalletNoSetup,
        cr: bsv.CreateActionResult,
        i: number,
        result: Array<{ i: number; r: any }>
      ): Promise<number> => {
        logger(`writer${i}`)
        const internalizeArgs: bsv.InternalizeActionArgs = {
          tx: cr.tx!,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'payments',
                customInstructions: JSON.stringify({ root, repeat: 8 }),
                tags: ['test', 'again']
              }
            }
          ],
          description: `paid ${i}`
        }
        const r = await fred.wallet.internalizeAction(internalizeArgs)
        expect(r.accepted).toBe(true)
        result.push({ r, i })
        return i
      }

      for (let i = 0; i < maxI; i++) {
        const createArgs: bsv.CreateActionArgs = {
          description: `${kp.address} of ${root}`,
          outputs: [
            {
              satoshis: 1,
              lockingScript: _tu.getLockP2PKH(fredsAddress).toHex(),
              outputDescription: 'pay fred'
            }
          ],
          options: {
            returnTXIDOnly: false,
            randomizeOutputs: false,
            signAndProcess: true,
            noSend: true
          }
        }
        const cr = await wallet.createAction(createArgs)
        expect(cr.tx).toBeTruthy()
        crs1.push(cr)
      }
      let j = 0
      for (let i = 0; i < maxI; i++) promises.push(makeWriter2(fred, crs1[j++], i, result))
      await Promise.all(promises)
      expect(result).toHaveLength(maxI)
      expect(getChainTracker).toHaveBeenCalled()
      await fred.wallet.destroy()
    }
  })

  test('3_internalize same-wallet payment while transaction is sending', async () => {
    for (const { wallet, activeStorage, identityKey, userId } of ctxs) {
      const outputSatoshis = 5
      const derivationPrefix = Buffer.from('same-wallet-invoice').toString('base64')
      const derivationSuffix = Buffer.from('utxo-0').toString('base64')
      const brc29ProtocolID: bsv.WalletProtocol = [2, '3241645161d8']
      const derivedPublicKey = wallet.keyDeriver.derivePublicKey(
        brc29ProtocolID,
        `${derivationPrefix} ${derivationSuffix}`,
        identityKey
      )

      const cr = await wallet.createAction({
        description: 'same-wallet payment pending send',
        outputs: [
          {
            satoshis: outputSatoshis,
            lockingScript: new bsv.P2PKH().lock(derivedPublicKey.toAddress()).toHex(),
            outputDescription: 'pay same wallet'
          }
        ],
        options: {
          returnTXIDOnly: false,
          randomizeOutputs: false,
          signAndProcess: true,
          noSend: true
        }
      })
      expect(cr.tx).toBeTruthy()
      expect(cr.txid).toBeTruthy()
      if (cr.tx == null || cr.txid == null) throw new Error('createAction did not return a signed transaction')

      const existingTx = (
        await activeStorage.findTransactions({
          partial: { userId, txid: cr.txid }
        })
      )[0]
      expect(existingTx).toBeTruthy()
      await activeStorage.updateTransaction(existingTx.transactionId, { status: 'sending' })

      // Mock chaintracker responses for AtomicBEEF validation to avoid flakiness from
      // live chaintracks endpoints. This test exercises the 'sending' merge path for a
      // same-wallet internalize before monitor completion; it is not testing proof validity
      // (createAction + other tests cover BEEF construction/validation).
      activeStorage.setServices({
        getChainTracker: async () => ({
          isValidRootForHeight: async (_root: string, _height: number) => true
        })
      } as any)

      const ir = await activeStorage.internalizeAction(
        { userId, identityKey },
        {
          tx: cr.tx,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix,
                derivationSuffix,
                senderIdentityKey: identityKey
              }
            }
          ],
          description: 'received same-wallet payment before monitor completion'
        }
      )

      expect(ir.accepted).toBe(true)
      expect(ir.isMerge).toBe(true)

      const updatedTx = (
        await activeStorage.findTransactions({
          partial: { transactionId: existingTx.transactionId }
        })
      )[0]
      expect(updatedTx.status).toBe('sending')
    }
  })

  test('4_processAction prepares newly created managed change after returning', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefProcessAction', 'legacy')
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as bsv.ChainTracker)
    const persist = jest.spyOn(ctx.activeStorage, 'upsertPreparedBeef')
    try {
      const result = await ctx.wallet.createAction({
        description: 'prepare managed change with the real COOK worker',
        outputs: [
          {
            satoshis: 1,
            lockingScript: '51',
            outputDescription: 'prepared BEEF processAction test'
          }
        ],
        options: {
          noSend: true,
          randomizeOutputs: false,
          returnTXIDOnly: true,
          signAndProcess: true
        }
      })

      expect(result.txid).toBeTruthy()
      expect(persist).not.toHaveBeenCalled()

      await ctx.activeStorage.waitForPreparedBeefTasks()

      await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [result.txid!])).resolves.toEqual([
        expect.objectContaining({ rootTxid: result.txid, state: 'ready' })
      ])
      await expect(ctx.activeStorage.lookupPreparedBeefs(ctx.userId, [result.txid!])).resolves.toMatchObject({
        hitTxids: [result.txid],
        missingTxids: []
      })
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('4a_processAction remains compatible when the optional COOK queue is absent', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefLegacyProcessAction', 'legacy')
    ctx.activeStorage.preparedBeefPolicy.writeEnabled = true
    Object.defineProperty(ctx.activeStorage, 'enqueuePreparedBeef', {
      configurable: true,
      value: undefined
    })
    try {
      const result = await ctx.wallet.createAction({
        description: 'process action without a prepared BEEF queue',
        outputs: [
          {
            satoshis: 1,
            lockingScript: '51',
            outputDescription: 'legacy prepared BEEF provider test'
          }
        ],
        options: {
          noSend: true,
          randomizeOutputs: false,
          returnTXIDOnly: true,
          signAndProcess: true
        }
      })

      expect(result.txid).toBeTruthy()
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5_reproof updates advance the prepared-BEEF proof epoch atomically', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefReproofEpoch', 'legacy')
    try {
      const [ptx] = await ctx.activeStorage.findProvenTxs({ partial: {} })
      expect(ptx).toBeTruthy()
      const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()
      const { lookup } = canonicalReproof(ctx, ptx)

      const result = await ctx.storage.reproveHeader(ptx.blockHash)

      expect(lookup).toHaveBeenCalled()
      expect(result.updated.length).toBeGreaterThan(0)
      await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5a_reorg fencing closes prepared reads before asynchronous invalidation completes', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefImmediateReorgEpoch', 'legacy')
    try {
      ctx.activeStorage.preparedBeefPolicy.readEnabled = true
      const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()

      const invalidation = ctx.storage.invalidatePreparedBeefsForReorg()

      expect(ctx.activeStorage.preparedBeefReadsEnabled()).toBe(false)
      await invalidation
      expect(ctx.activeStorage.preparedBeefReadsEnabled()).toBe(true)
      await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5b_failed reorg invalidation leaves prepared reads closed', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefFailedReorgEpoch', 'legacy')
    try {
      ctx.activeStorage.preparedBeefPolicy.readEnabled = true
      jest.spyOn(ctx.activeStorage, 'invalidatePreparedBeefs').mockRejectedValueOnce(new Error('database unavailable'))

      const invalidation = ctx.storage.invalidatePreparedBeefsForReorg()

      expect(ctx.activeStorage.preparedBeefReadsEnabled()).toBe(false)
      await expect(invalidation).rejects.toThrow('database unavailable')
      expect(ctx.activeStorage.preparedBeefReadsEnabled()).toBe(false)

      // A later successful invalidation covers the failed generation and is
      // the explicit recovery path; a process restart is not required.
      await ctx.storage.invalidatePreparedBeefsForReorg()
      expect(ctx.activeStorage.preparedBeefReadsEnabled()).toBe(true)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5c_reorg invalidates prepared BEEF while replacement proofs are unavailable', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefUnavailableReproofEpoch', 'legacy')
    try {
      const [ptx] = await ctx.activeStorage.findProvenTxs({ partial: {} })
      expect(ptx).toBeTruthy()
      const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()
      const { lookup } = canonicalReproof(ctx, ptx)
      lookup.mockRejectedValue(new Error('proof unavailable'))

      const result = await ctx.storage.reproveHeader(ptx.blockHash)

      expect(result.updated).toHaveLength(0)
      expect(result.unavailable).toHaveLength(1)
      await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5d_height reproof updates proofs and invalidates prepared BEEF atomically', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefHeightReproofEpoch', 'legacy')
    try {
      const [ptx] = await ctx.activeStorage.findProvenTxs({ partial: {} })
      expect(ptx).toBeTruthy()
      const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()
      const { lookup } = canonicalReproof(ctx, ptx)

      const result = await ctx.storage.reproveHeightMerkleRoot(ptx.height, ptx.merkleRoot)

      expect(lookup).toHaveBeenCalledWith(ptx.txid, expect.any(Function))
      expect(result.updated).toHaveLength(1)
      expect(result.log).toContain('proof data updated')
      await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)

      await expect(ctx.storage.reproveHeightMerkleRoot(-1, '0'.repeat(64))).resolves.toMatchObject({
        updated: [],
        unchanged: [],
        unavailable: []
      })
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('5e_direct reproof persists the replacement proof and invalidates prepared BEEF', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('preparedBeefDirectReproofEpoch', 'legacy')
    try {
      const [ptx] = await ctx.activeStorage.findProvenTxs({ partial: {} })
      expect(ptx).toBeTruthy()
      const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()
      const { height: replacementHeight, blockHash: replacementHash, isValidRootForHeight } = canonicalReproof(ctx, ptx)
      isValidRootForHeight.mockResolvedValue('true' as unknown as boolean)

      const rejected = await ctx.storage.reproveProven(ptx)
      expect(rejected).toMatchObject({ unavailable: true, updated: undefined })

      isValidRootForHeight.mockResolvedValue(true)
      const result = await ctx.storage.reproveProven(ptx)

      expect(result.updated?.update).toMatchObject({
        height: replacementHeight,
        blockHash: replacementHash
      })
      expect(result.log).toContain('proof data updated')
      await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)
      await expect(
        ctx.activeStorage.findProvenTxs({
          partial: { provenTxId: ptx.provenTxId }
        })
      ).resolves.toEqual([expect.objectContaining({ height: replacementHeight, blockHash: replacementHash })])
    } finally {
      await ctx.wallet.destroy()
    }
  })
})
function logger(s: string) {
  process.stdout.write(`${s}\n`)
}
