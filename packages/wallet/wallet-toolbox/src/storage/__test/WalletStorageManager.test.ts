import * as bsv from '@bsv/sdk'
import { wait } from '../..'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'

import * as dotenv from 'dotenv'

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
})
function logger(s: string) {
  process.stdout.write(`${s}\n`)
}
