import { Beef, CachedKeyDeriver, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { Wallet } from '../../../src/Wallet'
import { MockServices } from '../../../src/mockchain/MockServices'
import { Monitor } from '../../../src/monitor/Monitor'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../../src/storage/WalletStorageManager'
import { ScriptTemplateBRC29 } from '../../../src/utility/ScriptTemplateBRC29'
import { randomBytesHex } from '../../../src/utility/utilityHelpers'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'
import { maxPossibleSatoshis } from '../../../src/storage/methods/maxPossibleSatoshis'

/**
 * A sendMax (maxPossibleSatoshis) createAction must be funded from the wallet's
 * unproven change when it holds no confirmed coins, as an ordinary payment is.
 * Planning against the empty confirmed tier used to reduce the sendMax output
 * to minus the fee of an input-less transaction and fail in the signer with
 * "The o.satoshis parameter must be a valid number of satoshis".
 */
type Mode = 'auto' | 'legacy'

const P2PKH = '76a914' + '11'.repeat(20) + '88ac'

describe('sendMax funded from unproven change', () => {
  jest.setTimeout(120_000)

  let chainDb: Knex
  let services: MockServices

  beforeAll(async () => {
    chainDb = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    services = new MockServices(chainDb)
    await services.initialize()
    for (let i = 0; i < 105; i++) await services.mineBlock()
  })

  afterAll(async () => {
    await chainDb.destroy()
  })

  async function fundWallet(wallet: Wallet, amounts: number[], mine: boolean): Promise<void> {
    const height = await services.getHeight()
    const [utxo] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - 100)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    expect(utxo).toBeDefined()

    const sourceRow = await services.storage.getTransaction(utxo.txid)
    const sourceRaw = asArray(sourceRow!.rawTx)
    const source = Transaction.fromBinary(sourceRaw)
    const keys = wallet.getClientChangeKeyPair()
    const derivationPrefix = Utils.toBase64(Array(16).fill(21))
    const remittances = amounts.map((_, i) => ({
      derivationPrefix,
      derivationSuffix: Utils.toBase64(Array(16).fill(i + 1))
    }))
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    amounts.forEach((satoshis, i) => {
      const template = new ScriptTemplateBRC29({ ...remittances[i], keyDeriver: wallet.keyDeriver })
      payment.addOutput({ satoshis, lockingScript: template.lock(keys.privateKey, keys.publicKey) })
    })

    const sourceProof = await services.getMerklePath(utxo.txid)
    const submitBeef = new Beef()
    submitBeef.mergeRawTx(sourceRaw, submitBeef.mergeBump(sourceProof.merklePath!))
    submitBeef.mergeRawTx(payment.toUint8Array())
    const paymentTxid = payment.id('hex')

    let atomic: Beef
    if (mine) {
      expect((await services.postBeef(submitBeef, [paymentTxid]))[0].status).toBe('success')
      await services.mineBlock()
      const paymentProof = await services.getMerklePath(paymentTxid)
      atomic = new Beef()
      atomic.mergeRawTx(payment.toUint8Array(), atomic.mergeBump(paymentProof.merklePath!))
    } else {
      atomic = submitBeef
    }
    await expect(
      wallet.internalizeAction({
        tx: atomic.toBinaryAtomic(paymentTxid),
        outputs: amounts.map((_, i) => ({
          outputIndex: i,
          protocol: 'wallet payment' as const,
          paymentRemittance: { ...remittances[i], senderIdentityKey: wallet.identityKey }
        })),
        description: 'Fund the sendMax test wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  async function createWallet(
    satsPerKb: number,
    mode: Mode
  ): Promise<{ wallet: Wallet; destroy: () => Promise<void> }> {
    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const identityKey = rootKey.toPublicKey().toString()
    const db = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const provider = new StorageKnex({
      chain: 'mock',
      knex: db,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: satsPerKb }
    })
    await provider.migrate('sendmax_wallet', randomBytesHex(33))
    await provider.makeAvailable()
    const storage = new WalletStorageManager(identityKey, provider)
    await storage.makeAvailable()
    storage.setServices(services)
    const monitor = new Monitor({
      chain: 'mock',
      storage,
      services,
      chaintracks: services.tracker as any,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 5_000,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
      startupTaskMode: 'default'
    })
    const wallet = new Wallet({ chain: 'mock', keyDeriver, storage, services, monitor, actionBatchMode: mode })
    return {
      wallet,
      destroy: async () => {
        await wallet.destroy()
        await db.destroy()
      }
    }
  }

  async function sendMax(wallet: Wallet, satsPerKb: number): Promise<void> {
    const before = await wallet.listOutputs({ basket: 'default', limit: 100 })
    const total = before.outputs.reduce((sum, o) => sum + o.satoshis, 0)
    const car = await wallet.createAction({
      description: 'send max',
      outputs: [{ satoshis: maxPossibleSatoshis, lockingScript: P2PKH, outputDescription: 'send max output' }],
      options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: false }
    })
    const tx = Transaction.fromAtomicBEEF(car.tx!)
    const inTotal = tx.inputs.reduce((sum, i) => sum + i.sourceTransaction!.outputs[i.sourceOutputIndex].satoshis!, 0)
    expect(inTotal).toBe(total)
    expect(tx.outputs).toHaveLength(1)
    const fee = inTotal - tx.outputs[0].satoshis!
    expect(tx.outputs[0].satoshis!).toBeGreaterThan(0)
    expect(fee).toBeGreaterThanOrEqual(Math.ceil((tx.toBinary().length / 1000) * satsPerKb))
  }

  test.each([1, 8])('legacy mode: %i unproven coin(s)', async n => {
    const { wallet, destroy } = await createWallet(100, 'legacy')
    try {
      await fundWallet(wallet, [1000, 100000, 2500, 75000, 7000, 50000, 15000, 32000].slice(0, n), false)
      await sendMax(wallet, 100)
    } finally {
      await destroy()
    }
  })
  // In auto mode a noSend sendMax is planned from the action batch's reservation, which already
  // includes unproven change, so that case is a control.

  test.each(['legacy', 'auto'] as const)(
    '%s mode: right after an ordinary payment left only unproven change',
    async mode => {
      const { wallet, destroy } = await createWallet(100, mode)
      try {
        await fundWallet(wallet, [200000], true)
        await wallet.createAction({
          description: 'ordinary payment',
          outputs: [{ satoshis: 1000, lockingScript: P2PKH, outputDescription: 'ordinary payment' }],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        })
        await sendMax(wallet, 100)
      } finally {
        await destroy()
      }
    }
  )
})
