import { TelemetryEvent, Validation } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageKnex } from '../StorageKnex'
import { TableOutput, TableOutputBasket, TableTransaction } from '../schema/tables'
import { managedChangeOutputFields } from '../methods/managedChange'

describe('createAction funding performance', () => {
  jest.setTimeout(120000)
  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(
      expect.getState().currentTestName ?? 'createActionPerformance',
      'legacy'
    )
    ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
  })

  afterEach(async () => {
    await ctx.wallet.destroy()
  })

  test('claims a fragmented funding plan in one database transaction', async () => {
    await replaceFundingCandidates(20, 1_000)
    let databaseTransactions = 0
    const countTransactions = (query: { sql?: string }): void => {
      if (/^begin\b/i.test(query.sql?.trim() ?? '')) databaseTransactions++
    }
    ctx.activeStorage.knex.on('query', countTransactions)
    const markSpent = jest.spyOn(ctx.activeStorage, 'markChangeInputsSpent')
    const readStatuses = jest.spyOn(ctx.activeStorage, 'findTransactionStatusesByIds')
    try {
      const result = await ctx.activeStorage.createAction(
        { userId: ctx.userId },
        actionArgs(5_000)
      )

      expect(result.inputs.length).toBeGreaterThan(4)
      expect(markSpent).toHaveBeenCalledTimes(1)
      expect(markSpent.mock.calls[0][0]).toHaveLength(result.inputs.length)
      expect(readStatuses).toHaveBeenCalledTimes(1)
      expect(readStatuses.mock.calls[0][1]).toHaveLength(1)
      expect(databaseTransactions).toBe(1)
    } finally {
      ctx.activeStorage.knex.off('query', countTransactions)
    }
  })

  test('hydrates offloaded funding scripts once per source and outside the locked lookup', async () => {
    await replaceFundingCandidates(20, 1_000, true)
    const lockedLookup = jest.spyOn(ctx.activeStorage, 'findOutputsByOutpointsForUpdate')
    const getRawTx = jest.spyOn(ctx.activeStorage, 'getRawTxOfKnownValidTransaction')

    const result = await ctx.activeStorage.createAction({ userId: ctx.userId }, actionArgs(5_000))

    expect(result.inputs.length).toBeGreaterThan(4)
    expect(lockedLookup).toHaveBeenCalledTimes(1)
    expect(lockedLookup.mock.calls[0][3]).toBe(true)
    expect(getRawTx).toHaveBeenCalledTimes(1)
    expect(getRawTx.mock.calls[0]).toEqual([expect.any(String)])
  })

  test('rolls back a concurrent bulk-claim conflict before replanning', async () => {
    await replaceFundingCandidates(20, 1_000)
    const original = ctx.activeStorage.markChangeInputsSpent.bind(ctx.activeStorage)
    const markSpent = jest.spyOn(ctx.activeStorage, 'markChangeInputsSpent')
      .mockResolvedValueOnce(0)
      .mockImplementation(original)

    const result = await ctx.activeStorage.createAction({ userId: ctx.userId }, actionArgs(5_000))

    expect(result.inputs.length).toBeGreaterThan(4)
    expect(markSpent).toHaveBeenCalledTimes(2)
    const spent = (await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId },
      noScript: true
    })).filter(output => output.vout >= 10_000 && output.spentBy != null)
    expect(spent).toHaveLength(result.inputs.length)
  })

  test('rejects economically insufficient dust before writing a transaction row', async () => {
    await replaceFundingCandidates(147, 1)
    const insertTransaction = jest.spyOn(ctx.activeStorage, 'insertTransaction')

    await expect(ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000)
    )).rejects.toMatchObject({ code: 'WERR_INSUFFICIENT_FUNDS' })

    expect(insertTransaction).not.toHaveBeenCalled()
  })

  test('reports funding and BEEF phases with bounded cardinality attributes', async () => {
    await replaceFundingCandidates(1, 5_000)
    const events: TelemetryEvent[] = []
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: ctx.chain,
      knex: ctx.activeStorage.knex,
      feeModel: ctx.activeStorage.feeModel,
      telemetry: { sink: { capture: event => events.push(event) } }
    })
    await storage.makeAvailable()

    await storage.createAction({ userId: ctx.userId }, actionArgs(1_000, false))

    const byName = new Map(events.map(event => [event.name, event]))
    expect(byName.get('wallet.storage.create_action')).toMatchObject({ spanStatus: 'ok' })
    expect(byName.get('wallet.storage.create_action.validate')?.attributes).toMatchObject({
      'action.validated_input_count': 0,
      'action.no_send_change_input_count': 0
    })
    expect(byName.get('wallet.storage.create_action.create_record')?.attributes).toMatchObject({
      'action.transaction_record_created': true
    })
    expect(byName.get('wallet.storage.create_action.funding_candidates')?.attributes).toMatchObject({
      'funding.candidate_count': 1,
      'funding.candidate_satoshis': 5_000
    })
    expect(byName.get('wallet.storage.create_action.funding_claim')?.attributes).toMatchObject({
      'funding.claim_retry_count': 0,
      'funding.source_transaction_count': 1,
      'funding.hydrated_script_count': 0,
      'funding.script_source_transaction_count': 0
    })
    expect(byName.get('wallet.storage.create_action.beef_fetch')?.attributes).toMatchObject({
      'beef.allocated_change_count': 1,
      'beef.known_txid_count': 0
    })
    expect(byName.get('wallet.storage.create_action.persist_outputs')?.attributes).toMatchObject({
      'action.persisted_output_count': expect.any(Number)
    })
    expect(byName.get('wallet.storage.create_action.assemble_inputs')?.attributes).toMatchObject({
      'action.result_input_count': 1
    })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(ctx.identityKey)
    expect(serialized).not.toContain('lockingScript')
  })

  function actionArgs (satoshis: number, returnTXIDOnly = true): Validation.ValidCreateActionArgs {
    return Validation.validateCreateActionArgs({
      outputs: [{ satoshis, lockingScript: '51', outputDescription: 'performance test output' }],
      description: 'createAction funding performance test',
      options: { noSend: true, randomizeOutputs: false, returnTXIDOnly }
    })
  }

  async function replaceFundingCandidates (count: number, satoshis: number, offloadScript = false): Promise<void> {
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
    expect(source?.txid).toBeDefined()
    const lockingScript = [0x76, 0xa9, 0x14, ...Array<number>(20).fill(0x11), 0x88, 0xac]
    for (let index = 0; index < count; index++) {
      const now = new Date()
      const output: TableOutput = {
        outputId: 0,
        userId: ctx.userId,
        transactionId: source.transactionId,
        basketId: basket.basketId,
        spendable: true,
        spentBy: undefined,
        satoshis,
        vout: 10_000 + index,
        txid: source.txid,
        lockingScript: offloadScript ? undefined : lockingScript,
        scriptLength: offloadScript ? 1 : lockingScript.length,
        scriptOffset: offloadScript ? 1 : undefined,
        derivationPrefix: 'funding-performance-prefix',
        derivationSuffix: `funding-performance-${index}`,
        outputDescription: 'fragmented funding candidate',
        ...managedChangeOutputFields,
        created_at: now,
        updated_at: now
      }
      await ctx.activeStorage.insertOutput(output)
    }
  }
})
