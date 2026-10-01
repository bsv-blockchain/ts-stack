import { Beef, CachedKeyDeriver, CreateActionResult, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { Wallet } from '../../../src/Wallet'
import { MockServices } from '../../../src/mockchain/MockServices'
import { Monitor } from '../../../src/monitor/Monitor'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../../src/storage/WalletStorageManager'
import { ScriptTemplateBRC29 } from '../../../src/utility/ScriptTemplateBRC29'
import { randomBytesHex } from '../../../src/utility/utilityHelpers'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'

/**
 * A declared ancestor must never be left half-carried in the result BEEF.
 *
 * THE INVARIANT. A recipient can handle an ancestor that is absent or txid-only: it skips it and
 * restores it from its own records. It can handle one carried complete. It can do NEITHER with
 * one that is present, unproven, and whose input sources are missing -- that is not provable and
 * not marked as omitted. Under BRC-105 the payer has already broadcast by the time a recipient
 * rejects, so that shape costs the payer real satoshis and buys nothing.
 *
 * WHY THIS USES THE TWO-STEP SIGNABLE FLOW, and why a one-shot createAction cannot show it.
 * Storage omits a declared ancestor from inputBeef correctly. What re-materializes it is a
 * SEPARATE channel: for each funding output, storage also supplies `sourceTransaction` from its
 * own records, gated on isSignAction (storage/methods/actionBatch.ts) --
 *
 *     if (args.isSignAction && args.includeAllSourceTransactions) {
 *       copy.sourceTransaction = await storage.getRawTxOfKnownValidTransaction(output.txid)
 *     }
 *
 * -- which knownTxids does not touch. signAction then does `beef.mergeTransaction(prior.tx)` over
 * a BEEF storage had already trimmed, and Beef.mergeTransactionGraph merges that source as a FULL
 * entry, overwriting the omission. The walk stops there, because the source transaction carries no
 * sources of its own: ancestor whole, grandparents gone.
 *
 * isSignAction is false for a one-shot createAction, so sourceTransaction is never populated,
 * nothing is re-materialized, and the result is correct by accident. That is why three earlier
 * harnesses driving createAction directly all produced a correct BEEF while the real wallet did
 * not: an interactive wallet must show the user a payment before signing it, so every BRC-105
 * payment it makes goes through createAction(signAndProcess: false) + signAction.
 *
 * The funding action is genuinely broadcast and mined, via MockServices, so that
 * getRawTxOfKnownValidTransaction has raw bytes to return.
 */
describe('knownTxids in the result BEEF', () => {
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
    // Mature coinbases, so the wallet can be funded by a transaction the mock processor
    // validates normally.
    for (let i = 0; i < 105; i++) await services.mineBlock()
  })

  afterAll(async () => {
    await chainDb.destroy()
  })

  async function fundWallet(wallet: Wallet): Promise<void> {
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
    const derivationPrefix = Utils.toBase64(Array(16).fill(21))
    const derivationSuffix = Utils.toBase64(Array(16).fill(22))
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    payment.addOutput({ satoshis: 1_000_000, lockingScript: template.lock(keys.privateKey, keys.publicKey) })

    const sourceProof = await services.getMerklePath(utxo.txid)
    const submitBeef = new Beef()
    const sourceBump = submitBeef.mergeBump(sourceProof.merklePath!)
    submitBeef.mergeRawTx(sourceRaw, sourceBump)
    submitBeef.mergeRawTx(payment.toUint8Array())
    const paymentTxid = payment.id('hex')
    expect((await services.postBeef(submitBeef, [paymentTxid]))[0].status).toBe('success')

    await services.mineBlock()
    const paymentProof = await services.getMerklePath(paymentTxid)
    const atomic = new Beef()
    const paymentBump = atomic.mergeBump(paymentProof.merklePath!)
    atomic.mergeRawTx(payment.toUint8Array(), paymentBump)
    await expect(
      wallet.internalizeAction({
        tx: atomic.toBinaryAtomic(paymentTxid),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey }
          }
        ],
        description: 'Fund the knownTxids test wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  async function createWallet(): Promise<{ wallet: Wallet; destroy: () => Promise<void> }> {
    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const identityKey = rootKey.toPublicKey().toString()
    const db = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const key = randomBytesHex(33)
    const provider = new StorageKnex({
      chain: 'mock',
      knex: db,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await provider.migrate('knownTxids_wallet', key)
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
    const wallet = new Wallet({ chain: 'mock', keyDeriver, storage, services, monitor })
    await fundWallet(wallet)
    return {
      wallet,
      destroy: async () => {
        await wallet.destroy()
        await db.destroy()
      }
    }
  }

  /**
   * Mirrors the recipient's own rule. A source counts as resolvable if it is carried in full, or
   * if it was declared -- a declared one is restored from the recipient's records. Anything else
   * is a dead end the recipient can neither verify nor look up.
   */
  function unverifiableInFull(beef: Beef, declared: string[]): string[] {
    const carriedInFull = new Set(beef.txs.filter(btx => !btx.isTxidOnly).map(btx => btx.txid))
    const broken: string[] = []
    for (const btx of beef.txs) {
      if (btx.isTxidOnly || btx.bumpIndex !== undefined) continue
      for (const input of btx.tx?.inputs ?? []) {
        const sourceTxid = input.sourceTXID
        if (sourceTxid == null) continue
        if (carriedInFull.has(sourceTxid) || declared.includes(sourceTxid)) continue
        broken.push(`${btx.txid} is carried in full but its source ${sourceTxid} is neither present nor declared`)
      }
    }
    return broken
  }

  test('a declared ancestor is never left carried in full with its sources missing', async () => {
    const { wallet, destroy } = await createWallet()
    try {
      // Sent, not noSend: this is what makes it a KNOWN VALID transaction, which is what causes
      // storage to hand back its raw bytes as an input's sourceTransaction later.
      const first: CreateActionResult = await wallet.createAction({
        description: 'first payment',
        outputs: [{ satoshis: 5_000, lockingScript: '51', outputDescription: 'recipient' }],
        options: { randomizeOutputs: false }
      })
      expect(first.txid).toBeDefined()

      // Spends the first payment's change while it is still unconfirmed -- the self-chained case
      // a declaration exists to collapse.
      // TWO-STEP SIGNABLE FLOW. isSignAction is what gates
      // actionBatch.ts:375 `if (args.isSignAction && args.includeAllSourceTransactions)`,
      // the line that populates sourceTransaction from storage.
      const second: CreateActionResult = await wallet.createAction({
        description: 'second payment, declaring the first',
        outputs: [{ satoshis: 5_000, lockingScript: '51', outputDescription: 'recipient' }],
        options: {
          knownTxids: [first.txid!],
          randomizeOutputs: false,
          signAndProcess: false
        }
      })
      expect(second.signableTransaction).toBeDefined()
      const signed = await wallet.signAction({
        reference: second.signableTransaction!.reference,
        spends: {}
      })
      expect(signed.tx).toBeDefined()

      const beef = Beef.fromBinary(signed.tx!)
      expect(unverifiableInFull(beef, [first.txid!])).toEqual([])

      // returnTXIDOnly is decided at sign time. The result must carry no transaction bytes,
      // including no re-materialized ancestor.
      const third = await wallet.createAction({
        description: 'txid-only sign result',
        outputs: [{ satoshis: 5_000, lockingScript: '51', outputDescription: 'recipient' }],
        options: { randomizeOutputs: false, signAndProcess: false }
      })
      expect(third.signableTransaction).toBeDefined()
      const txidOnly = await wallet.signAction({
        reference: third.signableTransaction!.reference,
        spends: {},
        options: { returnTXIDOnly: true }
      })
      expect(txidOnly.txid).toBeDefined()
      expect(txidOnly.tx).toBeUndefined()
    } finally {
      await destroy()
    }
  })
})
