import { _tu, TestSetup1Wallet } from '../utils/TestUtilsWalletStorage'
import { Monitor } from '../../src/monitor/Monitor'
import { TaskCheckForProofs } from '../../src/monitor/tasks/TaskCheckForProofs'
import { TaskCheckNoSends } from '../../src/monitor/tasks/TaskCheckNoSends'
import { BlockHeader } from '../../src/sdk/WalletServices.interfaces'
import { genesisHeader } from '../../src/services/chaintracker/chaintracks/util/blockHeaderUtilities'

/**
 * Regression coverage for the nosend-lifecycle defense — Fix 2 of 4.
 *
 * `Monitor.processNewBlockHeader` is called by Chaintracks's
 * new-block-header listener (via the queued TaskNewHeader path). Before
 * this fix it nudged `TaskCheckForProofs.checkNow = true` but did NOT
 * nudge `TaskCheckNoSends.checkNow`. The TaskCheckNoSends source has
 * always carried a comment documenting the intended hook
 * ("An external service such as the chaintracks new block header
 * listener can set this true to cause [it to run]") but no code in
 * the repo actually set it.
 *
 * Empirical effect of the missing wire-up: `TaskCheckNoSends` runs
 * only on its `triggerMsecs = oneDay` cadence, which combined with
 * intermittent wallet uptime means `nosend` reqs from externally
 * broadcast txs have no reliable retirement path. Field DB of a
 * production wallet that operated for 8 days shows 5,681 monitor_events
 * across other tasks (TaskCheckForProofs fired 6 times, ReviewProvenTxs
 * 2215 times, etc.) and ZERO CheckNoSends events.
 *
 * The fix is one line in `processNewBlockHeader`:
 *   `TaskCheckNoSends.checkNow = true`
 *
 * placed alongside the existing `TaskCheckForProofs.checkNow = true`
 * nudge. This test verifies both flags transition to true after a
 * new-header notification.
 */
describe('Monitor.processNewBlockHeader nudges TaskCheckNoSends.checkNow', () => {
  jest.setTimeout(60000)

  let ctx: TestSetup1Wallet
  let monitor: Monitor

  beforeAll(async () => {
    ctx = await _tu.createSQLiteTestSetup1Wallet({
      databaseName: 'processNewBlockHeaderTests',
      chain: 'main',
      rootKeyHex: '4'.repeat(64)
    })
    monitor = ctx.wallet.monitor!
  })

  afterAll(async () => {
    await ctx.storage.destroy()
  })

  beforeEach(() => {
    // Reset both static flags so the assertions are independent.
    TaskCheckForProofs.checkNow = false
    TaskCheckNoSends.checkNow = false
  })

  test('sets TaskCheckNoSends.checkNow = true alongside TaskCheckForProofs.checkNow = true', () => {
    const header: BlockHeader = genesisHeader('main')

    expect(TaskCheckForProofs.checkNow).toBe(false)
    expect(TaskCheckNoSends.checkNow).toBe(false)

    monitor.processNewBlockHeader(header)

    expect(TaskCheckForProofs.checkNow).toBe(true)
    expect(TaskCheckNoSends.checkNow).toBe(true)
    expect(monitor.lastNewHeader).toEqual(header)
    expect(monitor.lastNewHeader).not.toBe(header)
  })

  test('multiple consecutive new-header notifications keep TaskCheckNoSends.checkNow asserted', () => {
    const baseHeader: BlockHeader = genesisHeader('main')
    monitor.processNewBlockHeader(baseHeader)
    expect(TaskCheckNoSends.checkNow).toBe(true)

    // Even if TaskCheckNoSends.runTask clears the flag mid-cycle, the
    // next new-header should re-assert it. Simulate clearing.
    TaskCheckNoSends.checkNow = false

    const nextHeader: BlockHeader = { ...baseHeader }
    monitor.processNewBlockHeader(nextHeader)
    expect(TaskCheckNoSends.checkNow).toBe(true)
    expect(monitor.lastNewHeader).toEqual(nextHeader)
    expect(monitor.lastNewHeader).not.toBe(nextHeader)
  })
})
