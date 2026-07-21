import { Beef, CreateActionArgs, Transaction, Validation } from '@bsv/sdk'
import { Wallet } from '../../../src/Wallet'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { actionBatchBlobDigest, actionBatchManifestDigest } from '../../../src/utility/actionBatchDigest'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'
import { cleanupExpiredActionBatches } from '../../../src/storage/methods/actionBatch'
import { specOpWalletBalance } from '../../../src/sdk/types'
import type { ActionBatchManifest } from '../../../src/sdk/ActionBatch.interfaces'
import { maxPossibleSatoshis } from '../../../src/storage/methods/generateChange'

const randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]

function actionArgs (noSendChange: string[] = []): CreateActionArgs {
  return {
    outputs: [{
      satoshis: 1,
      lockingScript: '7551',
      outputDescription: 'batched workload output'
    }],
    labels: ['action batch workload'],
    description: 'Plan dependent action locally',
    options: { noSend: true, noSendChange, randomizeOutputs: false }
  }
}

function rawTransaction (atomicBeef: number[], txid: string): number[] {
  const transaction = Beef.fromBinary(atomicBeef).findTxid(txid)?.tx
  expect(transaction).toBeDefined()
  return Array.from(transaction!.toUint8Array())
}

function feePaid (atomicBeef: number[], txid: string): number {
  const transaction = Beef.fromBinary(atomicBeef).findAtomicTransaction(txid)
  expect(transaction).toBeDefined()
  const inputs = transaction.inputs.reduce((sum, input) => sum + (input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis ?? 0), 0)
  const outputs = transaction.outputs.reduce((sum, output) => sum + output.satoshis, 0)
  return inputs - outputs
}

async function captureCommitManifest (
  ctx: TestWalletNoSetup,
  txids: string[],
  description: string
): Promise<ActionBatchManifest> {
  let captured: ActionBatchManifest | undefined
  const marker = `capture ${description}`
  jest.spyOn(ctx.storage, 'commitActionBatch').mockImplementationOnce(async manifest => {
    captured = manifest
    throw new Error(marker)
  })
  await expect(ctx.wallet.createAction({
    description,
    options: { sendWith: txids, acceptDelayedBroadcast: false }
  })).rejects.toThrow(marker)
  if (captured == null) throw new Error('commit manifest was not captured')
  return captured
}

describe('in-memory action batch workspace', () => {
  jest.setTimeout(120000)
  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName ?? 'actionBatch')
    _tu.mockPostServicesAsSuccess([ctx])
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true } as any)
    jest.spyOn(ctx.activeStorage, 'getServices').mockReturnValue(ctx.services)
  })

  afterEach(async () => {
    await ctx.wallet.destroy()
  })

  test('dependent chain uses one begin, no middle storage calls, and one commit', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    const extend = jest.spyOn(ctx.storage, 'extendActionBatch')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    const legacyCreate = jest.spyOn(ctx.storage, 'createAction')
    const legacyProcess = jest.spyOn(ctx.storage, 'processAction')
    ctx.wallet.randomVals = randomVals

    const txids: string[] = []
    let change: string[] = []
    for (let i = 0; i < 10; i++) {
      const result = await ctx.wallet.createAction(actionArgs(change))
      txids.push(result.txid!)
      change = result.noSendChange ?? []
      expect(result.tx).toBeDefined()
    }

    expect(begin).toHaveBeenCalledTimes(1)
    expect(extend).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(legacyCreate).not.toHaveBeenCalled()
    expect(legacyProcess).not.toHaveBeenCalled()

    const staged = await ctx.wallet.listActions({ labels: ['action batch workload'] })
    expect(staged.totalActions).toBe(10)

    const final = await ctx.wallet.createAction({
      description: 'Commit planned action batch',
      options: { sendWith: txids }
    })
    expect(final.sendWithResults).toHaveLength(txids.length)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(begin).toHaveBeenCalledTimes(1)
    expect(extend).not.toHaveBeenCalled()

    const manifest = commit.mock.calls[0][0]
    const retry = await ctx.storage.commitActionBatch(manifest)
    expect(retry.alreadyCommitted).toBe(true)
    expect(retry.committedTxids).toEqual(txids)

    const persisted = await ctx.wallet.listActions({ labels: ['action batch workload'] })
    expect(persisted.totalActions).toBe(10)
  })

  test('concurrent planning shares one workspace without reusing inputs', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals

    const planned = await Promise.all([
      ctx.wallet.createAction(actionArgs()),
      ctx.wallet.createAction(actionArgs())
    ])
    const txids = planned.map(action => action.txid!)

    expect(begin).toHaveBeenCalledTimes(1)
    expect(new Set(txids).size).toBe(2)
    await expect(ctx.wallet.createAction({
      description: 'Commit concurrently planned actions',
      options: { sendWith: txids }
    })).resolves.toBeDefined()
  })

  test('noSend listing includes staged actions and abort releases their workspace', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())

    const listed = await ctx.wallet.listNoSendActions({ labels: [] })
    expect(listed.actions).toContainEqual(expect.objectContaining({ txid: staged.txid, status: 'nosend' }))
    expect((await ctx.wallet.listFailedActions({ labels: [] })).actions)
      .not.toContainEqual(expect.objectContaining({ txid: staged.txid }))

    await ctx.wallet.listNoSendActions({ labels: [] }, true)
    const begun = await begin.mock.results[0].value
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('aborted')
  })

  test('independent actions extend confirmed-input runway before exhaustion', async () => {
    const extend = jest.spyOn(ctx.storage, 'extendActionBatch')
    ctx.wallet.randomVals = randomVals
    const txids: string[] = []
    for (let index = 0; index < 10; index++) {
      const staged = await ctx.wallet.createAction(actionArgs())
      txids.push(staged.txid!)
    }
    expect(extend).toHaveBeenCalled()
    expect(extend.mock.calls[0][0].requestedOutputs).toBeGreaterThanOrEqual(1)
    await ctx.wallet.createAction({ description: 'Commit independent actions', options: { sendWith: txids } })
    const secondRequest = (await ctx.activeStorage.findProvenTxReqs({ partial: { txid: txids[1] } }))[0]
    expect(secondRequest.inputBEEF).toBeDefined()
    expect(Beef.fromBinary(secondRequest.inputBEEF!).findTxid(txids[0])).toBeUndefined()
  })

  test('staged outputs and balance are coherent before commit', async () => {
    ctx.wallet.randomVals = randomVals
    const balanceBefore = await ctx.wallet.listOutputs({ basket: specOpWalletBalance })
    const staged = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [{
        satoshis: 1,
        lockingScript: '7551',
        outputDescription: 'staged basket output',
        basket: 'funding basket'
      }]
    })
    const listed = await ctx.wallet.listOutputs({ basket: 'funding basket', include: 'locking scripts' })
    expect(listed.outputs).toContainEqual(expect.objectContaining({
      outpoint: expect.stringMatching(`^${staged.txid}\\.`),
      lockingScript: '7551'
    }))
    const balanceAfter = await ctx.wallet.listOutputs({ basket: specOpWalletBalance })
    expect(balanceAfter.totalOutputs).toBeLessThan(balanceBefore.totalOutputs)
  })

  test('deterministic legacy and batch planning produce identical transactions', async () => {
    const legacyCtx = await _tu.createLegacyWalletSQLiteCopy('actionBatchParityLegacy')
    const legacy = new Wallet({
      chain: legacyCtx.chain,
      keyDeriver: legacyCtx.keyDeriver,
      storage: legacyCtx.storage,
      services: legacyCtx.services,
      actionBatchMode: 'legacy'
    })
    ctx.wallet.randomVals = randomVals
    legacy.randomVals = randomVals
    try {
      const randomizedArgs = (): CreateActionArgs => {
        const value = actionArgs()
        value.options = { ...value.options, randomizeOutputs: true }
        return value
      }
      const batchResult = await ctx.wallet.createAction(randomizedArgs())
      const legacyResult = await legacy.createAction(randomizedArgs())
      expect(batchResult.txid).toBe(legacyResult.txid)
      expect(batchResult.noSendChange).toEqual(legacyResult.noSendChange)
      const batchRaw = rawTransaction(batchResult.tx!, batchResult.txid!)
      const legacyRaw = rawTransaction(legacyResult.tx!, legacyResult.txid!)
      expect(batchRaw).toEqual(legacyRaw)
      expect(feePaid(batchResult.tx!, batchResult.txid!)).toBe(feePaid(legacyResult.tx!, legacyResult.txid!))
    } finally {
      await legacy.destroy()
      await legacyCtx.wallet.destroy()
    }
  })

  test('two-step signing remains local until the batch commit', async () => {
    const legacyCreate = jest.spyOn(ctx.storage, 'createAction')
    const legacyProcess = jest.spyOn(ctx.storage, 'processAction')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    ctx.wallet.randomVals = randomVals
    const created = await ctx.wallet.createAction({
      ...actionArgs(),
      options: { ...actionArgs().options, signAndProcess: false }
    })
    expect(created.signableTransaction).toBeDefined()
    const signed = await ctx.wallet.signAction({
      reference: created.signableTransaction!.reference,
      spends: {},
      options: { noSend: true, returnTXIDOnly: true }
    })
    expect(signed.txid).toBeDefined()
    expect(signed.tx).toBeUndefined()
    expect(legacyCreate).not.toHaveBeenCalled()
    expect(legacyProcess).not.toHaveBeenCalled()
    await ctx.wallet.createAction({ description: 'Commit two-step batch', options: { sendWith: [signed.txid!] } })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0].actions[0].plan.inputs.every(input => input.sourceTransaction == null)).toBe(true)
  })

  test('first-action returnTXIDOnly retains internal proof data through commit', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      ...actionArgs(),
      options: { ...actionArgs().options, returnTXIDOnly: true }
    })
    expect(staged.txid).toBeDefined()
    expect(staged.tx).toBeUndefined()
    await expect(ctx.wallet.createAction({
      description: 'Commit returnTXIDOnly batch',
      options: { sendWith: [staged.txid!] }
    })).resolves.toBeDefined()
  })

  test('maxPossibleSatoshis output is adjusted and committed atomically', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      outputs: [{
        satoshis: maxPossibleSatoshis,
        lockingScript: '51',
        outputDescription: 'maximum available batch output'
      }],
      description: 'Plan maximum available output',
      options: { noSend: true, randomizeOutputs: false }
    })
    await expect(ctx.wallet.createAction({
      description: 'Commit maximum available output',
      options: { sendWith: [staged.txid!] }
    })).resolves.toBeDefined()
  })

  test('staged custom inputs are resolved locally without reserving them', async () => {
    const extend = jest.spyOn(ctx.storage, 'extendActionBatch')
    ctx.wallet.randomVals = randomVals
    const source = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [{
        satoshis: 2,
        lockingScript: '7551',
        outputDescription: 'staged explicit input source',
        basket: 'funding basket'
      }]
    })
    const spending = await ctx.wallet.createAction({
      inputs: [{
        outpoint: `${source.txid}.0`,
        unlockingScript: '00',
        inputDescription: 'spend staged explicit input'
      }],
      inputBEEF: source.tx,
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'mixed-input output' }],
      description: 'Plan mixed explicit input action',
      options: {
        noSend: true,
        noSendChange: source.noSendChange,
        randomizeOutputs: false
      }
    })
    expect(extend).not.toHaveBeenCalled()
    await ctx.wallet.createAction({
      description: 'Commit mixed explicit input actions',
      options: { sendWith: [source.txid!, spending.txid!] }
    })
  })

  test('providers without the capability use the legacy path before planning begins', async () => {
    const capabilities = jest.spyOn(ctx.storage, 'getCapabilities').mockResolvedValue({})
    const legacyCreate = jest.spyOn(ctx.storage, 'createAction')
    const legacyProcess = jest.spyOn(ctx.storage, 'processAction')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    await ctx.wallet.createAction({ description: 'Commit legacy fallback', options: { sendWith: [staged.txid!] } })
    expect(capabilities).toHaveBeenCalledTimes(1)
    expect(legacyCreate).toHaveBeenCalledTimes(1)
    expect(legacyProcess).toHaveBeenCalledTimes(2)
  })

  test('capabilities are negotiated once for each active provider', async () => {
    const activeStore = jest.spyOn(ctx.storage, 'getActiveStore').mockReturnValue('provider-a')
    const capabilities = jest.spyOn(ctx.storage, 'getCapabilities')
    ctx.wallet.randomVals = randomVals

    await ctx.wallet.createAction(actionArgs())
    await ctx.wallet.listNoSendActions({ labels: [] }, true)
    activeStore.mockReturnValue('provider-b')
    await ctx.wallet.createAction(actionArgs())
    await ctx.wallet.listNoSendActions({ labels: [] }, true)

    expect(capabilities).toHaveBeenCalledTimes(2)
  })

  test('first-action pool exhaustion aborts the workspace and releases reservations', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    await expect(ctx.wallet.createAction({
      outputs: [{ satoshis: 2_000_000_000, lockingScript: '51', outputDescription: 'unfundable output' }],
      description: 'Exhaust available action batch funding',
      options: { noSend: true, randomizeOutputs: false }
    })).rejects.toBeDefined()
    const begun = await begin.mock.results[0].value
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    expect(batch?.status).toBe('aborted')
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toHaveLength(0)
  })

  test('an expired lease is atomically reacquired when its inputs remain available', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const begun = await begin.mock.results[0].value
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    await ctx.activeStorage.updateActionBatch(batch!.actionBatchId, { expiresAt: new Date(Date.now() - 1) })
    await cleanupExpiredActionBatches(ctx.activeStorage)
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('expired')
    const lockInputs = jest.spyOn(ctx.activeStorage, 'findOutputsByOutpointsForUpdate')

    await expect(ctx.wallet.createAction({
      description: 'Commit after lease expiry',
      options: { sendWith: [staged.txid!] }
    })).resolves.toBeDefined()
    expect(lockInputs).toHaveBeenCalled()
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('committed')
  })

  test('expired reservations cannot be reacquired after another batch claims an input', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const begun = await begin.mock.results[0].value
    const firstBatch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    const firstIds = await ctx.activeStorage.findActionBatchOutputIds(firstBatch!.actionBatchId)
    await ctx.activeStorage.updateActionBatch(firstBatch!.actionBatchId, { expiresAt: new Date(Date.now() - 1) })
    await cleanupExpiredActionBatches(ctx.activeStorage)
    const competing = await ctx.storage.beginActionBatch({
      batchId: 'competing-reservation',
      firstAction: Validation.validateCreateActionArgs(actionArgs())
    })
    expect(competing.reservedOutputs.some(output => firstIds.includes(output.outputId))).toBe(true)

    await expect(ctx.wallet.createAction({
      description: 'Conflicting expired batch commit',
      options: { sendWith: [staged.txid!] }
    })).rejects.toBeDefined()
    await ctx.storage.abortActionBatch(competing.batchId)
  })

  test('a broadcaster failure leaves one durable commit that can be retried', async () => {
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    jest.spyOn(ctx.activeStorage, 'attemptToPostReqsToNetwork').mockRejectedValueOnce(new Error('simulated broadcaster outage'))
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    await expect(ctx.wallet.createAction({
      description: 'Commit before simulated broadcaster failure',
      options: { sendWith: [staged.txid!], acceptDelayedBroadcast: false }
    })).rejects.toThrow('simulated broadcaster outage')

    const firstManifest = commit.mock.calls[0][0]
    const retried = await ctx.wallet.createAction({
      description: 'Retry commit after simulated broadcaster failure',
      options: { sendWith: [staged.txid!], acceptDelayedBroadcast: false }
    })
    expect(retried.sendWithResults).toEqual([
      expect.objectContaining({ txid: staged.txid, status: 'unproven' })
    ])
    expect(commit.mock.calls[1][0].digest).toBe(firstManifest.digest)
    const persisted = await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid: staged.txid } })
    expect(persisted).toHaveLength(1)
  })

  test('atomic validation rejects duplicate spends across staged actions', async () => {
    ctx.wallet.randomVals = randomVals
    const firstResult = await ctx.wallet.createAction(actionArgs())
    const secondResult = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [firstResult.txid!, secondResult.txid!],
      'Capture duplicate-spend validation manifest'
    )

    const first = captured.actions[0]
    const second = captured.actions[1]
    const firstRaw = first.rawTxDigest == null ? undefined : captured.inlineBlobs?.[first.rawTxDigest]
    if (firstRaw == null) throw new Error('captured manifest did not inline its first transaction')
    const duplicateRaw = Uint8Array.from(firstRaw)
    duplicateRaw[duplicateRaw.length - 4] = 1
    const duplicateTxid = Transaction.fromBinary(duplicateRaw).id('hex')
    const duplicateDigest = actionBatchBlobDigest(duplicateRaw)
    const actions = [first, {
      ...first,
      reference: second.reference,
      txid: duplicateTxid,
      rawTxDigest: duplicateDigest,
      plan: { ...first.plan, reference: second.reference, lockTime: 1 },
      metadata: second.metadata
    }]
    const withoutDigest = {
      ...captured,
      actions,
      inlineBlobs: { ...captured.inlineBlobs, [duplicateDigest]: duplicateRaw }
    }
    const { digest: _digest, ...semanticManifest } = withoutDigest
    const invalid = { ...semanticManifest, digest: actionBatchManifestDigest(semanticManifest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('not double spend')
  })

  test('atomic validation rejects a raw transaction with an invalidated signature', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture signature-validation manifest'
    )

    const action = captured.actions[0]
    const originalRaw = action.rawTxDigest == null ? undefined : captured.inlineBlobs?.[action.rawTxDigest]
    if (originalRaw == null) throw new Error('captured manifest did not inline its transaction')
    const alteredRaw = Uint8Array.from(originalRaw)
    alteredRaw[alteredRaw.length - 4] = 1
    const altered = Transaction.fromBinary(alteredRaw)
    const alteredTxid = Transaction.fromBinary(alteredRaw).id('hex')
    const alteredDigest = actionBatchBlobDigest(alteredRaw)
    const actions = [{
      ...action,
      txid: alteredTxid,
      rawTxDigest: alteredDigest,
      plan: { ...action.plan, lockTime: 1 }
    }]
    const withoutDigest = {
      ...captured,
      actions,
      inlineBlobs: { ...captured.inlineBlobs, [alteredDigest]: alteredRaw }
    }
    const { digest: _digest, ...semanticManifest } = withoutDigest
    const invalid = { ...semanticManifest, digest: actionBatchManifestDigest(semanticManifest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toBeDefined()
  })

  test('atomic validation derives fees from proven source outputs', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture source-value validation manifest'
    )
    const actions = captured.actions.map((action, actionIndex) => actionIndex === 0
      ? {
          ...action,
          plan: {
            ...action.plan,
            inputs: action.plan.inputs.map((input, inputIndex) => inputIndex === 0
              ? { ...input, sourceSatoshis: input.sourceSatoshis + 1_000_000 }
              : input)
          }
        }
      : action)
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('match proven source outputs')
  })

  test('atomic validation rejects ambiguous input mappings', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture input-mapping validation manifest'
    )
    const actions = captured.actions.map((action, actionIndex) => actionIndex === 0
      ? {
          ...action,
          plan: {
            ...action.plan,
            inputs: action.plan.inputs.map((input, inputIndex) => inputIndex === 0
              ? { ...input, vin: 1 }
              : input)
          }
        }
      : action)
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('complete sequential vin mappings')
  })

  test('atomic validation cannot reclassify wallet funding as a caller input', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture input-classification validation manifest'
    )
    const actions = captured.actions.map((action, actionIndex) => actionIndex === 0
      ? {
          ...action,
          plan: {
            ...action.plan,
            inputs: action.plan.inputs.map((input, inputIndex) => inputIndex === 0
              ? { ...input, providedBy: 'you' as const }
              : input)
          }
        }
      : action)
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('represent every caller-provided input')
  })

  test('atomic validation requires unique action references', async () => {
    ctx.wallet.randomVals = randomVals
    const first = await ctx.wallet.createAction(actionArgs())
    const second = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [first.txid!, second.txid!],
      'Capture reference validation manifest'
    )
    const duplicateReference = captured.actions[0].reference
    const actions = captured.actions.map((action, actionIndex) => actionIndex === 1
      ? {
          ...action,
          reference: duplicateReference,
          plan: { ...action.plan, reference: duplicateReference }
        }
      : action)
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('unique references')
  })

  test('atomic validation rejects altered requested-output metadata', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture output-metadata validation manifest'
    )
    const actions = captured.actions.map((action, actionIndex) => actionIndex === 0
      ? {
          ...action,
          metadata: {
            ...action.metadata,
            outputs: action.metadata.outputs.map((output, outputIndex) => outputIndex === 0
              ? { ...output, basket: 'altered basket' }
              : output)
          }
        }
      : action)
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('match planned requested outputs')
  })

  test('atomic validation binds commissions to the active storage policy', async () => {
    ctx.activeStorage.commissionSatoshis = 5
    ctx.activeStorage.commissionPubKeyHex = ctx.identityKey
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture commission validation manifest'
    )
    const actions = captured.actions.map(action => ({
      ...action,
      plan: {
        ...action.plan,
        outputs: action.plan.outputs.map(output => output.purpose === 'storage-commission'
          ? { ...output, satoshis: output.satoshis + 1 }
          : output)
      }
    }))
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('active storage commission')
    await expect(ctx.storage.commitActionBatch(captured)).resolves.toBeDefined()
  })

  test('concurrent identical commits persist and broadcast exactly once', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(
      ctx,
      [staged.txid!],
      'Capture concurrent-commit manifest'
    )
    const broadcast = jest.spyOn(ctx.activeStorage, 'attemptToPostReqsToNetwork')
    const [first, second] = await Promise.all([
      ctx.storage.commitActionBatch(captured),
      ctx.storage.commitActionBatch(captured)
    ])
    expect(second.manifestDigest).toBe(first.manifestDigest)
    expect(second.committedTxids).toEqual(first.committedTxids)
    expect([first.alreadyCommitted, second.alreadyCommitted].sort()).toEqual([false, true])
    const persisted = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid: staged.txid }
    })
    expect(persisted).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  test('abort releases reservations and removes staged views', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    const result = await ctx.wallet.createAction({
      ...actionArgs(),
      options: { ...actionArgs().options, signAndProcess: false }
    })
    const begun = await begin.mock.results[0].value
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    expect(batch).toBeDefined()
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).not.toHaveLength(0)

    await expect(ctx.wallet.abortAction({ reference: result.signableTransaction!.reference })).resolves.toEqual({ aborted: true })
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toHaveLength(0)
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('aborted')
    expect((await ctx.wallet.listActions({ labels: ['action batch workload'] })).totalActions).toBe(0)
  })

  test('wallet destruction releases an uncommitted workspace', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    const abort = jest.spyOn(ctx.storage, 'abortActionBatch')
    ctx.wallet.randomVals = randomVals
    await ctx.wallet.createAction(actionArgs())
    const begun = await begin.mock.results[0].value
    await ctx.wallet.destroy()
    expect(abort).toHaveBeenCalledWith(begun.batchId)
    expect(await abort.mock.results[0].value).toEqual({ aborted: true })
  })

  test('a normal action commits the open workspace without broadcasting earlier noSend actions', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      ...actionArgs(),
      labels: ['earlier noSend action']
    })
    const normal = await ctx.wallet.createAction({
      outputs: [{
        satoshis: 1,
        lockingScript: '51',
        outputDescription: 'normal action output'
      }],
      labels: ['normal committing action'],
      description: 'Commit workspace with a normal action',
      options: { noSend: false, randomizeOutputs: false }
    })
    expect(normal.txid).toBeDefined()
    const earlier = await ctx.wallet.listActions({ labels: ['earlier noSend action'] })
    const committed = await ctx.wallet.listActions({ labels: ['normal committing action'] })
    expect(earlier.actions).toHaveLength(1)
    expect(earlier.actions[0].txid).toBe(staged.txid)
    expect(earlier.actions[0].status).toBe('nosend')
    expect(committed.actions).toHaveLength(1)
    expect(committed.actions[0].txid).toBe(normal.txid)
  })

  test('large finalization uploads unique scripts once and commits by manifest digest', async () => {
    const getCapabilities = ctx.storage.getCapabilities.bind(ctx.storage)
    jest.spyOn(ctx.storage, 'getCapabilities').mockImplementation(async () => {
      const capabilities = await getCapabilities()
      return {
        actionBatch: {
          ...capabilities.actionBatch!,
          maxInlineBytes: 128
        }
      }
    })
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    const prepare = jest.spyOn(ctx.storage, 'prepareActionBatchCommit')
    const upload = jest.spyOn(ctx.storage, 'putActionBatchBlob')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    const script = '00'.repeat(256)
    ctx.wallet.randomVals = randomVals
    const txids: string[] = []
    let change: string[] = []
    for (let i = 0; i < 2; i++) {
      const result = await ctx.wallet.createAction({
        outputs: [{ satoshis: 1, lockingScript: script, outputDescription: 'large repeated output script' }],
        description: 'Plan large payload action',
        options: { noSend: true, noSendChange: change, randomizeOutputs: false }
      })
      txids.push(result.txid!)
      change = result.noSendChange ?? []
    }
    await ctx.wallet.createAction({ description: 'Commit large payload batch', options: { sendWith: txids } })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
    const scriptDigest = actionBatchBlobDigest(asArray(script))
    expect(upload.mock.calls.filter(([args]) => args.digest === scriptDigest)).toHaveLength(1)
    expect(new Set(upload.mock.calls.map(([args]) => args.digest)).size).toBe(upload.mock.calls.length)
  })

  test('provider blob limits split logical blobs into deduplicated authenticated chunks', async () => {
    const getCapabilities = ctx.storage.getCapabilities.bind(ctx.storage)
    jest.spyOn(ctx.storage, 'getCapabilities').mockImplementation(async () => {
      const capabilities = await getCapabilities()
      return {
        actionBatch: {
          ...capabilities.actionBatch!,
          maxInlineBytes: 1,
          maxBlobBytes: 128,
          maxConcurrentUploads: 2
        }
      }
    })
    const upload = jest.spyOn(ctx.storage, 'putActionBatchBlob')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    const script = '00'.repeat(1024)
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      outputs: [{ satoshis: 1, lockingScript: script, outputDescription: 'chunked output script' }],
      description: 'Plan chunked payload action',
      options: { noSend: true, randomizeOutputs: false }
    })
    await ctx.wallet.createAction({ description: 'Commit chunked payload batch', options: { sendWith: [staged.txid!] } })

    const scriptDigest = actionBatchBlobDigest(asArray(script))
    const manifest = commit.mock.calls[0][0]
    expect(manifest.blobChunks?.[scriptDigest]?.length).toBeGreaterThan(1)
    expect(upload.mock.calls.every(([args]) => args.bytes.length <= 128)).toBe(true)
    expect(new Set(upload.mock.calls.map(([args]) => args.digest)).size).toBe(upload.mock.calls.length)
  })
})
