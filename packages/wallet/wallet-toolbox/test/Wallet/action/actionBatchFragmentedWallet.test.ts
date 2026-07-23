import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { verifyOne } from '../../../src/utility/utilityHelpers'

/**
 * Reproduces the PR#289 batch-funding failure observed end-to-end against a
 * live storage server (see manifests: targetSatoshis pinned while
 * requestedOutputs doubles 8 -> 64, dust reserved every round, large outputs
 * never selected, WERR_INSUFFICIENT_FUNDS despite ample spendable funds).
 *
 * The wallet is fragmented ORGANICALLY: the default basket is configured to
 * desire many small change outputs (144 x 40 sats, mirroring the production
 * wallet that failed) and the wallet's own generateChange then mints the dust
 * through ordinary committed actions. No rows are hand-crafted.
 *
 * Expected (correct) behavior: an un-chained noSend sequence of 16 actions
 * stages successfully in batch mode, exactly as it does in legacy mode on the
 * identical wallet shape (the control test below passes).
 */

const randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]

function noSendArgs (i: number) {
  return {
    description: `fragmented batch action ${i}`,
    outputs: [{
      satoshis: 1,
      lockingScript: '7551',
      outputDescription: 'workload output'
    }],
    options: { noSend: true, randomizeOutputs: false }
  }
}

async function mockChain (ctx: TestWalletNoSetup): Promise<void> {
  _tu.mockPostServicesAsSuccess([ctx])
  jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true } as any)
  jest.spyOn(ctx.activeStorage, 'getServices').mockReturnValue(ctx.services)
  // Production fee regime (the test fixture defaults to sat/kb 1, under which
  // dust inputs are never fee-negative and the funding loop is never stressed).
  ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
}

/**
 * Reshape the default basket to desire a large pool of small change outputs,
 * then let the wallet's own change generator fragment the pool via ordinary,
 * immediately-processed actions. Returns the resulting spendable change set.
 */
async function fragmentWallet (ctx: TestWalletNoSetup): Promise<number[]> {
  const basket = verifyOne(await ctx.activeStorage.findOutputBaskets({
    partial: { userId: 1, name: 'default' }
  }))
  await ctx.activeStorage.updateOutputBasket(basket.basketId, {
    numberOfDesiredUTXOs: 144,
    minimumDesiredUTXOValue: 40
  })

  for (let i = 0; i < 20; i++) {
    await ctx.wallet.createAction({
      description: `fragmentation churn ${i}`,
      outputs: [{ satoshis: 1, lockingScript: '7551', outputDescription: 'churn output' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
  }

  const outputs = await ctx.activeStorage.findOutputs({
    partial: { userId: 1, basketId: basket.basketId, change: true, spendable: true }
  })
  return outputs.map(o => o.satoshis).sort((a, b) => b - a)
}

describe('action batch funding on a fragmented wallet', () => {
  jest.setTimeout(300000)

  test('batch mode: un-chained noSend sequence of 16 selects viable funding and commits', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('fragmentedBatchFunding', 'auto')
    try {
      await mockChain(ctx)
      ctx.wallet.randomVals = [...randomVals]

      const sats = await fragmentWallet(ctx)
      const dust = sats.filter(s => s < 100)
      const healthy = sats.filter(s => s >= 1000)
      const total = sats.reduce((s, v) => s + v, 0)
      // Sanity: the wallet is fragmented but amply funded, with healthy
      // outputs available - the same shape as the production wallet that
      // failed (63k sats, 150 dust outputs, 5 healthy outputs).
      expect(dust.length).toBeGreaterThanOrEqual(50)
      expect(healthy.length).toBeGreaterThanOrEqual(1)
      expect(total).toBeGreaterThan(100000)

      // Capture extension requests and the funding candidates they return.
      const extendCalls: Array<{
        targetSatoshis: number
        requestedOutputs: number
        reservedSatoshis: number[]
      }> = []
      const origExtend = ctx.storage.extendActionBatch.bind(ctx.storage)
      jest.spyOn(ctx.storage, 'extendActionBatch').mockImplementation(async (args: any) => {
        const result = await origExtend(args)
        extendCalls.push({
          targetSatoshis: args.targetSatoshis,
          requestedOutputs: args.requestedOutputs,
          reservedSatoshis: result.reservedOutputs.map(output => output.satoshis)
        })
        return result
      })

      const txids: string[] = []
      for (let i = 0; i < 16; i++) {
        const result = await ctx.wallet.createAction(noSendArgs(i))
        txids.push(result.txid!)
      }
      expect(txids).toHaveLength(16)
      expect(extendCalls.flatMap(call => call.reservedSatoshis).some(satoshis => satoshis >= 1000)).toBe(true)
      expect(extendCalls.every(call => call.targetSatoshis <= total)).toBe(true)
      const commit = await ctx.wallet.createAction({
        description: 'commit fragmented batch sequence',
        options: { sendWith: txids, acceptDelayedBroadcast: false }
      })
      expect(commit.sendWithResults).toHaveLength(16)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('legacy mode control: identical fragmented wallet, identical un-chained sequence, succeeds', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('fragmentedLegacyControl', 'legacy')
    try {
      await mockChain(ctx)
      ctx.wallet.randomVals = [...randomVals]

      const sats = await fragmentWallet(ctx)
      expect(sats.filter(s => s < 100).length).toBeGreaterThanOrEqual(50)

      const txids: string[] = []
      for (let i = 0; i < 16; i++) {
        const result = await ctx.wallet.createAction(noSendArgs(i))
        txids.push(result.txid!)
      }
      expect(txids).toHaveLength(16)

      const commit = await ctx.wallet.createAction({
        description: 'commit legacy control sequence',
        options: { sendWith: txids, acceptDelayedBroadcast: false }
      })
      expect(commit.sendWithResults).toHaveLength(16)
    } finally {
      await ctx.wallet.destroy()
    }
  })

  test('fee-negative dust is not reserved after the fee rate rises', async () => {
    const ctx = await _tu.createLegacyWalletSQLiteCopy('fragmentedBatchFeeRise', 'auto')
    try {
      await mockChain(ctx)
      ctx.wallet.randomVals = [...randomVals]
      const sats = await fragmentWallet(ctx)
      expect(sats.filter(satoshis => satoshis < 100).length).toBeGreaterThanOrEqual(50)

      ctx.activeStorage.feeModel = { model: 'sat/kb', value: 500 }
      const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
      const staged = await ctx.wallet.createAction(noSendArgs(0))
      const begun = await begin.mock.results[0].value
      expect(begun.reservedOutputs).not.toHaveLength(0)
      expect(begun.reservedOutputs.every(output => output.satoshis >= 100)).toBe(true)
      if (staged.txid == null) throw new Error('staged batch action is missing its txid')

      const commit = await ctx.wallet.createAction({
        description: 'commit batch after fee-rate increase',
        options: { sendWith: [staged.txid], acceptDelayedBroadcast: false }
      })
      expect(commit.sendWithResults).toHaveLength(1)
    } finally {
      await ctx.wallet.destroy()
    }
  })
})
