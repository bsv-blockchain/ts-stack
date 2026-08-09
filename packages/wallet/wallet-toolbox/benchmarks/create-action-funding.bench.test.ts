import { Validation } from '@bsv/sdk'
import { performance } from 'node:perf_hooks'
import { _tu } from '../test/utils/TestUtilsWalletStorage'
import { managedChangeOutputFields } from '../src/storage/methods/managedChange'
import { TableOutput, TableOutputBasket, TableTransaction } from '../src/storage/schema/tables'

interface FundingMeasurement {
  candidateCount: number
  selectedInputCount: number
  elapsedMs: number
  queryCount: number
  databaseTransactions: number
}

async function measureFunding (candidateCount: number, outputSatoshis: number): Promise<FundingMeasurement> {
  const ctx = await _tu.createLegacyWalletSQLiteCopy(`createActionFundingBench-${candidateCount}`, 'legacy')
  try {
    ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
    const basket = (await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'default' }
    }))[0] as TableOutputBasket
    await ctx.activeStorage.updateOutputBasket(basket.basketId, {
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 1
    })
    const existing = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, basketId: basket.basketId },
      noScript: true
    })
    for (const output of existing) {
      if (output.spendable) await ctx.activeStorage.updateOutput(output.outputId, { spendable: false })
    }
    const source = (await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId },
      status: ['completed'],
      noRawTx: true
    }))[0] as TableTransaction
    const lockingScript = [0x76, 0xa9, 0x14, ...Array<number>(20).fill(0x11), 0x88, 0xac]
    for (let index = 0; index < candidateCount; index++) {
      const now = new Date()
      const output: TableOutput = {
        outputId: 0,
        userId: ctx.userId,
        transactionId: source.transactionId,
        basketId: basket.basketId,
        spendable: true,
        satoshis: 1_000,
        vout: 10_000 + index,
        txid: source.txid,
        lockingScript,
        scriptLength: lockingScript.length,
        derivationPrefix: 'funding-benchmark-prefix',
        derivationSuffix: `funding-benchmark-${index}`,
        outputDescription: 'fragmented funding benchmark candidate',
        ...managedChangeOutputFields,
        created_at: now,
        updated_at: now
      }
      await ctx.activeStorage.insertOutput(output)
    }

    let queryCount = 0
    let databaseTransactions = 0
    const countQuery = (query: { sql?: string }): void => {
      queryCount++
      if (/^begin\b/i.test(query.sql?.trim() ?? '')) databaseTransactions++
    }
    ctx.activeStorage.knex.on('query', countQuery)
    const args = Validation.validateCreateActionArgs({
      outputs: [{
        satoshis: outputSatoshis,
        lockingScript: '51',
        outputDescription: 'funding benchmark output'
      }],
      description: 'createAction fragmented funding benchmark',
      options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: true }
    })
    const start = performance.now()
    const result = await ctx.activeStorage.createAction({ userId: ctx.userId }, args)
    const elapsedMs = performance.now() - start
    ctx.activeStorage.knex.off('query', countQuery)
    return {
      candidateCount,
      selectedInputCount: result.inputs.length,
      elapsedMs,
      queryCount,
      databaseTransactions
    }
  } finally {
    await ctx.wallet.destroy()
  }
}

describe('createAction fragmented funding benchmark', () => {
  jest.setTimeout(120000)

  test('records representative fragmented funding latency and storage work', async () => {
    const measurements = [
      await measureFunding(20, 5_000),
      await measureFunding(147, 100_000)
    ]
    expect(measurements.every(measurement => measurement.selectedInputCount > 4)).toBe(true)
    expect(measurements.every(measurement => measurement.databaseTransactions === 1)).toBe(true)
    expect(measurements.every(measurement => measurement.queryCount <= 20)).toBe(true)
    process.stdout.write(`${JSON.stringify({ measurements }, null, 2)}\n`)
  })
})
