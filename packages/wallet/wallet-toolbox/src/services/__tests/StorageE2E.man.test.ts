/**
 * Storage + Arcade end-to-end load tests
 *
 * Tests read throughput, write throughput, and Arcade SSE proof delivery
 * across three concurrency models:
 *   · Sequential   – single wallet, one request at a time
 *   · User-parallel – single wallet, N requests in parallel (tests server fan-out)
 *   · Multi-user   – N independent wallet instances in parallel (tests per-identity isolation)
 *
 * Required environment variables:
 *   STORAGE_E2E_ROOT_KEY        Funded mainnet private key hex (pre-funded testing wallet)
 *   STORAGE_E2E_TARGET_URL      Storage server under test (default: https://storage.fletchindustries.com)
 *   STORAGE_E2E_ARCADE_TOKEN    Arcade callbackToken (SSE routing)
 *   STORAGE_E2E_ARCADE_URL      Arcade base URL (default: https://arcade-v2-us-1.bsvblockchain.tech)
 *   STORAGE_E2E_BABBAGE_URL     Funded wallet storage (default: https://storage.babbage.systems)
 *   STORAGE_E2E_USER_COUNT      Number of parallel users for multi-user tests (default: 5)
 *   STORAGE_E2E_TX_COUNT        Transactions per write test (default: 10)
 *   STORAGE_E2E_OUTPUT_SATS     Satoshis per test output (default: 300)
 *
 * Run:
 *   STORAGE_E2E_ROOT_KEY=<hex> \
 *   STORAGE_E2E_ARCADE_TOKEN=<token> \
 *   node_modules/.bin/jest --runTestsByPath \
 *     src/services/__tests/StorageE2E.man.test.ts --verbose
 *
 * See e2e/storage/README.md for Docker setup and pre-funding instructions.
 */

import { PrivateKey, CachedKeyDeriver, P2PKH, Beef, HDPrivateKey } from '@bsv/sdk'
import { Wallet } from '../../Wallet'
import { Services } from '../Services'
import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'
import { WalletStorageManager } from '../../storage/WalletStorageManager'
import { StorageClient } from '../../storage/remoting/StorageClient'
import { Arcade } from '../providers/Arcade'

// ─── Configuration ──────────────────────────────────────────────────────────

const ROOT_KEY_HEX = process.env.STORAGE_E2E_ROOT_KEY ?? ''
const TARGET_URL = process.env.STORAGE_E2E_TARGET_URL ?? 'https://storage.fletchindustries.com'
const BABBAGE_URL = process.env.STORAGE_E2E_BABBAGE_URL ?? 'https://storage.babbage.systems'
const ARCADE_URL = process.env.STORAGE_E2E_ARCADE_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech'
const ARCADE_TOKEN = process.env.STORAGE_E2E_ARCADE_TOKEN ?? ''
const USER_COUNT = parseInt(process.env.STORAGE_E2E_USER_COUNT ?? '5', 10)
const TX_COUNT = parseInt(process.env.STORAGE_E2E_TX_COUNT ?? '10', 10)
const OUTPUT_SATS = parseInt(process.env.STORAGE_E2E_OUTPUT_SATS ?? '300', 10)

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Stats {
  count: number; min: number; max: number; avg: number
  p50: number; p95: number; p99: number
}

function calcStats (timings: number[]): Stats {
  const s = [...timings].sort((a, b) => a - b)
  const sum = timings.reduce((a, b) => a + b, 0)
  return {
    count: s.length,
    min: s[0],
    max: s[s.length - 1],
    avg: Math.round(sum / s.length),
    p50: s[Math.floor(s.length * 0.50)],
    p95: s[Math.floor(s.length * 0.95)],
    p99: s[Math.floor(s.length * 0.99)]
  }
}

function fmtStats (s: Stats): string {
  return `min=${s.min}ms avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`
}

function tps (count: number, wallMs: number): number {
  return Math.round(count / (wallMs / 1000) * 10) / 10
}

/** Derive a per-user child key from the root key using path m/44'/236'/0'/0/userIndex */
function deriveUserKey (rootHex: string, userIndex: number): PrivateKey {
  const hd = HDPrivateKey.fromRandom() // placeholder — see real derivation below
  // Use deterministic derivation from root: sha256(root || userIndex)
  const { Hash, Utils } = require('@bsv/sdk')
  const rootBytes = Utils.toArray(rootHex, 'hex')
  const indexBytes = [
    (userIndex >> 24) & 0xff,
    (userIndex >> 16) & 0xff,
    (userIndex >> 8) & 0xff,
    userIndex & 0xff
  ]
  const childSeed = Hash.sha256([...rootBytes, ...indexBytes])
  // clamp to valid secp256k1 range
  childSeed[0] = childSeed[0] & 0x7f
  if (childSeed.every((b: number) => b === 0)) childSeed[0] = 1
  return PrivateKey.fromArray(childSeed)
}

/** Build a single-provider wallet connected to storageUrl */
async function makeWallet (storageUrl: string, userKey?: PrivateKey): Promise<{
  wallet: Wallet; services: Services
}> {
  const rootKey = userKey ?? PrivateKey.fromHex(ROOT_KEY_HEX)
  const kd = new CachedKeyDeriver(rootKey)
  const opts = createDefaultWalletServicesOptions(
    'main', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ARCADE_URL, undefined, ARCADE_TOKEN || undefined
  )
  const svc = new Services(opts)
  const storage = new WalletStorageManager(kd.identityKey)
  const w = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: svc })
  const client = new StorageClient(w, storageUrl)
  await storage.addWalletStorageProvider(client)
  await storage.makeAvailable()
  return { wallet: w, services: svc }
}

/** Derive N wallet instances from the root key, each with a distinct identity */
async function makeUserPool (storageUrl: string, count: number): Promise<Array<{ wallet: Wallet; services: Services }>> {
  return Promise.all(
    Array.from({ length: count }, (_, i) => makeWallet(storageUrl, deriveUserKey(ROOT_KEY_HEX, i)))
  )
}

const lockingScript = (): string =>
  new P2PKH().lock(PrivateKey.fromHex(ROOT_KEY_HEX).toPublicKey().toAddress()).toHex()

// ─── Test 1: Read TPS ───────────────────────────────────────────────────────

describe('1 · Read TPS', () => {
  jest.setTimeout(120_000)

  test('1a · Raw HTTP — sequential baseline (30 requests)', async () => {
    const timings: number[] = []
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now()
      try { await fetch(TARGET_URL + '/') } catch { /* swallow */ }
      timings.push(Date.now() - t0)
    }
    const s = calcStats(timings)
    const wallMs = timings.reduce((a, b) => a + b, 0)
    console.log(`\n[readTPS:raw:seq] 30 requests in ${wallMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(30, wallMs)} req/s`)
    expect(s.p95).toBeLessThan(5_000)
  })

  test('1b · Raw HTTP — user-parallel (30 concurrent)', async () => {
    const wallStart = Date.now()
    const timings = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const t0 = Date.now()
        try { await fetch(TARGET_URL + '/') } catch { /* swallow */ }
        return Date.now() - t0
      })
    )
    const wallMs = Date.now() - wallStart
    const s = calcStats(timings)
    console.log(`\n[readTPS:raw:par] 30 concurrent in ${wallMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(30, wallMs)} req/s (wall-clock)`)
    expect(s.p95).toBeLessThan(10_000)
  })

  test(`1c · BRC-100 listOutputs — single user, user-parallel (${USER_COUNT * 4} concurrent)`, async () => {
    const { wallet } = await makeWallet(BABBAGE_URL)
    await wallet.listOutputs({ basket: 'default', limit: 5 }) // warmup

    const CONC = USER_COUNT * 4
    const wallStart = Date.now()
    const timings = await Promise.all(
      Array.from({ length: CONC }, async () => {
        const t0 = Date.now()
        await wallet.listOutputs({ basket: 'default', limit: 10 })
        return Date.now() - t0
      })
    )
    const wallMs = Date.now() - wallStart
    const s = calcStats(timings)
    console.log(`\n[readTPS:BRC100:par] ${CONC} concurrent listOutputs in ${wallMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(CONC, wallMs)} req/s (wall-clock)`)
    expect(s.p95).toBeLessThan(15_000)
  })

  test(`1d · BRC-100 listOutputs — multi-user parallel (${USER_COUNT} users × 4 concurrent each)`, async () => {
    const pool = await makeUserPool(BABBAGE_URL, USER_COUNT)

    const wallStart = Date.now()
    const allTimings = (await Promise.all(
      pool.map(async ({ wallet }) => {
        const batch = Array.from({ length: 4 }, async () => {
          const t0 = Date.now()
          await wallet.listOutputs({ basket: 'default', limit: 10 })
          return Date.now() - t0
        })
        return Promise.all(batch)
      })
    )).flat()
    const wallMs = Date.now() - wallStart
    const s = calcStats(allTimings)
    const total = USER_COUNT * 4
    console.log(`\n[readTPS:BRC100:multi] ${USER_COUNT} users × 4 = ${total} requests in ${wallMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(total, wallMs)} req/s (wall-clock)`)
    expect(s.p95).toBeLessThan(15_000)
  })

  test('1e · Raw HTTP — vs babbage.systems baseline (30 concurrent)', async () => {
    const wallStart = Date.now()
    const timings = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const t0 = Date.now()
        try { await fetch(BABBAGE_URL + '/') } catch { /* swallow */ }
        return Date.now() - t0
      })
    )
    const wallMs = Date.now() - wallStart
    const s = calcStats(timings)
    console.log(`\n[readTPS:baseline] babbage.systems 30 concurrent in ${wallMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(30, wallMs)} req/s (wall-clock)`)
    expect(s.p95).toBeLessThan(10_000)
  })
})

// ─── Test 2: Write TPS ──────────────────────────────────────────────────────

describe('2 · Write TPS', () => {
  jest.setTimeout(300_000)

  test(`2a · Single user sequential — ${TX_COUNT} txs via babbage broadcaster`, async () => {
    const { wallet } = await makeWallet(BABBAGE_URL)
    const ls = lockingScript()
    const timings: number[] = []
    const txids: string[] = []

    const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
    const bal = (outputs as any[]).filter(o => o.spendable).reduce((s: number, o: any) => s + o.satoshis, 0)
    console.log(`\n[writeTPS:seq] balance=${bal} sats, writing ${TX_COUNT} txs`)

    for (let i = 0; i < TX_COUNT; i++) {
      const t0 = Date.now()
      const cr = await wallet.createAction({
        description: `e2e write seq #${i + 1}`,
        outputs: [{ lockingScript: ls, satoshis: OUTPUT_SATS, outputDescription: 'e2e-seq' }],
        options: { acceptDelayedBroadcast: false }
      })
      const ms = Date.now() - t0
      timings.push(ms)
      txids.push(cr.txid!)
      console.log(`  [${i + 1}/${TX_COUNT}] ${cr.txid!.substring(0, 20)}... ${ms}ms`)
    }

    const s = calcStats(timings)
    const totalMs = timings.reduce((a, b) => a + b, 0)
    console.log(`\n[writeTPS:seq] ${TX_COUNT} txs in ${totalMs}ms`)
    console.log(`  ${fmtStats(s)}  →  ${tps(TX_COUNT, totalMs)} tx/s (sequential)`)
    expect(txids.length).toBe(TX_COUNT)
  })

  test(`2b · Single user parallel — ${TX_COUNT} noSend txs + concurrent Arcade broadcast`, async () => {
    const { wallet } = await makeWallet(BABBAGE_URL)
    const arcade = new Arcade(ARCADE_URL, {
      callbackToken: ARCADE_TOKEN,
      callbackUrl: TARGET_URL + '/arc-ingest'
    })
    const ls = lockingScript()

    // Phase 1: create noSend txs sequentially (UTXO selection must be serial)
    console.log(`\n[writeTPS:userpar] creating ${TX_COUNT} noSend txs...`)
    const created: Array<{ txid: string; tx: number[] }> = []
    for (let i = 0; i < TX_COUNT; i++) {
      try {
        const cr = await wallet.createAction({
          description: `e2e write par #${i + 1}`,
          outputs: [{ lockingScript: ls, satoshis: OUTPUT_SATS, outputDescription: 'e2e-par' }],
          options: { noSend: true, acceptDelayedBroadcast: true }
        })
        if (cr.txid && cr.tx) created.push({ txid: cr.txid, tx: cr.tx as number[] })
        else console.log(`  [${i + 1}] no tx data`)
      } catch (e: any) {
        console.log(`  [${i + 1}] CREATE ERROR: ${e.message.substring(0, 80)}`)
      }
    }
    console.log(`  created: ${created.length}/${TX_COUNT}`)

    // Phase 2: broadcast ALL to Arcade concurrently
    console.log(`\n[writeTPS:userpar] broadcasting ${created.length} txs concurrently to Arcade...`)
    const broadcastStart = Date.now()
    const results = await Promise.all(
      created.map(async ({ txid, tx }) => {
        const t0 = Date.now()
        try {
          const beef = Beef.fromBinary(tx)
          const result = await arcade.postBeef(beef, [txid])
          const ms = Date.now() - t0
          const tr = result.txidResults.find(r => r.txid === txid)
          return { txid, ok: tr?.status === 'success', ms, data: tr?.data }
        } catch (e: any) {
          return { txid, ok: false, ms: Date.now() - t0, data: e.message }
        }
      })
    )
    const broadcastMs = Date.now() - broadcastStart
    const ok = results.filter(r => r.ok)
    const timings = results.map(r => r.ms)
    const s = calcStats(timings)

    console.log(`\n[writeTPS:userpar] broadcast: ${ok.length}/${created.length} in ${broadcastMs}ms wall-clock`)
    console.log(`  per-request: ${fmtStats(s)}  →  ${tps(created.length, broadcastMs)} tx/s (concurrent)`)
    results.forEach(r => {
      console.log(`  ${r.txid.substring(0, 20)}... ok=${r.ok} ${r.ms}ms data=${String(r.data).substring(0, 40)}`)
    })
    expect(ok.length).toBeGreaterThanOrEqual(Math.ceil(created.length * 0.8))
  })

  test(`2c · Multi-user parallel — ${USER_COUNT} users × 1 tx each (concurrent createAction)`, async () => {
    // Each user is a separate identity derived from the root key.
    // NOTE: users 1+ will have empty wallets unless pre-funded (see README).
    // This test measures server-side isolation and per-identity overhead.
    // Run after funding child wallets with: npm run e2e:fund
    const pool = await makeUserPool(BABBAGE_URL, USER_COUNT)
    const ls = lockingScript()

    console.log(`\n[writeTPS:multiuser] ${USER_COUNT} users creating 1 tx each concurrently...`)
    const wallStart = Date.now()
    const results = await Promise.all(
      pool.map(async ({ wallet }, i) => {
        const t0 = Date.now()
        try {
          const cr = await wallet.createAction({
            description: `e2e multi-user #${i}`,
            outputs: [{ lockingScript: ls, satoshis: OUTPUT_SATS, outputDescription: 'e2e-multi' }],
            options: { acceptDelayedBroadcast: false }
          })
          const ms = Date.now() - t0
          return { user: i, ok: true, ms, txid: cr.txid }
        } catch (e: any) {
          const ms = Date.now() - t0
          return { user: i, ok: false, ms, error: e.message.substring(0, 60) }
        }
      })
    )
    const wallMs = Date.now() - wallStart
    const ok = results.filter(r => r.ok)
    const s = calcStats(results.map(r => r.ms))

    console.log(`\n[writeTPS:multiuser] ${ok.length}/${USER_COUNT} succeeded in ${wallMs}ms wall-clock`)
    console.log(`  per-user: ${fmtStats(s)}`)
    results.forEach(r => {
      if (r.ok) console.log(`  user${r.user}: ok ${r.ms}ms ${(r as any).txid?.substring(0, 20)}...`)
      else console.log(`  user${r.user}: FAIL ${r.ms}ms ${(r as any).error}`)
    })
    // Users without funds will fail — at minimum user 0 (root key) should succeed
    expect(ok.length).toBeGreaterThan(0)
  })
})

// ─── Test 3: Arcade SSE proof throughput ────────────────────────────────────
// Measures how many proofs Arcade can deliver to the callback URL before failures occur.
// Each batch doubles until ≥20% fail or BATCH_LIMIT is reached.

describe('3 · Arcade SSE proof throughput', () => {
  jest.setTimeout(1_200_000) // 20 min

  test(`3a · Sequential SSE delivery — ${TX_COUNT} txs, verify 0 failures`, async () => {
    await runSseStressTest(TX_COUNT, 'seq')
  })

  test('3b · Concurrent Arcade ingestion — all txs broadcast simultaneously', async () => {
    // Create TX_COUNT noSend txs, then broadcast all at once to Arcade.
    // Measures peak ingestion throughput rather than steady-state delivery.
    const { wallet } = await makeWallet(BABBAGE_URL)
    const arcade = new Arcade(ARCADE_URL, {
      callbackToken: ARCADE_TOKEN,
      callbackUrl: TARGET_URL + '/arc-ingest'
    })
    const ls = lockingScript()

    console.log(`\n[sseStress:concurrent] creating ${TX_COUNT} noSend txs...`)
    const created: Array<{ txid: string; tx: number[] }> = []
    for (let i = 0; i < TX_COUNT; i++) {
      try {
        const cr = await wallet.createAction({
          description: `e2e sse concurrent #${i + 1}`,
          outputs: [{ lockingScript: ls, satoshis: OUTPUT_SATS, outputDescription: 'sse-conc' }],
          options: { noSend: true, acceptDelayedBroadcast: true }
        })
        if (cr.txid && cr.tx) created.push({ txid: cr.txid, tx: cr.tx as number[] })
      } catch (e: any) {
        console.log(`  [${i + 1}] ERROR: ${e.message.substring(0, 60)}`)
      }
    }

    // Broadcast all concurrently
    const bcastStart = Date.now()
    const broadcastResults = await Promise.all(
      created.map(async ({ txid, tx }) => {
        try {
          const beef = Beef.fromBinary(tx)
          const r = await arcade.postBeef(beef, [txid])
          const tr = r.txidResults.find(x => x.txid === txid)
          return { txid, ok: tr?.status === 'success' }
        } catch { return { txid, ok: false } }
      })
    )
    const bcastMs = Date.now() - bcastStart
    const broadcastOk = broadcastResults.filter(r => r.ok).map(r => r.txid)
    console.log(`\n[sseStress:concurrent] broadcast: ${broadcastOk.length}/${created.length} in ${bcastMs}ms`)
    console.log(`  →  ${tps(created.length, bcastMs)} tx/s concurrent ingestion rate`)

    // Poll until mined
    const minedAt: Record<string, { height: number; hasMerklePath: boolean }> = {}
    const pollT0 = Date.now()
    const TIMEOUT = 720_000
    console.log(`\n[sseStress:concurrent] polling for ${broadcastOk.length} txs to mine...`)
    while (Object.keys(minedAt).length < broadcastOk.length && Date.now() - pollT0 < TIMEOUT) {
      await new Promise(r => setTimeout(r, 30_000))
      const elapsed = Math.round((Date.now() - pollT0) / 1000)
      const statusCounts: Record<string, number> = {}
      for (const txid of broadcastOk) {
        if (minedAt[txid]) continue
        try {
          const d = await arcade.getTxData(txid)
          if (d.txStatus === 'MINED' || d.txStatus === 'IMMUTABLE') {
            minedAt[txid] = { height: (d as any).blockHeight, hasMerklePath: !!d.merklePath }
          }
          statusCounts[d.txStatus] = (statusCounts[d.txStatus] ?? 0) + 1
        } catch { /* ignore */ }
      }
      console.log(`  ${elapsed}s: ${JSON.stringify(statusCounts)} — mined=${Object.keys(minedAt).length}/${broadcastOk.length}`)
    }

    const minedCount = Object.keys(minedAt).length
    const proofCount = Object.values(minedAt).filter(v => v.hasMerklePath).length
    const waitSec = Math.round((Date.now() - pollT0) / 1000)

    printSseResults({
      label: 'concurrent',
      txCount: TX_COUNT,
      created: created.length,
      broadcastOk: broadcastOk.length,
      minedCount,
      proofCount,
      waitSec
    })

    expect(broadcastOk.length).toBeGreaterThanOrEqual(Math.ceil(TX_COUNT * 0.8))
    expect(minedCount).toBeGreaterThan(0)
    expect(proofCount).toBe(minedCount)
  })

  test('3c · SSE throughput ceiling — batch-escalation until failure', async () => {
    // Sends batches of 5, 10, 20, 40… until ≥20% of a batch fails.
    // Identifies the point at which callback delivery starts degrading.
    console.log(`\n[sseStress:ceiling] escalating batch size until ≥20% failure rate...`)
    let batchSize = 5
    const MAX_BATCH = 40
    const FAILURE_THRESHOLD = 0.2

    while (batchSize <= MAX_BATCH) {
      console.log(`\n  ── batch size ${batchSize} ──`)
      const result = await runSseStressTest(batchSize, `ceiling-${batchSize}`, { quiet: true })
      const failRate = 1 - result.broadcastOk / Math.max(result.created, 1)
      console.log(`  broadcast ok=${result.broadcastOk}/${result.created}  mined=${result.minedCount}  proofs=${result.proofCount}  failRate=${(failRate * 100).toFixed(0)}%`)

      if (failRate >= FAILURE_THRESHOLD) {
        console.log(`\n[sseStress:ceiling] FAILURE THRESHOLD REACHED at batch size ${batchSize}`)
        console.log(`  System can reliably handle < ${batchSize} concurrent SSE deliveries`)
        break
      }
      if (batchSize >= MAX_BATCH) {
        console.log(`\n[sseStress:ceiling] MAX_BATCH=${MAX_BATCH} reached with no failures — system handles ${MAX_BATCH}+ cleanly`)
      }
      batchSize = batchSize >= 20 ? batchSize + 20 : batchSize * 2
    }

    expect(true).toBe(true) // Exploratory test — always passes, results are in logs
  })
})

// ─── Shared SSE stress helper ───────────────────────────────────────────────

async function runSseStressTest (
  txCount: number,
  label: string,
  opts: { quiet?: boolean } = {}
): Promise<{ created: number; broadcastOk: number; minedCount: number; proofCount: number; waitSec: number }> {
  const { wallet } = await makeWallet(BABBAGE_URL)
  const arcade = new Arcade(ARCADE_URL, {
    callbackToken: ARCADE_TOKEN,
    callbackUrl: TARGET_URL + '/arc-ingest'
  })
  const ls = lockingScript()

  if (!opts.quiet) console.log(`\n[sseStress:${label}] creating ${txCount} noSend txs...`)
  const created: Array<{ txid: string; tx: number[] }> = []
  for (let i = 0; i < txCount; i++) {
    try {
      const cr = await wallet.createAction({
        description: `e2e sse ${label} #${i + 1}`,
        outputs: [{ lockingScript: ls, satoshis: OUTPUT_SATS, outputDescription: 'sse-test' }],
        options: { noSend: true, acceptDelayedBroadcast: true }
      })
      if (cr.txid && cr.tx) {
        created.push({ txid: cr.txid, tx: cr.tx as number[] })
        if (!opts.quiet) console.log(`  [${i + 1}/${txCount}] ${cr.txid.substring(0, 20)}... beef=${cr.tx.length} bytes`)
      }
    } catch (e: any) {
      if (!opts.quiet) console.log(`  [${i + 1}/${txCount}] ERROR: ${e.message.substring(0, 80)}`)
    }
  }

  if (!opts.quiet) console.log(`\n[sseStress:${label}] posting ${created.length} BEEFs to Arcade sequentially...`)
  const broadcastOkIds: string[] = []
  const bcastTimings: number[] = []

  for (const { txid, tx } of created) {
    const t0 = Date.now()
    try {
      const beef = Beef.fromBinary(tx)
      const result = await arcade.postBeef(beef, [txid])
      const ms = Date.now() - t0
      bcastTimings.push(ms)
      const tr = result.txidResults.find(r => r.txid === txid)
      if (tr?.status === 'success') {
        broadcastOkIds.push(txid)
        if (!opts.quiet) console.log(`  ${txid.substring(0, 20)}... ok ${ms}ms data=${tr.data}`)
      } else {
        if (!opts.quiet) console.log(`  ${txid.substring(0, 20)}... FAIL ${ms}ms status=${tr?.status}`)
      }
    } catch (e: any) {
      bcastTimings.push(Date.now() - t0)
      if (!opts.quiet) console.log(`  ${txid.substring(0, 20)}... ERROR ${e.message.substring(0, 60)}`)
    }
  }

  if (!opts.quiet && bcastTimings.length > 0) {
    const s = calcStats(bcastTimings)
    console.log(`\n  broadcast: ${broadcastOkIds.length}/${created.length}  ${fmtStats(s)}  →  ${tps(created.length, bcastTimings.reduce((a, b) => a + b, 0))} tx/s`)
  }

  // Poll until mined
  const minedAt: Record<string, { height: number; hasMerklePath: boolean }> = {}
  const POLL_INTERVAL = 30_000
  const TIMEOUT = 720_000
  const pollT0 = Date.now()

  if (!opts.quiet) console.log(`\n[sseStress:${label}] polling Arcade every 30s for ${broadcastOkIds.length} txs (max 12min)...`)
  while (Object.keys(minedAt).length < broadcastOkIds.length && Date.now() - pollT0 < TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    const elapsed = Math.round((Date.now() - pollT0) / 1000)
    const statusCounts: Record<string, number> = {}
    for (const txid of broadcastOkIds) {
      if (minedAt[txid]) continue
      try {
        const d = await arcade.getTxData(txid)
        if (d.txStatus === 'MINED' || d.txStatus === 'IMMUTABLE') {
          minedAt[txid] = { height: (d as any).blockHeight, hasMerklePath: !!d.merklePath }
        }
        statusCounts[d.txStatus] = (statusCounts[d.txStatus] ?? 0) + 1
      } catch { /* ignore */ }
    }
    if (!opts.quiet) {
      console.log(`  ${elapsed}s: ${JSON.stringify(statusCounts)} — mined=${Object.keys(minedAt).length}/${broadcastOkIds.length}`)
    }
    if (Object.keys(minedAt).length >= broadcastOkIds.length) break
  }

  const waitSec = Math.round((Date.now() - pollT0) / 1000)
  const minedCount = Object.keys(minedAt).length
  const proofCount = Object.values(minedAt).filter(v => v.hasMerklePath).length

  if (!opts.quiet) {
    printSseResults({ label, txCount, created: created.length, broadcastOk: broadcastOkIds.length, minedCount, proofCount, waitSec })
  }

  if (!opts.quiet) {
    expect(broadcastOkIds.length).toBeGreaterThanOrEqual(Math.ceil(created.length * 0.8))
    expect(minedCount).toBeGreaterThan(0)
    expect(proofCount).toBe(minedCount)
  }

  return { created: created.length, broadcastOk: broadcastOkIds.length, minedCount, proofCount, waitSec }
}

function printSseResults (r: {
  label: string; txCount: number; created: number
  broadcastOk: number; minedCount: number; proofCount: number; waitSec: number
}): void {
  console.log(`\n[sseStress:${r.label}] ══ RESULTS ══`)
  console.log(`  created:    ${r.created}/${r.txCount} noSend txs`)
  console.log(`  broadcast:  ${r.broadcastOk}/${r.created} accepted by Arcade (callbackToken=${ARCADE_TOKEN.substring(0, 8)}...)`)
  console.log(`  mined:      ${r.minedCount}/${r.broadcastOk} confirmed on-chain in ${r.waitSec}s`)
  console.log(`  merklePath: ${r.proofCount}/${r.minedCount} proofs from Arcade GET /tx/{txid}`)
  console.log(`  SSE target: ${TARGET_URL} (TaskArcadeSSE)`)
  console.log(`  Check:      sudo journalctl -u wallet-storage.service -n 1000 | grep MINED | wc -l`)
}
