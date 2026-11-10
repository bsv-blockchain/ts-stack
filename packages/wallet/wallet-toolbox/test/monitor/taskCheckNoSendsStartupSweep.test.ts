import { _tu, TestSetup1Wallet } from '../utils/TestUtilsWalletStorage'
import { TaskCheckNoSends } from '../../src/monitor/tasks/TaskCheckNoSends'
import { TableProvenTxReq } from '../../src/storage/schema/tables/TableProvenTxReq'
import { doubleSha256BE } from '../../src/utility/utilityHelpers'
import { asString } from '../../src/utility/utilityHelpers.noBuffer'

/**
 * The scheduled (unfiltered) sweep is the fallback that catches `nosend` rows the block-triggered
 * aging schedule defers. It must not be spent before the first block header is processed (when
 * `runTask` can only return early); once due it must stay unfiltered even though a block has also
 * set `checkNow`; and block-triggered runs, which the Monitor records as runs of this task, must not
 * keep postponing it.
 */
describe('TaskCheckNoSends scheduled sweep', () => {
  jest.setTimeout(60000)

  let ctx: TestSetup1Wallet
  let getMerklePathSpy: jest.Mock
  let originalGetMerklePath: unknown

  beforeAll(async () => {
    ctx = await _tu.createSQLiteTestSetup1Wallet({
      databaseName: 'taskCheckNoSendsStartupSweepTests',
      chain: 'main',
      rootKeyHex: '6'.repeat(64)
    })
    originalGetMerklePath = (ctx.wallet.monitor as any).services.getMerklePath
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    ;(ctx.wallet.monitor as any).services.getMerklePath = originalGetMerklePath
    ;(ctx.wallet.monitor as any).lastNewHeader = undefined
    TaskCheckNoSends.checkNow = false
    await ctx.storage.destroy()
  })

  beforeEach(() => {
    TaskCheckNoSends.checkNow = false
    ;(ctx.wallet.monitor as any).lastNewHeader = undefined
    getMerklePathSpy = jest.fn(async () => ({ name: 'mock' }))
    ;(ctx.wallet.monitor as any).services.getMerklePath = getMerklePathSpy
  })

  /** What Monitor.processNewBlockHeader leaves behind: a known height and checkNow set. */
  function processHeader(height: number): void {
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
    TaskCheckNoSends.checkNow = true
  }

  /** A block height at which the aging schedule skips this tier-2 row. */
  function ineligibleTier2Height(provenTxReqId: number): number {
    const interval = TaskCheckNoSends.tier2BlockInterval
    const base = 800000
    return base + ((interval - ((base + provenTxReqId) % interval)) % interval) + 1
  }

  async function seedTwoHourOldNoSend(rawTx: number[]): Promise<{ provenTxReqId: number; txid: string }> {
    const txid = asString(doubleSha256BE(rawTx))
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const req: TableProvenTxReq = {
      created_at: createdAt,
      updated_at: createdAt,
      provenTxReqId: 0,
      txid,
      status: 'nosend',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx
    }
    const provenTxReqId = await ctx.storage.runAsStorageProvider(async sp => {
      await sp.insertProvenTxReq(req)
      return (await sp.findProvenTxReqs({ partial: { txid } }))[0].provenTxReqId
    })
    return { provenTxReqId, txid }
  }

  test('the due sweep is not triggered before a block header is known', () => {
    const task = new TaskCheckNoSends(ctx.wallet.monitor!)
    expect(task.lastRunMsecsSinceEpoch).toBe(0)

    expect(task.trigger(Date.now()).run).toBe(false)
  })

  test('the first processed header runs the sweep unfiltered; later blocks use the aging schedule', async () => {
    const task = new TaskCheckNoSends(ctx.wallet.monitor!)
    const { provenTxReqId, txid } = await seedTwoHourOldNoSend([0xd5, 0x00, 0x00, 0x01])
    const height = ineligibleTier2Height(provenTxReqId)

    // start: no header yet
    expect(task.trigger(Date.now()).run).toBe(false)

    // the first header is processed: the sweep is due and must not be filtered by the schedule
    processHeader(height)
    expect(task.trigger(Date.now()).run).toBe(true)
    await task.runTask()
    task.lastRunMsecsSinceEpoch = Date.now() // as Monitor.runScheduledTask does
    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)

    // the next block, at a height where the schedule skips this row: filtered again
    getMerklePathSpy.mockClear()
    processHeader(height + TaskCheckNoSends.tier2BlockInterval)
    expect(task.trigger(Date.now()).run).toBe(true)
    await task.runTask()
    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })

  test('block-triggered runs do not postpone the next scheduled sweep', async () => {
    const realNow = Date.now.bind(Date)
    let offset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const triggerMsecs = 60 * 60 * 1000
    const task = new TaskCheckNoSends(ctx.wallet.monitor!, triggerMsecs)
    const { provenTxReqId, txid } = await seedTwoHourOldNoSend([0xd5, 0x00, 0x00, 0x02])
    const height = ineligibleTier2Height(provenTxReqId)

    // what Monitor.runOnce and runScheduledTask do for one cycle
    async function cycle(): Promise<boolean> {
      if (!task.trigger(Date.now()).run) return false
      await task.runTask()
      task.lastRunMsecsSinceEpoch = Date.now()
      return true
    }

    // the first sweep, at the first processed header
    processHeader(height)
    await cycle()
    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)

    // a block every ten minutes for longer than triggerMsecs, each at a height the schedule skips
    let sweptAgain = false
    for (let minutes = 10; minutes <= 70; minutes += 10) {
      offset = minutes * 60 * 1000
      getMerklePathSpy.mockClear()
      processHeader(height + TaskCheckNoSends.tier2BlockInterval * (minutes / 10))
      await cycle()
      const checked = getMerklePathSpy.mock.calls.some(call => call[0] === txid)
      if (minutes < 60) expect(checked).toBe(false)
      if (checked) sweptAgain = true
    }
    expect(sweptAgain).toBe(true)
  })

  test('the timer alone triggers the next sweep, with no block in between', async () => {
    const realNow = Date.now.bind(Date)
    let offset = 0
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    const triggerMsecs = 60 * 60 * 1000
    const task = new TaskCheckNoSends(ctx.wallet.monitor!, triggerMsecs)
    const { provenTxReqId, txid } = await seedTwoHourOldNoSend([0xd5, 0x00, 0x00, 0x04])

    processHeader(ineligibleTier2Height(provenTxReqId))
    expect(task.trigger(Date.now()).run).toBe(true)
    await task.runTask() // the first sweep
    task.lastRunMsecsSinceEpoch = Date.now()
    getMerklePathSpy.mockClear()

    // the header stays known and no block sets checkNow
    offset = triggerMsecs - 1000
    expect(task.trigger(Date.now()).run).toBe(false)

    offset = triggerMsecs + 1000
    expect(task.trigger(Date.now()).run).toBe(true)
    await task.runTask()
    task.lastRunMsecsSinceEpoch = Date.now()
    expect(getMerklePathSpy).toHaveBeenCalledWith(txid)

    // not due again straight away
    expect(task.trigger(Date.now()).run).toBe(false)
  })

  test('a block-triggered run alone keeps the aging schedule', async () => {
    const task = new TaskCheckNoSends(ctx.wallet.monitor!)
    const { provenTxReqId, txid } = await seedTwoHourOldNoSend([0xd5, 0x00, 0x00, 0x03])
    const height = ineligibleTier2Height(provenTxReqId)
    processHeader(height)
    task.trigger(Date.now())
    await task.runTask() // the first sweep

    getMerklePathSpy.mockClear()
    processHeader(height + TaskCheckNoSends.tier2BlockInterval)
    expect(task.trigger(Date.now()).run).toBe(true)
    await task.runTask()

    expect(getMerklePathSpy).not.toHaveBeenCalledWith(txid)
  })
})
