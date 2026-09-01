import { Beef, ChainTracker, TelemetryEvent, Validation } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
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
    const lockEligible = jest.spyOn(ctx.activeStorage, 'findFundingOutputsForUpdate')
    try {
      const result = await ctx.activeStorage.createAction(
        { userId: ctx.userId },
        actionArgs(5_000)
      )

      expect(result.inputs.length).toBeGreaterThan(4)
      expect(markSpent).toHaveBeenCalledTimes(1)
      expect(markSpent.mock.calls[0][0]).toHaveLength(result.inputs.length)
      expect(lockEligible).toHaveBeenCalledTimes(1)
      expect(lockEligible.mock.calls[0][1]).toHaveLength(result.inputs.length)
      expect(databaseTransactions).toBe(1)
    } finally {
      ctx.activeStorage.knex.off('query', countTransactions)
    }
  })

  test('hydrates offloaded funding scripts once per source through the claim transaction', async () => {
    await replaceFundingCandidates(20, 1_000, true)
    const lockedLookup = jest.spyOn(ctx.activeStorage, 'findFundingOutputsForUpdate')
    const getRawTx = jest.spyOn(ctx.activeStorage, 'getRawTxOfKnownValidTransaction')

    const result = await ctx.activeStorage.createAction({ userId: ctx.userId }, actionArgs(5_000))

    expect(result.inputs.length).toBeGreaterThan(4)
    expect(lockedLookup).toHaveBeenCalledTimes(1)
    expect(getRawTx).toHaveBeenCalledTimes(1)
    expect(getRawTx.mock.calls[0]).toEqual([expect.any(String), undefined, undefined, expect.anything()])
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

  test('funds an immediate action from change awaiting delayed broadcast', async () => {
    await replaceFundingCandidates(1, 5_000)
    const [candidate] = await ctx.activeStorage.findAvailableManagedChangeInputCandidates(
      ctx.userId,
      (await ctx.activeStorage.findOutputBaskets({
        partial: { userId: ctx.userId, name: 'default' }
      }))[0].basketId,
      true
    )
    await ctx.activeStorage.updateTransaction(candidate.transactionId, { status: 'sending' })

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, true, false)
    )

    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0].sourceTxid).toBe(candidate.txid)
  })

  test('prefers settled liquidity even when a pending output is a closer fit', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 7_000, status: 'completed' },
      { satoshis: 5_000, status: 'sending' }
    ])

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000)
    )

    expect(result.inputs.map(input => input.sourceTxid)).toContain(candidates[0].txid)
    expect(result.inputs.map(input => input.sourceTxid)).not.toContain(candidates[1].txid)
  })

  test('uses pending liquidity only after settled and unproven tiers cannot fund the action', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 500, status: 'completed' },
      { satoshis: 10_000, status: 'sending' }
    ])

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(5_000)
    )

    expect(result.inputs.map(input => input.sourceTxid)).toContain(candidates[1].txid)
  })

  test('resolves ancestry for an older custom provider that omits additive status metadata', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 7_000, status: 'completed' },
      { satoshis: 5_000, status: 'sending' }
    ])
    const original = ctx.activeStorage.findAvailableManagedChangeInputCandidates.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findAvailableManagedChangeInputCandidates')
      .mockImplementation(async (...args) => (await original(...args)).map(candidate => {
        const { transactionStatus: _transactionStatus, ...legacyCandidate } = candidate
        return legacyCandidate
      }))
    const statusLookup = jest.spyOn(ctx.activeStorage, 'findTransactionStatusesByIds')

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000)
    )

    expect(statusLookup).toHaveBeenCalled()
    expect(result.inputs.map(input => input.sourceTxid)).toContain(candidates[0].txid)
    expect(result.inputs.map(input => input.sourceTxid)).not.toContain(candidates[1].txid)
  })

  test('compares exact serialized cost before choosing pending liquidity for a pathological settled plan', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 4_000, status: 'completed' },
      { satoshis: 4_000, status: 'completed', source: 0 },
      { satoshis: 11_000, status: 'sending', source: 1 }
    ])
    ctx.activeStorage.managedChangePolicy.pendingComparisonInputs = 1

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(5_000)
    )

    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0].sourceTxid).toBe(candidates[2].txid)
  })

  test('keeps the settled baseline when exact BEEF cost comparison cannot load proofs', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 4_000, status: 'completed' },
      { satoshis: 4_000, status: 'completed', source: 0 },
      { satoshis: 11_000, status: 'sending', source: 1 }
    ])
    ctx.activeStorage.managedChangePolicy.pendingComparisonInputs = 1
    jest.spyOn(ctx.activeStorage, 'getBeefForTransactions')
      .mockRejectedValue(new Error('proof service unavailable'))

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(5_000)
    )

    expect(result.inputs).toHaveLength(2)
    expect(result.inputs.every(input => input.sourceTxid === candidates[0].txid)).toBe(true)
    expect(result.inputs.some(input => input.sourceTxid === candidates[2].txid)).toBe(false)
  })

  test('rejects a custom-provider candidate whose ancestry cannot be resolved', async () => {
    await replaceFundingCandidates(1, 5_000)
    const original = ctx.activeStorage.findAvailableManagedChangeInputCandidates.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findAvailableManagedChangeInputCandidates')
      .mockImplementation(async (...args) => (await original(...args)).map(candidate => ({
        ...candidate,
        transactionStatus: undefined
      })))
    jest.spyOn(ctx.activeStorage, 'findTransactionStatusesByIds').mockResolvedValue(new Map())

    await expect(ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000)
    )).rejects.toMatchObject({
      code: 'WERR_INTERNAL',
      message: expect.stringContaining('missing its source transaction status')
    })
  })

  test('operator can disable pending comparison without disabling last-resort pending funding', async () => {
    const candidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 4_000, status: 'completed' },
      { satoshis: 4_000, status: 'completed', source: 0 },
      { satoshis: 11_000, status: 'sending', source: 1 }
    ])
    ctx.activeStorage.managedChangePolicy.pendingComparisonInputs = -1
    const basket = (await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'default' }
    }))[0]
    const available = await ctx.activeStorage.findAvailableManagedChangeInputCandidates(
      ctx.userId,
      basket.basketId,
      false
    )
    expect(available.map(candidate => candidate.transactionStatus)).toEqual([
      'completed',
      'completed',
      'sending'
    ])

    const settled = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(5_000)
    )
    expect(settled.inputs).toHaveLength(2)
    expect(settled.inputs.some(input => input.sourceTxid === candidates[2].txid)).toBe(false)

    const fallbackCandidates = await replaceFundingCandidatesAcrossSources([
      { satoshis: 500, status: 'completed' },
      { satoshis: 10_000, status: 'sending' }
    ])
    const fallback = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(5_000)
    )
    expect(fallback.inputs.some(input => input.sourceTxid === fallbackCandidates[1].txid)).toBe(true)
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
      'funding.candidate_satoshis': 5_000,
      'funding.completed_candidate_count': 1,
      'funding.unproven_candidate_count': 0,
      'funding.sending_candidate_count': 0
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

  test('resolves createAction before cooking a canonical BEEF miss', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: false,
      writeEnabled: true,
      maxQueueSize: 1
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)
    const persist = jest.spyOn(ctx.activeStorage, 'upsertPreparedBeef')
    const lookup = jest.spyOn(ctx.activeStorage, 'lookupPreparedBeefs')

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, false)
    )

    expect(result.inputBeef?.length).toBeGreaterThan(0)
    expect(lookup).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: []
    })).toBe(false)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: ['f'.repeat(64)]
    })).toBe(false)

    await ctx.activeStorage.waitForPreparedBeefTasks()

    expect(persist).toHaveBeenCalledTimes(1)
    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toHaveLength(1)
  })

  test('keeps canonical createAction compatible when the optional COOK queue is absent', async () => {
    await replaceFundingCandidates(1, 5_000)
    ctx.activeStorage.preparedBeefPolicy.writeEnabled = true
    Object.defineProperty(ctx.activeStorage, 'enqueuePreparedBeef', {
      configurable: true,
      value: undefined
    })

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, false)
    )

    expect(result.inputBeef?.length).toBeGreaterThan(0)
  })

  test('uses a user-scoped prepared BEEF without invoking the canonical builder', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()
    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId + 1, [source.txid])).resolves.toEqual([])
    await expect(ctx.activeStorage.findPreparedBeefBackfillRoots(10, 1)).resolves.not.toContainEqual({
      userId: ctx.userId,
      rootTxid: source.txid
    })
    const canonicalBuilder = jest.spyOn(ctx.activeStorage, 'getBeefForTransactions')

    const result = await ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, false)
    )

    expect(result.inputBeef?.length).toBeGreaterThan(0)
    expect(canonicalBuilder).not.toHaveBeenCalled()
  })

  test('discards a partially merged prepared aggregate so canonical fallback stays clean', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()
    const merge = jest.spyOn(Beef.prototype, 'mergeBeef').mockImplementationOnce(() => {
      throw new Error('conflicting prepared fragment')
    })

    const lookup = await ctx.activeStorage.lookupPreparedBeefs(ctx.userId, [source.txid])
    merge.mockRestore()

    expect(lookup.hitTxids).toEqual([])
    expect(lookup.missingTxids).toEqual([source.txid])
    expect(lookup.beef.txs).toHaveLength(0)
  })

  test('treats corrupt prepared BEEF as a miss and repairs it in the background', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()
    const corruptChecksum = '0'.repeat(64)
    await ctx.activeStorage.knex('prepared_beefs')
      .where({ userId: ctx.userId, rootTxid: source.txid })
      .update({ checksum: corruptChecksum })
    const canonicalBuilder = jest.spyOn(ctx.activeStorage, 'getBeefForTransactions')

    await expect(ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, false)
    )).resolves.toMatchObject({ inputBeef: expect.anything() })

    expect(canonicalBuilder).toHaveBeenCalledWith([source.txid], expect.any(Object))
    await ctx.activeStorage.waitForPreparedBeefTasks()
    const [repaired] = await ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])
    expect(repaired.checksum).not.toBe(corruptChecksum)
  })

  test('falls back to the canonical builder when the prepared store is unavailable', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    ctx.activeStorage.preparedBeefPolicy.readEnabled = true
    jest.spyOn(ctx.activeStorage, 'findPreparedBeefs').mockRejectedValueOnce(new Error('cache unavailable'))
    const canonicalBuilder = jest.spyOn(ctx.activeStorage, 'getBeefForTransactions')

    await expect(ctx.activeStorage.createAction(
      { userId: ctx.userId },
      actionArgs(1_000, false)
    )).resolves.toMatchObject({ inputBeef: expect.anything() })

    expect(canonicalBuilder).toHaveBeenCalledWith([source.txid], expect.any(Object))
  })

  test('invalidates ready artifacts so a proof reorganization cannot reuse them', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    ctx.activeStorage.preparedBeefPolicy.writeEnabled = true
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()

    await expect(ctx.activeStorage.invalidatePreparedBeefs()).resolves.toBe(1)

    ctx.activeStorage.preparedBeefPolicy.readEnabled = true
    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toEqual([])
    await expect(ctx.activeStorage.knex('prepared_beefs')
      .where({ userId: ctx.userId, rootTxid: source.txid })
      .first('state', 'formatVersion')).resolves.toMatchObject({ state: 'stale', formatVersion: 0 })
  })

  test('does not let an in-flight cook overwrite a proof reorganization', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    ctx.activeStorage.preparedBeefPolicy.writeEnabled = true
    let verificationStarted!: () => void
    let releaseVerification!: () => void
    const started = new Promise<void>(resolve => { verificationStarted = resolve })
    const release = new Promise<void>(resolve => { releaseVerification = resolve })
    const isValidRootForHeight = jest.fn(async () => {
      verificationStarted()
      await release
      return true
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight
    } as ChainTracker)
    const epoch = await ctx.activeStorage.readPreparedBeefProofEpoch()

    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await started
    await expect(ctx.activeStorage.invalidatePreparedBeefs()).resolves.toBe(0)
    releaseVerification()
    await ctx.activeStorage.waitForPreparedBeefTasks()

    await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).resolves.toBe(epoch + 1)
    await expect(ctx.activeStorage.knex('prepared_beefs')
      .where({ userId: ctx.userId, rootTxid: source.txid })
      .first()).resolves.toBeUndefined()

    isValidRootForHeight.mockResolvedValue(true)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()
    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toHaveLength(1)
  })

  test('backfills settled managed-change roots in bounded background passes', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      writeEnabled: true,
      backfillEnabled: true,
      backfillBatchSize: 1,
      backfillIntervalMs: 0
    })
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as ChainTracker)

    ctx.activeStorage.startPreparedBeefBackfill()
    await ctx.activeStorage.waitForPreparedBeefTasks()

    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toHaveLength(1)
  })

  test('stops a failed backfill pass without affecting foreground storage', async () => {
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      writeEnabled: true,
      backfillEnabled: true,
      backfillIntervalMs: 0
    })
    const findRoots = jest.spyOn(ctx.activeStorage, 'findPreparedBeefBackfillRoots')
      .mockRejectedValueOnce(new Error('backfill unavailable'))

    ctx.activeStorage.startPreparedBeefBackfill()
    await ctx.activeStorage.waitForPreparedBeefTasks()

    expect(findRoots).toHaveBeenCalledTimes(1)
  })

  test('fails closed when prepared-BEEF proof epoch metadata is unavailable', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    await expect(ctx.activeStorage.lookupPreparedBeefs(ctx.userId, [])).resolves.toMatchObject({
      hitTxids: [],
      missingTxids: []
    })
    await ctx.activeStorage.knex('prepared_beef_metadata').delete()

    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()

    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [])).resolves.toEqual([])
    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toEqual([])
    await expect(ctx.activeStorage.readPreparedBeefProofEpoch()).rejects.toThrow(
      'prepared BEEF proof epoch is unavailable'
    )
    await expect(ctx.activeStorage.invalidatePreparedBeefs()).rejects.toThrow(
      'prepared BEEF proof epoch update failed'
    )
  })

  test('suppresses failed backfill roots while allowing an organic retry to repair them', async () => {
    const source = await replaceFundingCandidates(1, 5_000)
    Object.assign(ctx.activeStorage.preparedBeefPolicy, {
      readEnabled: true,
      writeEnabled: true
    })
    const isValidRootForHeight = jest.fn(async () => false)
    jest.spyOn(ctx.activeStorage.getServices(), 'getChainTracker').mockResolvedValue({
      isValidRootForHeight
    } as ChainTracker)
    expect(ctx.activeStorage.enqueuePreparedBeef({
      userId: ctx.userId,
      rootTxids: [source.txid]
    })).toBe(true)
    await ctx.activeStorage.waitForPreparedBeefTasks()
    await expect(ctx.activeStorage.knex('prepared_beefs')
      .where({ userId: ctx.userId, rootTxid: source.txid })
      .first('state')).resolves.toMatchObject({ state: 'failed' })
    await expect(ctx.activeStorage.findPreparedBeefBackfillRoots(10, 1)).resolves.not.toContainEqual({
      userId: ctx.userId,
      rootTxid: source.txid
    })

    isValidRootForHeight.mockResolvedValue(true)
    await ctx.activeStorage.createAction({ userId: ctx.userId }, actionArgs(1_000, false))
    await ctx.activeStorage.waitForPreparedBeefTasks()

    await expect(ctx.activeStorage.findPreparedBeefs(ctx.userId, [source.txid])).resolves.toHaveLength(1)
  })

  test('keeps fallback storage-provider batch methods guarded and user-scoped', async () => {
    await replaceFundingCandidates(2, 1_000)
    const basket = (await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'default' }
    }))[0] as TableOutputBasket
    const candidates = await StorageProvider.prototype.findAvailableManagedChangeInputs.call(
      ctx.activeStorage,
      ctx.userId,
      basket.basketId,
      true
    )
    expect(candidates).toHaveLength(2)

    const transactionId = candidates[0].transactionId
    const statuses = await StorageProvider.prototype.findTransactionStatusesByIds.call(
      ctx.activeStorage,
      ctx.userId,
      [transactionId, transactionId, 999_999]
    )
    expect(statuses.get(transactionId)).toBe('completed')
    await expect(StorageProvider.prototype.findTransactionStatusesByIds.call(
      ctx.activeStorage,
      ctx.userId + 1,
      [transactionId]
    )).resolves.toEqual(new Map())

    await ctx.activeStorage.updateOutput(candidates[1].outputId, { spendable: false })
    const updated = await ctx.activeStorage.transaction(async trx =>
      await StorageProvider.prototype.markChangeInputsSpent.call(
        ctx.activeStorage,
        [candidates[0].outputId, candidates[1].outputId, 999_999],
        transactionId,
        trx
      )
    )
    expect(updated).toBe(1)
    await expect(ctx.activeStorage.transaction(async trx =>
      await StorageProvider.prototype.markChangeInputsSpent.call(
        ctx.activeStorage,
        [candidates[0].outputId],
        transactionId,
        trx
      )
    )).resolves.toBe(0)
  })

  function actionArgs (
    satoshis: number,
    returnTXIDOnly = true,
    acceptDelayedBroadcast = true
  ): Validation.ValidCreateActionArgs {
    return Validation.validateCreateActionArgs({
      outputs: [{ satoshis, lockingScript: '51', outputDescription: 'performance test output' }],
      description: 'createAction funding performance test',
      options: { noSend: true, randomizeOutputs: false, returnTXIDOnly, acceptDelayedBroadcast }
    })
  }

  async function replaceFundingCandidates (
    count: number,
    satoshis: number,
    offloadScript = false
  ): Promise<{ txid: string, transactionId: number }> {
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
    return { txid: source.txid!, transactionId: source.transactionId }
  }

  async function replaceFundingCandidatesAcrossSources (
    specs: Array<{ satoshis: number, status: 'completed' | 'unproven' | 'sending', source?: number }>
  ): Promise<Array<{ txid: string, transactionId: number }>> {
    const basket = (await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'default' }
    }))[0] as TableOutputBasket
    await ctx.activeStorage.updateOutputBasket(basket.basketId, {
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 5_000
    })
    const existing = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, basketId: basket.basketId },
      noScript: true
    })
    for (const output of existing) {
      if (output.spendable) await ctx.activeStorage.updateOutput(output.outputId, { spendable: false })
    }
    const sources = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId },
      status: ['completed'],
      noRawTx: true
    }) as TableTransaction[]
    expect(sources.length).toBeGreaterThanOrEqual(2)
    const lockingScript = [0x76, 0xa9, 0x14, ...Array<number>(20).fill(0x11), 0x88, 0xac]
    const selectedSources = specs.map((spec, index) => sources[spec.source ?? index])
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index]
      const source = selectedSources[index]
      const now = new Date()
      await ctx.activeStorage.insertOutput({
        outputId: 0,
        userId: ctx.userId,
        transactionId: source.transactionId,
        basketId: basket.basketId,
        spendable: true,
        spentBy: undefined,
        satoshis: spec.satoshis,
        vout: 30_000 + existing.length + index,
        txid: source.txid,
        lockingScript,
        scriptLength: lockingScript.length,
        derivationPrefix: 'funding-policy-prefix',
        derivationSuffix: `funding-policy-${index}`,
        outputDescription: 'funding policy candidate',
        ...managedChangeOutputFields,
        created_at: now,
        updated_at: now
      })
    }
    for (const [transactionId, status] of new Map(
      specs.map((spec, index) => [selectedSources[index].transactionId, spec.status])
    )) {
      await ctx.activeStorage.updateTransaction(transactionId, { status })
    }
    return selectedSources.map(source => ({ txid: source.txid!, transactionId: source.transactionId }))
  }
})
