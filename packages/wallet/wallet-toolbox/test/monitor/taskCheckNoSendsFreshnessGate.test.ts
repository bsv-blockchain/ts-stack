import { _tu, TestSetup1Wallet } from '../utils/TestUtilsWalletStorage'
import { TaskCheckNoSends } from '../../src/monitor/tasks/TaskCheckNoSends'
import { TableProvenTxReq } from '../../src/storage/schema/tables/TableProvenTxReq'
import { doubleSha256BE } from '../../src/utility/utilityHelpers'
import { asString } from '../../src/utility/utilityHelpers.noBuffer'

/**
 * Regression coverage for the aging-schedule gate on the `checkNow`
 * path of `TaskCheckNoSends` (PR #122 follow-up addressing tonesnotes's
 * review comments on Fix 2).
 *
 * Background. PR #122's WT-4 fix wires `TaskCheckNoSends.checkNow = true`
 * into `Monitor.processNewBlockHeader`, so the task fires on every new
 * block header instead of only on its scheduled daily cadence. Tone
 * flagged two concerns that this naive wire-up created:
 *   (a) batched-tx workflows (chained `createAction({ noSend: true,
 *       sendWith: [...] })`) get every participating row chain-checked
 *       on every block while the batch is being built.
 *   (b) long-running wallets accumulate large sets of `nosend` rows
 *       (escrow, abandoned tests, etc.) — unfiltered every-block scans
 *       create unbounded external-service cost.
 *
 * Mitigation: on the checkNow path, decide per-row whether to chain-check
 * based on a tiered aging schedule:
 *
 *   age < 5 min                 → SKIP (addresses (a))
 *   5 min ≤ age < 1 hr          → every checkNow trigger
 *   1 hr   ≤ age < 24 hr        → ~hourly (block_height % 6 === 0)
 *   24 hr  ≤ age < 7 days       → ~daily  (block_height % 144 === 0)
 *   age ≥ 7 days                → ~weekly (block_height % 1008 === 0)
 *
 * The scheduled daily cadence (no checkNow) is unaffected — it scans
 * every row regardless of age (addresses (b)'s edge case where the
 * aging schedule defers a row indefinitely; the daily fallback
 * guarantees eventual recognition).
 *
 * Tests below verify the gate via a mocked `monitor.services.getMerklePath`
 * call counter against rows seeded with explicit `created_at` and explicit
 * block-height in `monitor.lastNewHeader`.
 */
describe('TaskCheckNoSends aging schedule (PR #122 follow-up to tonesnotes comments)', () => {
  jest.setTimeout(60000)

  let ctx: TestSetup1Wallet
  let task: TaskCheckNoSends
  let getMerklePathSpy: jest.Mock
  let originalGetMerklePath: unknown

  beforeAll(async () => {
    ctx = await _tu.createSQLiteTestSetup1Wallet({
      databaseName: 'taskCheckNoSendsFreshnessGateTests',
      chain: 'main',
      rootKeyHex: '5'.repeat(64)
    })
    task = new TaskCheckNoSends(ctx.wallet.monitor!)
  })

  /**
   * Set the current block-height that the task observes. Tests use this
   * to control whether `(blockHeight + provenTxReqId) % tierInterval === 0`
   * for a specific seeded row.
   */
  function setBlockHeight (height: number) {
    ;(ctx.wallet.monitor as any).lastNewHeader = {
      version: 1,
      previousHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64),
      time: Math.floor(Date.now() / 1000),
      bits: 0x1d00ffff,
      nonce: 0,
      height,
      hash: 'c'.repeat(64)
    }
  }

  /**
   * Compute a block-height that makes `(height + provenTxReqId) %
   * tierInterval === 0` for the given row, i.e., row is eligible for
   * chain check at that block. Picks a height near 800000 for realism.
   */
  function eligibleBlockHeight (provenTxReqId: number, tierInterval: number): number {
    const base = 800000
    const offset = (tierInterval - ((base + provenTxReqId) % tierInterval)) % tierInterval
    return base + offset
  }

  /**
   * Inverse of eligibleBlockHeight: returns a block-height where the
   * given row is NOT eligible (one block past eligibility).
   */
  function ineligibleBlockHeight (provenTxReqId: number, tierInterval: number): number {
    return eligibleBlockHeight(provenTxReqId, tierInterval) + 1
  }

  afterAll(async () => {
    if (originalGetMerklePath !== undefined) {
      ;(ctx.wallet.monitor as any).services.getMerklePath = originalGetMerklePath
    }
    await ctx.storage.destroy()
  })

  beforeEach(async () => {
    // Clear any nosend rows from prior tests so each case is isolated.
    // Cheap because the test SQLite is in-process + small.
    await ctx.storage.runAsStorageProvider(async sp => {
      const existing = await sp.findProvenTxReqs({
        partial: {},
        status: ['nosend']
      })
      for (const r of existing) {
        // Mark each as 'invalid' so the next runTask won't pick them up.
        await sp.updateProvenTxReq(r.provenTxReqId, { status: 'invalid' })
      }
    })

    // Reset checkNow flag so each test controls it explicitly.
    TaskCheckNoSends.checkNow = false

    // Mock getMerklePath to count calls and return a "no proof found"
    // shape (which getProofs handles as "leave row alone").
    if (originalGetMerklePath === undefined) {
      originalGetMerklePath = (ctx.wallet.monitor as any).services.getMerklePath
    }
    getMerklePathSpy = jest.fn(async () => ({ name: 'mock' }))
    ;(ctx.wallet.monitor as any).services.getMerklePath = getMerklePathSpy
  })

  /**
   * Seed a `nosend` proven_tx_req with an explicit `created_at` so we
   * can drive the freshness gate without timing dependencies.
   *
   * Note: `getProofs` (called by `TaskCheckNoSends.runTask`) validates
   * that `doubleSha256BE(rawTx) === txid` before attempting any chain
   * check (TaskCheckForProofs.ts:138-150). Tests must therefore use
   * matching pairs — we derive txid from rawTx here. Each test passes
   * a unique `rawTxSeed` to get a unique txid.
   */
  function txidFromRawTx (rawTx: number[]): string {
    return asString(doubleSha256BE(rawTx))
  }

  async function seedNoSendReqWithAge (
    rawTxSeed: number[],
    createdAt: Date
  ): Promise<{ provenTxReqId: number; txid: string }> {
    const txid = txidFromRawTx(rawTxSeed)
    const ptxreq: TableProvenTxReq = {
      created_at: createdAt,
      updated_at: createdAt,
      provenTxReqId: 0,
      txid,
      status: 'nosend',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx: rawTxSeed
    }
    const provenTxReqId = await ctx.storage.runAsStorageProvider(async sp => {
      await sp.insertProvenTxReq(ptxreq)
      const found = await sp.findProvenTxReqs({ partial: { txid } })
      return found[0].provenTxReqId
    })
    return { provenTxReqId, txid }
  }

  // ── Tier 0 (< 5 min): SKIP on checkNow ─────────────────────────────

  test('tier 0 (< 5 min): fresh row SKIPPED on checkNow', async () => {
    setBlockHeight(800000)
    const { txid } = await seedNoSendReqWithAge([0xaa, 0x00, 0x00, 0x00], new Date())
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  // ── Tier 1 (5 min – 1 hr): every checkNow ───────────────────────────

  test('tier 1 (5min - 1hr): row CHECKED on every checkNow trigger regardless of block height', async () => {
    setBlockHeight(800001) // arbitrary; tier 1 doesn't gate on modulo
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000)
    const { txid } = await seedNoSendReqWithAge([0xbb, 0x00, 0x00, 0x00], thirtyMinAgo)
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  // ── Tier 2 (1hr – 24hr): ~hourly cadence with per-row staggering ───

  test('tier 2 (1hr - 24hr): row CHECKED when (height + provenTxReqId) % 6 === 0', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xcc, 0x00, 0x00, 0x00], twoHoursAgo)
    setBlockHeight(eligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier2BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  test('tier 2 (1hr - 24hr): row SKIPPED when (height + provenTxReqId) % 6 !== 0', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xcc, 0x11, 0x00, 0x00], twoHoursAgo)
    setBlockHeight(ineligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier2BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  // ── Tier 3 (24hr – 7d): ~daily cadence with per-row staggering ─────

  test('tier 3 (24hr - 7d): row CHECKED when (height + provenTxReqId) % 144 === 0', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xdd, 0x00, 0x00, 0x00], threeDaysAgo)
    setBlockHeight(eligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier3BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  test('tier 3 (24hr - 7d): row SKIPPED when (height + provenTxReqId) % 144 !== 0', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xdd, 0x11, 0x00, 0x00], threeDaysAgo)
    setBlockHeight(ineligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier3BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  // ── Tier 4 (≥ 7d): ~weekly cadence with per-row staggering ─────────

  test('tier 4 (≥ 7d): row CHECKED when (height + provenTxReqId) % 1008 === 0', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xee, 0x00, 0x00, 0x00], tenDaysAgo)
    setBlockHeight(eligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier4BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  test('tier 4 (≥ 7d): row SKIPPED when (height + provenTxReqId) % 1008 !== 0', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const { txid, provenTxReqId } = await seedNoSendReqWithAge([0xee, 0x11, 0x00, 0x00], tenDaysAgo)
    setBlockHeight(ineligibleBlockHeight(provenTxReqId, TaskCheckNoSends.tier4BlockInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  // ── Per-row staggering — same-tier rows fire on different blocks ───

  test('staggering: two same-tier rows fire on different blocks (provenTxReqId-keyed offset)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const seedA = await seedNoSendReqWithAge([0xab, 0x00, 0x00, 0x00], twoHoursAgo)
    const seedB = await seedNoSendReqWithAge([0xab, 0x11, 0x00, 0x00], twoHoursAgo)

    // Confirm the IDs differ in the tier-2 modulo class — otherwise both
    // would inherently fire together regardless of staggering logic.
    const tierInterval = TaskCheckNoSends.tier2BlockInterval
    expect(seedA.provenTxReqId % tierInterval).not.toBe(seedB.provenTxReqId % tierInterval)

    // Set the block height so seedA is eligible but seedB is NOT.
    setBlockHeight(eligibleBlockHeight(seedA.provenTxReqId, tierInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(seedA.txid)
    expect(getMerklePathSpy).not.toHaveBeenCalledWith(seedB.txid)
  })

  // ── Mixed tiers on a single block ──────────────────────────────────

  test('mixed tiers on a single block: tier-1 always checked; older tiers depend on stagger', async () => {
    const tierInterval = TaskCheckNoSends.tier2BlockInterval
    const { txid: tier0Txid } = await seedNoSendReqWithAge([0xa0, 0x00, 0x00, 0x00], new Date())
    const { txid: tier1Txid } = await seedNoSendReqWithAge(
      [0xa1, 0x00, 0x00, 0x00],
      new Date(Date.now() - 30 * 60 * 1000)
    )
    const seedTier2 = await seedNoSendReqWithAge(
      [0xa2, 0x00, 0x00, 0x00],
      new Date(Date.now() - 2 * 60 * 60 * 1000)
    )

    // Pick a block where the tier-2 row is INELIGIBLE per its stagger.
    setBlockHeight(ineligibleBlockHeight(seedTier2.provenTxReqId, tierInterval))
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    // Tier 0 always skipped. Tier 1 always checked. Tier 2 skipped here.
    expect(getMerklePathSpy).not.toHaveBeenCalledWith(tier0Txid)
    expect(getMerklePathSpy).toHaveBeenCalledWith(tier1Txid)
    expect(getMerklePathSpy).not.toHaveBeenCalledWith(seedTier2.txid)
  })

  // ── Daily cadence (no checkNow) — unaffected by aging schedule ─────

  test('daily cadence (no checkNow): all rows CHECKED regardless of tier or block_height', async () => {
    setBlockHeight(800003) // any height — daily path doesn't gate on it
    const { txid: tier0 } = await seedNoSendReqWithAge([0xb0, 0x00, 0x00, 0x00], new Date())
    const { txid: tier4 } = await seedNoSendReqWithAge(
      [0xb4, 0x00, 0x00, 0x00],
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    )
    // NOTE: TaskCheckNoSends.checkNow stays false — simulates scheduled
    // daily cadence trigger.

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(tier0)
    expect(getMerklePathSpy).toHaveBeenCalledWith(tier4)
  })

  // ── Tier-boundary sanity ───────────────────────────────────────────

  test('tier-boundary: row at exactly tier0FreshSkipMsecs is in tier 1 (CHECKED)', async () => {
    setBlockHeight(800001)
    const atBoundary = new Date(
      Date.now() - TaskCheckNoSends.tier0FreshSkipMsecs - 1
    )
    const { txid } = await seedNoSendReqWithAge([0xc0, 0x00, 0x00, 0x00], atBoundary)
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })
})
