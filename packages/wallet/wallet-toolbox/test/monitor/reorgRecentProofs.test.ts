import { Beef, CachedKeyDeriver, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { Wallet } from '../../src/Wallet'
import { MockServices } from '../../src/mockchain/MockServices'
import { Monitor } from '../../src/monitor/Monitor'
import { TaskReorg } from '../../src/monitor/tasks/TaskReorg'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../src/storage/WalletStorageManager'
import { ScriptTemplateBRC29 } from '../../src/utility/ScriptTemplateBRC29'
import { randomBytesHex } from '../../src/utility/utilityHelpers'
import { asArray } from '../../src/utility/utilityHelpers.noBuffer'

/**
 * A stored proof is a claim about the block at a height. When the header at that height
 * changes, the wallet must re-check the proof, whether or not its chaintracks client can
 * push reorg events.
 *
 * The mock chain tracker, like the HTTP-polling ChaintracksServiceClient, raises no reorg
 * events. Before the recent-proof review in TaskReorg, nothing re-proved a proof taken from
 * an orphaned block: TaskReorg only drains deactivated headers pushed by reorg events, and
 * TaskReviewProvenTxs skips heights within `minBlockAge` of the tip. A later spend that also
 * selected a coin proven by the winning block at the same height carried two BUMPs with
 * different roots at one height, and the merged BEEF failed validation.
 */
describe('TaskReorg re-proves recent proofs without reorg events', () => {
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
    // Mature coinbases so the wallet can be paid from them.
    for (let i = 0; i < 105; i++) await services.mineBlock()
  })

  afterAll(async () => {
    await chainDb.destroy()
  })

  /** Posts a 1,000,000 sat BRC-29 payment to the wallet from a matured coinbase; does not mine it. */
  async function postPayment(wallet: Wallet, suffixByte: number): Promise<{ txid: string; rawTx: number[] }> {
    const height = await services.getHeight()
    const [utxo] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - 100)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    expect(utxo).toBeDefined()

    const sourceRaw = asArray((await services.storage.getTransaction(utxo.txid))!.rawTx)
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({
      derivationPrefix: Utils.toBase64(Array(16).fill(21)),
      derivationSuffix: Utils.toBase64(Array(16).fill(suffixByte)),
      keyDeriver: wallet.keyDeriver
    })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: Transaction.fromBinary(sourceRaw),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    payment.addOutput({ satoshis: 1_000_000, lockingScript: template.lock(keys.privateKey, keys.publicKey) })

    const sourceProof = await services.getMerklePath(utxo.txid)
    const submitBeef = new Beef()
    submitBeef.mergeRawTx(sourceRaw, submitBeef.mergeBump(sourceProof.merklePath!))
    submitBeef.mergeRawTx(payment.toUint8Array())
    const txid = payment.id('hex')
    expect((await services.postBeef(submitBeef, [txid]))[0].status).toBe('success')
    return { txid, rawTx: Array.from(payment.toUint8Array()) }
  }

  /** Internalizes a mined payment with the proof the mock chain serves for it now. */
  async function internalize(wallet: Wallet, payment: { txid: string; rawTx: number[] }, suffixByte: number) {
    const proof = await services.getMerklePath(payment.txid)
    const atomic = new Beef()
    atomic.mergeRawTx(payment.rawTx, atomic.mergeBump(proof.merklePath!))
    await expect(
      wallet.internalizeAction({
        tx: atomic.toBinaryAtomic(payment.txid),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: Utils.toBase64(Array(16).fill(21)),
              derivationSuffix: Utils.toBase64(Array(16).fill(suffixByte)),
              senderIdentityKey: wallet.identityKey
            }
          }
        ],
        description: 'fund the reorg test wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  async function createWallet(): Promise<{
    wallet: Wallet
    monitor: Monitor
    storage: WalletStorageManager
    destroy: () => Promise<void>
  }> {
    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
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
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await provider.migrate('reorg_recent_proofs_wallet', randomBytesHex(33))
    await provider.makeAvailable()
    const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
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
      maxRebroadcastAttempts: 0
    })
    // Only the task under test, driven through the monitor's own scheduler.
    monitor.addTask(new TaskReorg(monitor))
    const wallet = new Wallet({ chain: 'mock', keyDeriver: new CachedKeyDeriver(rootKey), storage, services, monitor })
    return {
      wallet,
      monitor,
      storage,
      destroy: async () => {
        await wallet.destroy()
        await db.destroy()
      }
    }
  }

  async function storedProof(storage: WalletStorageManager, txid: string) {
    let row: { height: number; merkleRoot: string; blockHash: string } | undefined
    await storage.runAsStorageProvider(async sp => {
      row = (await sp.findProvenTxs({ partial: { txid } }))[0]
    })
    expect(row).toBeDefined()
    return row!
  }

  test('a proof from an orphaned block is re-proved after the next block, and the spend then validates', async () => {
    const { wallet, monitor, storage, destroy } = await createWallet()
    try {
      // 1. Coin A is mined in block X at height H and the wallet stores its proof.
      const a = await postPayment(wallet, 31)
      const blockX = await services.mineBlock()
      await internalize(wallet, a, 31)
      expect((await storedProof(storage, a.txid)).blockHash).toBe(blockX.hash)

      // The monitor processes block X as its new tip. TaskNewHeader makes this call once a tip
      // has held for a cycle; it is made directly here because TaskNewHeader requires mainnet
      // proof of work, which the mock chain's headers do not meet.
      monitor.processNewBlockHeader(blockX)
      await monitor.runOnce()
      expect((await storedProof(storage, a.txid)).blockHash).toBe(blockX.hash)

      // 2. Coin B waits in the mempool when a competing block X' wins at H, holding A and B.
      //    The new tip arrives as a height increase (H + 1), as in the field report.
      const b = await postPayment(wallet, 32)
      const reorg = await services.reorg(blockX.height, 2, { [a.txid]: 0, [b.txid]: 0 })
      expect(reorg.newTip.height).toBe(blockX.height + 1)
      const blockXPrime = (await services.tracker.findHeaderForHeight(blockX.height))!
      expect(blockXPrime.hash).not.toBe(blockX.hash)

      // 3. The wallet receives B with its proof from X'; A still holds X's stale proof.
      await internalize(wallet, b, 32)
      expect((await storedProof(storage, b.txid)).merkleRoot).toBe(blockXPrime.merkleRoot)
      expect((await storedProof(storage, a.txid)).merkleRoot).toBe(blockX.merkleRoot)

      // 4. The monitor processes the new tip H + 1; the next scheduler tick re-proves A.
      monitor.processNewBlockHeader(reorg.newTip)
      await monitor.runOnce()

      const reproved = await storedProof(storage, a.txid)
      expect(reproved.blockHash).toBe(blockXPrime.hash)
      expect(reproved.merkleRoot).toBe(blockXPrime.merkleRoot)

      // 5. A spend that needs both coins carries one root at height H, and its BEEF verifies.
      //    With A's stale proof it carried two roots at H: verifyValid() false, as in the report.
      const spend = await wallet.createAction({
        description: 'spend both coins',
        outputs: [{ satoshis: 1_500_000, lockingScript: '51', outputDescription: 'both coins' }],
        options: { randomizeOutputs: false }
      })
      const beef = Beef.fromBinary(spend.tx!)
      expect(beef.findTxid(a.txid)?.bumpIndex).toBeDefined()
      expect(beef.findTxid(b.txid)?.bumpIndex).toBeDefined()
      expect(beef.bumps.filter(bump => bump.blockHeight === blockX.height)).toHaveLength(1)
      expect(beef.verifyValid().valid).toBe(true)
      expect(await beef.verify(services.tracker)).toBe(true)
    } finally {
      await destroy()
    }
  })
})
