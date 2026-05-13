import { _tu, TestSetup1Wallet } from '../utils/TestUtilsWalletStorage'
import { TaskCheckNoSends } from '../../src/monitor/tasks/TaskCheckNoSends'
import { TableProvenTxReq } from '../../src/storage/schema/tables/TableProvenTxReq'
import { doubleSha256BE } from '../../src/utility/utilityHelpers'
import { asString } from '../../src/utility/utilityHelpers.noBuffer'

/**
 * Regression coverage for the freshness gate on the `checkNow` path of
 * `TaskCheckNoSends`.
 *
 * Background. PR #122's WT-4 fix wires `TaskCheckNoSends.checkNow = true`
 * into `Monitor.processNewBlockHeader`, so the task fires on every new
 * block header instead of only on its scheduled daily cadence. That is
 * exactly what's wanted for externally-broadcast `nosend` txs (the
 * task's original docstring use case). But it also means `nosend` rows
 * that are part of an in-flight batched-tx workflow — chained
 * `createAction({ noSend: true, sendWith: [...] })` builds, broadcast
 * all-at-once by the terminator — get chain-checked on every block
 * while the batch is being built. Each row triggers a remote
 * `getMerklePath` call that returns "not found" (because the row isn't
 * on chain yet by design); wasted round-trips.
 *
 * Mitigation. When `TaskCheckNoSends.runTask` is triggered by the
 * `checkNow` path, skip rows whose `created_at` is newer than
 * `TaskCheckNoSends.checkNowFreshnessSkipMsecs`. The scheduled daily
 * cadence is unaffected so externally-broadcast unmined txs are still
 * eventually caught.
 *
 * Tests below seed `nosend` rows with explicit `created_at` values
 * (fresh = now, old = 1 hour ago) and verify the gate via a mocked
 * `monitor.services.getMerklePath` call counter:
 *  - Fresh row + checkNow → getMerklePath NOT called for it
 *  - Old row + checkNow → getMerklePath IS called for it
 *  - Mixed + checkNow → getMerklePath called only for old
 *  - Fresh row + daily cadence (no checkNow) → getMerklePath IS called
 *    (filter only applies to block-triggered path)
 */
describe('TaskCheckNoSends freshness gate (PR #122 follow-up to tonesnotes comment)', () => {
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
    // Inject a `lastNewHeader` so `runTask` doesn't bail before the
    // findProvenTxReqs loop.
    ;(ctx.wallet.monitor as any).lastNewHeader = {
      version: 1,
      previousHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64),
      time: Math.floor(Date.now() / 1000),
      bits: 0x1d00ffff,
      nonce: 0,
      height: 800000,
      hash: 'c'.repeat(64)
    }
  })

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

  test('checkNow path: fresh nosend row is SKIPPED (no getMerklePath call)', async () => {
    const { txid } = await seedNoSendReqWithAge([0xaa, 0xaa, 0xaa, 0xaa], new Date())
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  test('checkNow path: old nosend row IS chain-checked (getMerklePath called)', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const { txid } = await seedNoSendReqWithAge([0xbb, 0xbb, 0xbb, 0xbb], oneHourAgo)
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  test('checkNow path: mixed ages → getMerklePath called for old txids only', async () => {
    const { txid: freshTxid } = await seedNoSendReqWithAge([0xcc, 0xcc, 0xcc, 0xcc], new Date())
    const { txid: oldTxid } = await seedNoSendReqWithAge(
      [0xdd, 0xdd, 0xdd, 0xdd],
      new Date(Date.now() - 60 * 60 * 1000)
    )
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(oldTxid)
    expect(getMerklePathSpy).not.toHaveBeenCalledWith(freshTxid)
  })

  test('daily cadence (no checkNow): fresh nosend row IS chain-checked (filter only applies to checkNow)', async () => {
    const { txid } = await seedNoSendReqWithAge([0xee, 0xee, 0xee, 0xee], new Date())
    // NOTE: TaskCheckNoSends.checkNow stays false — simulates scheduled
    // daily cadence trigger rather than block-header trigger.

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })

  test('checkNow path: row at the boundary is NOT skipped (filter uses <= cutoff)', async () => {
    // Row created at exactly `now - checkNowFreshnessSkipMsecs - 1ms`
    // should be eligible — filter is `r.created_at.getTime() <=
    // freshnessCutoff` where `freshnessCutoff = Date.now() - skipMsecs`.
    const exactlyAtBoundary = new Date(
      Date.now() - TaskCheckNoSends.checkNowFreshnessSkipMsecs - 1
    )
    const { txid } = await seedNoSendReqWithAge([0xff, 0xff, 0xff, 0xff], exactlyAtBoundary)
    TaskCheckNoSends.checkNow = true

    await task.runTask()

    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)
  })
})
