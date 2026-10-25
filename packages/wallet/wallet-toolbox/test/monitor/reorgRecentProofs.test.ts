import { Beef, CachedKeyDeriver, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { once } from 'node:events'
import { createServer, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Wallet } from '../../src/Wallet'
import { MockServices } from '../../src/mockchain/MockServices'
import { Monitor } from '../../src/monitor/Monitor'
import { TaskReorg } from '../../src/monitor/tasks/TaskReorg'
import { GoChaintracksServiceClient } from '../../src/services/chaintracker/chaintracks/GoChaintracksServiceClient'
import {
  blockHash,
  validateHeaderProofOfWork
} from '../../src/services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { BlockHeader } from '../../src/sdk/WalletServices.interfaces'
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
describe('TaskReorg proof recovery through wallet storage', () => {
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

  async function createWallet(chaintracks?: GoChaintracksServiceClient): Promise<{
    wallet: Wallet
    monitor: Monitor
    storage: WalletStorageManager
    destroy: () => Promise<void>
  }> {
    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
    const chain = chaintracks?.chain ?? 'mock'
    const db = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const provider = new StorageKnex({
      chain,
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
      chain,
      storage,
      services,
      chaintracks: chaintracks ?? (services.tracker as any),
      chaintracksWithEvents: chaintracks,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 5_000,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0
    })
    // Only the task under test, driven through the monitor's own scheduler.
    monitor.addTask(new TaskReorg(monitor, chaintracks === undefined ? undefined : 0))
    const wallet = new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage, services, monitor })
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

  async function within(promise: Promise<void>, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  test.each(['immediate', 'delayed', 'offline-gap'])(
    'repairs an orphaned proof and validates the spend (%s)',
    async mode => {
      const delayed = mode === 'delayed'
      const offline = mode === 'offline-gap'
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
        const initialTip = offline ? (await services.tracker.findHeaderForHeight(blockX.height - 15))! : blockX
        monitor.processNewBlockHeader(initialTip)
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

        const getMerklePath = services.getMerklePath.bind(services)
        let unavailable = delayed
        const proofProvider = jest
          .spyOn(services, 'getMerklePath')
          .mockImplementation(async txid => (unavailable && txid === a.txid ? {} : await getMerklePath(txid)))

        // 4. The monitor processes the new tip H + 1; the next scheduler tick re-proves A.
        const resumed = offline ? new Monitor(monitor.options) : monitor
        if (offline) resumed.addTask(new TaskReorg(resumed))
        if (offline) for (let i = 0; i < 15; i++) await services.mineBlock()
        const resumedTip = offline ? (await services.tracker.findChainTipHeader())! : reorg.newTip
        resumed.processNewBlockHeader(resumedTip)
        await resumed.runOnce()
        if (offline) {
          expect((await storedProof(storage, a.txid)).blockHash).toBe(blockX.hash)
          const now = Date.now()
          const clock = jest.spyOn(Date, 'now')
          try {
            for (let i = 0; i < 4; i++) {
              clock.mockReturnValue(now + (i + 1) * 60_001)
              await resumed.runOnce()
            }
          } finally {
            clock.mockRestore()
          }
        }

        if (delayed) {
          expect((await storedProof(storage, a.txid)).blockHash).toBe(blockX.hash)
          // Move beyond the 12-height recent window while the replacement proof is unavailable.
          for (let i = 0; i < 15; i++) await services.mineBlock()
          const tip = (await services.tracker.findChainTipHeader())!
          monitor.processNewBlockHeader(tip)
          await monitor.runOnce()
          expect((await storedProof(storage, a.txid)).blockHash).toBe(blockX.hash)
          // Restart the monitor against the same real SQLite wallet. Only durable events carry work over.
          const restarted = new Monitor(monitor.options)
          restarted.addTask(new TaskReorg(restarted))
          restarted.processNewBlockHeader(tip)
          unavailable = false
          await restarted.runOnce()
        }
        proofProvider.mockRestore()
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
    }
  )

  test('Go-shaped HTTP/SSE reorg repairs real SQLite proofs and validates a two-coin wallet spend', async () => {
    // The proof/broadcast provider stays synthetic. Mine its actual header fields to the
    // regtest target so the real HTTP client retains its format/hash/PoW validation.
    const canonical = new Map<number, BlockHeader>()
    const byHash = new Map<string, BlockHeader>()
    const syncHeaders = async (): Promise<void> => {
      const rows = await services.storage.knex('mockchain_block_headers').orderBy('height', 'asc')
      let previousHash = '00'.repeat(32)
      for (const row of rows) {
        const header: BlockHeader = {
          height: row.height,
          version: row.version,
          previousHash,
          merkleRoot: row.merkleRoot,
          time: row.time,
          bits: row.bits,
          nonce: 0,
          hash: ''
        }
        let mined = false
        for (let nonce = 0; nonce < 1000; nonce++) {
          header.nonce = nonce
          header.hash = blockHash(header)
          try {
            validateHeaderProofOfWork(header, 'regtest')
            mined = true
            break
          } catch {
            // Regtest's easy target keeps this fixture's mining bounded.
          }
        }
        expect(mined).toBe(true)
        await services.storage.knex('mockchain_block_headers').where({ height: header.height }).update({
          previousHash: header.previousHash,
          hash: header.hash,
          nonce: header.nonce
        })
        canonical.set(header.height, header)
        byHash.set(header.hash, header)
        previousHash = header.hash
      }
    }
    const requests: string[] = []
    const streams = new Set<ServerResponse>()
    let reorgStream!: ServerResponse
    let streamReady!: () => void
    const subscribed = new Promise<void>(resolve => {
      streamReady = resolve
    })
    const server = createServer((request, response) => {
      const path = request.url ?? ''
      requests.push(path)
      if (path.endsWith('/stream')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()
        streams.add(response)
        response.on('close', () => streams.delete(response))
        if (path === '/v2/reorg/stream') {
          reorgStream = response
          streamReady()
        }
        return
      }
      const tip = canonical.get(Math.max(...canonical.keys()))
      let value: unknown
      if (path === '/v2/network') value = 'regtest'
      else if (path === '/v2/height') value = tip?.height
      else if (path === '/v2/tip') value = tip
      else if (path.startsWith('/v2/header/height/')) value = canonical.get(Number(path.split('/').at(-1)))
      else if (path.startsWith('/v2/header/hash/')) value = byHash.get(path.split('/').at(-1)!)
      response.writeHead(value === undefined ? 404 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value)) // Go returns raw headers, not legacy envelopes.
    })
    services.chain = 'regtest'
    await syncHeaders()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = new GoChaintracksServiceClient(
      'regtest',
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`
    )
    const tracker = jest.spyOn(services, 'getChainTracker').mockResolvedValue(client)
    const { wallet, monitor, storage, destroy } = await createWallet(client)
    const reprove = jest.spyOn(storage, 'reproveHeader')
    const delivered = new Promise<void>(resolve => {
      const processReorg = monitor.processReorg.bind(monitor)
      jest.spyOn(monitor, 'processReorg').mockImplementation((...args) => {
        processReorg(...args)
        resolve()
      })
    })
    try {
      await within(monitor.ready, 'Monitor readiness')
      await within(subscribed, 'Go reorg subscription')
      const a = await postPayment(wallet, 41)
      const mined = await services.mineBlock()
      await syncHeaders()
      const oldTip = canonical.get(mined.height)!
      const ancestor = canonical.get(oldTip.height - 1)!
      await internalize(wallet, a, 41)
      expect((await storedProof(storage, a.txid)).blockHash).toBe(oldTip.hash)

      const b = await postPayment(wallet, 42)
      await services.reorg(oldTip.height, 2, { [a.txid]: 0, [b.txid]: 0 })
      await syncHeaders()
      const replacement = canonical.get(oldTip.height)!
      const newTip = canonical.get(oldTip.height + 1)!
      expect(replacement.hash).not.toBe(oldTip.hash)
      expect(byHash.get(oldTip.hash)).toEqual(oldTip) // The HTTP lookup retains the orphan.
      await internalize(wallet, b, 42)
      expect((await storedProof(storage, a.txid)).merkleRoot).toBe(oldTip.merkleRoot)
      expect((await storedProof(storage, b.txid)).merkleRoot).toBe(replacement.merkleRoot)

      // go-chaintracks v1.4.5 wire contract: descending orphan hashes, raw embedded headers.
      reorgStream.write(
        `data: ${JSON.stringify({ depth: 1, orphanedHashes: [oldTip.hash], commonAncestor: ancestor, newTip })}\n\n`
      )
      await within(delivered, 'Go reorg delivery')
      await monitor.reorgInvalidationPromise
      expect(monitor.deactivatedHeaders.map(item => item.header.hash)).toEqual([oldTip.hash])
      expect(monitor.lastNewHeader).toBeUndefined() // Event-specific repair must work before tip polling.
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1)
      try {
        await monitor.runOnce()
      } finally {
        now.mockRestore()
      }
      expect(reprove).toHaveBeenCalledTimes(1)
      expect(reprove).toHaveBeenCalledWith(oldTip.hash)
      expect((await storedProof(storage, a.txid)).blockHash).toBe(replacement.hash)
      expect((await storedProof(storage, a.txid)).merkleRoot).toBe(replacement.merkleRoot)
      expect(client.streamErrorCount).toBe(0)
      expect(requests).toContain(`/v2/header/hash/${oldTip.hash}`)

      // Finish the default recent/gap review through HTTP after the event repair.
      const beforeRecentReview = requests.length
      monitor.processNewBlockHeader(newTip)
      await monitor.runOnce()
      expect(requests.slice(beforeRecentReview)).toEqual(
        Array.from({ length: 12 }, (_, index) => `/v2/header/height/${newTip.height - 11 + index}`)
      )
      await storage.runAsStorageProvider(async provider => {
        const [event] = await provider.findMonitorEvents({
          partial: { event: 'ReorgRecovery' },
          orderDescending: true,
          paged: { limit: 1 }
        })
        expect(JSON.parse(event.details!)).toMatchObject({
          ranges: [],
          reviewedHash: newTip.hash,
          reviewedHeight: newTip.height
        })
      })
      const spend = await wallet.createAction({
        description: 'spend both HTTP reorg coins',
        outputs: [{ satoshis: 1_500_000, lockingScript: '51', outputDescription: 'both coins' }],
        options: { randomizeOutputs: false }
      })
      const beef = Beef.fromBinary(spend.tx!)
      expect(beef.findTxid(a.txid)?.bumpIndex).toBeDefined()
      expect(beef.findTxid(b.txid)?.bumpIndex).toBeDefined()
      expect(beef.bumps.filter(bump => bump.blockHeight === oldTip.height)).toHaveLength(1)
      expect(beef.verifyValid().valid).toBe(true)
      expect(await beef.verify(client)).toBe(true)
    } finally {
      reprove.mockRestore()
      await monitor.destroy()
      await destroy()
      tracker.mockRestore()
      services.chain = 'mock'
      for (const stream of streams) stream.end()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error)))
      )
    }
  })
})
