/* eslint-disable @typescript-eslint/no-unused-vars */
import * as bsv from '@bsv/sdk'
import { sdk, Wallet } from '../../../src/index.all'

import {
  _tu,
  logTransaction,
  TestKeyPair,
  TestWalletNoSetup,
  cleanUnsentTransactionsUsingAbort,
  cleanUnsignedTransactionsUsingAbort,
  cleanUnprocessedTransactionsUsingAbort
} from '../../utils/TestUtilsWalletStorage'

describe('createActionToGenerateBeefs test', () => {
  jest.setTimeout(99999999)

  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    ctxs.push(await _tu.createLiveWalletSQLiteWARNING())
    for (const { services } of ctxs) {
      // Mock the services postBeef to avoid actually broadcasting new transactions and collect beef data.
      services.postBeef = jest
        .fn()
        .mockImplementation((beef: bsv.Beef, txids: string[]): Promise<sdk.PostBeefResult[]> => {
          const r: sdk.PostBeefResult = {
            name: 'mock',
            status: 'success',
            txidResults: txids.map(txid => ({ txid, status: 'success' }))
          }
          return Promise.resolve([r])
        })
    }
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('1_send 2 txs in a beef', async () => {
    const root = '02135476'
    const kp = _tu.getKeyPair(root.repeat(8))

    for (const { wallet, activeStorage: storage } of ctxs) {
      const {
        txidPair: [txid1, txid2],
        Beef: beef1
      } = await createAndConsume(wallet, root, kp)

      {
        const createArgs: bsv.CreateActionArgs = {
          description: `${kp.address} of ${root}`,
          options: {
            acceptDelayedBroadcast: false,
            sendWith: [txid1, txid2]
          }
        }

        const cr = await wallet.createAction(createArgs)

        expect(cr.noSendChange).not.toBeTruthy()
        expect(cr.sendWithResults?.length).toBe(2)
        const [swr1, swr2] = cr.sendWithResults!
        expect(swr1.status !== 'failed').toBe(true)
        expect(swr2.status !== 'failed').toBe(true)
        expect(swr1.txid).toBe(txid1)
        expect(swr2.txid).toBe(txid2)
        const r1 = await cleanUnsentTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r1)).resolves.toBe(true)
        const r2 = await cleanUnsignedTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r2)).resolves.toBe(true)
        const r3 = await cleanUnprocessedTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r3)).resolves.toBe(true)
      }
    }
  })

  test('2_send 4 txs in a single beef ', async () => {
    const root1 = '02135476'
    const kp1 = _tu.getKeyPair(root1.repeat(8))
    const root2 = '02135478'
    const kp2 = _tu.getKeyPair(root2.repeat(8))

    for (const { wallet, activeStorage: storage } of ctxs) {
      const {
        txidPair: [txid1, txid2],
        Beef: beef1
      } = await createAndConsume(wallet, root1, kp1)
      expect(txid1).toBeTruthy()
      expect(txid2).toBeTruthy()

      const {
        txidPair: [txid3, txid4],
        Beef: beef2
      } = await createAndConsume(wallet, root2, kp2)
      expect(txid3).toBeTruthy()
      expect(txid4).toBeTruthy()

      {
        const createArgs: bsv.CreateActionArgs = {
          description: `${root1} & ${root2}`,
          options: {
            acceptDelayedBroadcast: false,
            sendWith: [txid1, txid2, txid3, txid4]
          }
        }

        const cr = await wallet.createAction(createArgs)

        expect(cr.noSendChange).not.toBeTruthy()
        expect(cr.sendWithResults?.length).toBe(2)
        const [swr1, swr2, swr3, swr4] = cr.sendWithResults!
        expect(swr1.status !== 'failed').toBe(true)
        expect(swr2.status !== 'failed').toBe(true)
        expect(swr3.status !== 'failed').toBe(true)
        expect(swr4.status !== 'failed').toBe(true)
        expect(swr1.txid).toBe(txid1)
        expect(swr2.txid).toBe(txid2)
        expect(swr3.txid).toBe(txid3)
        expect(swr4.txid).toBe(txid4)
        const r1 = await cleanUnsentTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r1)).resolves.toBe(true)
        const r2 = await cleanUnsignedTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r2)).resolves.toBe(true)
        const r3 = await cleanUnprocessedTransactionsUsingAbort(wallet, storage)
        await expect(Promise.resolve(r3)).resolves.toBe(true)
      }
    }
  })

  test('3_test tranaction log', async () => {
    for (const { activeStorage: storage } of ctxs) {
      const txid: bsv.HexString = 'ed11e4b7402e38bac0ec7431063ae7c14ee82370e5f1963d48ae27a70527f784'
      const rl = await logTransaction(storage, txid)
      console.log(rl)
      break
    }
  })
  test('4_abort set of nosend transactions', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      const r = await cleanUnsentTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r)).resolves.toBe(true)
    }
  })

  test('5_abort a set of unsigned transactions', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      const r = await cleanUnsignedTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r)).resolves.toBe(true)
    }
  })

  test('6_abort a set of unprocessed transactions', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      const r = await cleanUnprocessedTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r)).resolves.toBe(true)
    }
  })

  test('7_abort all transactions', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      const r1 = await cleanUnsentTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r1)).resolves.toBe(true)
      const r2 = await cleanUnsignedTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r2)).resolves.toBe(true)
      const r3 = await cleanUnprocessedTransactionsUsingAbort(wallet, storage)
      await expect(Promise.resolve(r3)).resolves.toBe(true)
    }
  })
})

async function createAndConsume(
  wallet: Wallet,
  root: string,
  kp: TestKeyPair
): Promise<{ txidPair: bsv.TXIDHexString[]; Beef: bsv.Beef }> {
  let txid1: bsv.TXIDHexString
  let txid2: bsv.TXIDHexString
  const outputSatoshis = 42
  let noSendChange: string[] | undefined
  let inputBEEF: bsv.AtomicBEEF | undefined

  {
    const createArgs: bsv.CreateActionArgs = {
      description: `${kp.address} of ${root}`,
      outputs: [
        {
          satoshis: outputSatoshis,
          lockingScript: _tu.getLockP2PKH(kp.address).toHex(),
          outputDescription: 'pay fred'
        }
      ],
      options: {
        randomizeOutputs: false,
        signAndProcess: false,
        noSend: true
      }
    }

    const cr = await wallet.createAction(createArgs)

    noSendChange = cr.noSendChange

    expect(cr.noSendChange).toBeTruthy()
    expect(cr.sendWithResults).toBeUndefined()
    expect(cr.tx).toBeUndefined()
    expect(cr.txid).toBeUndefined()

    expect(cr.signableTransaction).toBeTruthy()
    const st = cr.signableTransaction!
    expect(st.reference).toBeTruthy()
    // const tx = Transaction.fromAtomicBEEF(st.tx) // Transaction doesn't support V2 Beef yet.
    const atomicBeef = bsv.Beef.fromBinary(st.tx)
    const tx = atomicBeef.txs[atomicBeef.txs.length - 1].tx!
    for (const input of tx.inputs) {
      expect(atomicBeef.findTxid(input.sourceTXID!)).toBeTruthy()
    }

    // Spending authorization check happens here...
    //expect(st.amount > 242 && st.amount < 300).toBe(true)

    // sign and complete
    const signArgs: bsv.SignActionArgs = {
      reference: st.reference,
      spends: {},
      options: {
        returnTXIDOnly: false,
        noSend: true
      }
    }

    const sr = await wallet.signAction(signArgs)
    inputBEEF = sr.tx

    txid1 = sr.txid!
    // Update the noSendChange txid to final signed value.
    noSendChange = noSendChange!.map(op => `${txid1}.${op.split('.')[1]}`)
  }
  {
    const unlock = _tu.getUnlockP2PKH(kp.privateKey, outputSatoshis)
    const unlockingScriptLength = await unlock.estimateLength()

    const createArgs: bsv.CreateActionArgs = {
      description: `${kp.address} of ${root}`,
      inputs: [
        {
          outpoint: `${txid1}.0`,
          inputDescription: 'spend ${kp.address} of ${root}',
          unlockingScriptLength
        }
      ],
      inputBEEF,
      options: {
        noSendChange,
        // signAndProcess: false, // Not required as an input lacks unlock script...
        noSend: true
      }
    }

    const cr = await wallet.createAction(createArgs)

    expect(cr.noSendChange).toBeTruthy()
    expect(cr.sendWithResults).toBeUndefined()
    expect(cr.tx).toBeUndefined()
    expect(cr.txid).toBeUndefined()
    expect(cr.signableTransaction).toBeTruthy()
    const st = cr.signableTransaction!
    expect(st.reference).toBeTruthy()
    const atomicBeef: bsv.Beef = bsv.Beef.fromBinary(st.tx)
    const tx = atomicBeef.txs[atomicBeef.txs.length - 1].tx!

    tx.inputs[0].unlockingScriptTemplate = unlock
    await tx.sign()
    const unlockingScript = tx.inputs[0].unlockingScript!.toHex()

    const signArgs: bsv.SignActionArgs = {
      reference: st.reference,
      spends: { 0: { unlockingScript } },
      options: {
        returnTXIDOnly: true,
        noSend: true
      }
    }
    const sr = await wallet.signAction(signArgs)

    txid2 = sr.txid!
    //expect(atomicBeef.isValid()).toBe(true)
    return { txidPair: [txid1, txid2], Beef: atomicBeef }
  }
}
