import { Beef, CreateActionArgs, Telemetry, TelemetryEvent, Transaction, Validation } from '@bsv/sdk'
import { Wallet } from '../../../src/Wallet'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { actionBatchBlobDigest, actionBatchManifestDigest } from '../../../src/utility/actionBatchDigest'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'
import { cleanupExpiredActionBatches } from '../../../src/storage/methods/actionBatch'
import { specOpWalletBalance } from '../../../src/sdk/types'
import type { ActionBatchManifest } from '../../../src/sdk/ActionBatch.interfaces'
import { maxPossibleSatoshis } from '../../../src/storage/methods/generateChange'
import { additionalFundingTarget, fundingRunwayExtension } from '../../../src/signer/actionBatch/ActionBatchWorkspace'
import { WERR_INSUFFICIENT_FUNDS } from '../../../src/sdk/WERR_errors'

const randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]

function actionArgs(noSendChange: string[] = []): CreateActionArgs {
  return {
    outputs: [
      {
        satoshis: 1,
        lockingScript: '7551',
        outputDescription: 'batched workload output'
      }
    ],
    labels: ['action batch workload'],
    description: 'Plan dependent action locally',
    options: { noSend: true, noSendChange, randomizeOutputs: false }
  }
}

function rawTransaction(atomicBeef: number[], txid: string): number[] {
  const transaction = Beef.fromBinary(atomicBeef).findTxid(txid)?.tx
  expect(transaction).toBeDefined()
  return Array.from(transaction!.toUint8Array())
}

function feePaid(atomicBeef: number[], txid: string): number {
  const transaction = Beef.fromBinary(atomicBeef).findAtomicTransaction(txid)
  expect(transaction).toBeDefined()
  const inputs = transaction.inputs.reduce(
    (sum, input) => sum + (input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis ?? 0),
    0
  )
  const outputs = transaction.outputs.reduce((sum, output) => sum + output.satoshis, 0)
  return inputs - outputs
}

async function captureCommitManifest(
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
  await expect(
    ctx.wallet.createAction({
      description,
      options: { sendWith: txids, acceptDelayedBroadcast: false }
    })
  ).rejects.toThrow(marker)
  if (captured == null) throw new Error('commit manifest was not captured')
  return captured
}

describe('in-memory action batch workspace', () => {
  jest.setTimeout(120000)
  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName ?? 'actionBatch', 'auto')
    _tu.mockPostServicesAsSuccess([ctx])
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true } as any)
    jest.spyOn(ctx.activeStorage, 'getServices').mockReturnValue(ctx.services)
  })

  afterEach(async () => {
    await ctx.wallet.destroy()
  })

  test('default mode durably persists standalone noSend actions for later sendWith', async () => {
    // Recreate the wallet without selecting an action-batch mode. Existing
    // callers rely on a successful noSend returning only after its transaction
    // and reference are durable in storage.
    ctx.wallet = new Wallet({
      chain: ctx.chain,
      keyDeriver: ctx.keyDeriver,
      storage: ctx.storage,
      services: ctx.services,
      monitor: ctx.monitor
    })
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')

    const staged = await ctx.wallet.createAction(actionArgs())

    expect(begin).not.toHaveBeenCalled()
    const stored = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid: staged.txid },
      noRawTx: true
    })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual(expect.objectContaining({
      status: 'nosend',
      reference: expect.any(String)
    }))

    const sent = await ctx.wallet.createAction({
      description: 'Send the durable noSend action',
      options: { sendWith: [staged.txid!] }
    })
    expect(sent.sendWithResults).toContainEqual(expect.objectContaining({ txid: staged.txid }))
  })

  test('persisted noSend actions listed by txid can be aborted without exposing an internal reference', async () => {
    const legacyCtx = await _tu.createLegacyWalletSQLiteCopy('actionBatchAbortListedNoSend', 'legacy')
    try {
      _tu.mockPostServicesAsSuccess([legacyCtx])
      const created = await legacyCtx.wallet.createAction(actionArgs())
      const listed = await legacyCtx.wallet.listNoSendActions({ labels: ['action batch workload'] })
      expect(listed.actions).toContainEqual(expect.objectContaining({ txid: created.txid, status: 'nosend' }))

      await expect(legacyCtx.wallet.abortAction({ reference: created.txid! })).resolves.toEqual({ aborted: true })
      const stored = await legacyCtx.activeStorage.findTransactions({
        partial: { userId: legacyCtx.userId, txid: created.txid },
        noRawTx: true
      })
      expect(stored[0].status).toBe('failed')
    } finally {
      await legacyCtx.wallet.destroy()
    }
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

    const preloadInputs = jest.spyOn(ctx.activeStorage, 'findOutputsByOutpointsForUpdate')
    const preloadBaskets = jest.spyOn(ctx.activeStorage, 'findOrInsertOutputBasketsBulk')
    const preloadTags = jest.spyOn(ctx.activeStorage, 'findOrInsertOutputTagsBulk')
    const preloadLabel = jest.spyOn(ctx.activeStorage, 'findOrInsertTxLabel')
    const final = await ctx.wallet.createAction({
      description: 'Commit planned action batch',
      options: { sendWith: txids }
    })
    expect(final.sendWithResults).toHaveLength(txids.length)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(begin).toHaveBeenCalledTimes(1)
    expect(extend).not.toHaveBeenCalled()
    expect(preloadInputs).toHaveBeenCalledTimes(1)
    expect(preloadBaskets).toHaveBeenCalledTimes(1)
    expect(preloadTags).toHaveBeenCalledTimes(1)
    expect(preloadLabel).toHaveBeenCalledTimes(1)

    const manifest = commit.mock.calls[0][0]
    const retry = await ctx.storage.commitActionBatch(manifest)
    expect(retry.alreadyCommitted).toBe(true)
    expect(retry.committedTxids).toEqual(txids)

    const persisted = await ctx.wallet.listActions({ labels: ['action batch workload'] })
    expect(persisted.totalActions).toBe(10)
  })

  test('persisted proof requests retain only the external frontier and reconstruct the full chain', async () => {
    ctx.wallet.randomVals = randomVals
    const script = '00'.repeat(64 * 1024)
    const txids: string[] = []
    let change: string[] = []
    for (let index = 0; index < 8; index++) {
      const staged = await ctx.wallet.createAction({
        outputs: [
          {
            satoshis: 1,
            lockingScript: script,
            outputDescription: 'generic repetitive data output'
          }
        ],
        description: `Build generic proof-frontier action ${String(index)}`,
        options: { noSend: true, noSendChange: change, randomizeOutputs: false }
      })
      txids.push(staged.txid!)
      change = staged.noSendChange ?? []
    }
    await ctx.wallet.createAction({
      description: 'Persist generic proof-frontier workload',
      options: { sendWith: txids, acceptDelayedBroadcast: true }
    })

    const reqs = await ctx.activeStorage.findProvenTxReqs({ partial: {} })
    const byTxid = new Map(reqs.filter(req => txids.includes(req.txid)).map(req => [req.txid, req]))
    expect(byTxid.size).toBe(txids.length)

    let frontierBytes = 0
    for (const txid of txids) {
      const inputBEEF = byTxid.get(txid)?.inputBEEF
      expect(inputBEEF).toBeDefined()
      frontierBytes += inputBEEF?.length ?? 0
      const frontier = Beef.fromBinary(inputBEEF!)
      expect(txids.some(batchTxid => frontier.findTxid(batchTxid) != null)).toBe(false)
    }

    const reconstructed = new Beef()
    await ctx.activeStorage.mergeReqToBeefToShareExternally(byTxid.get(txids.at(-1)!)!, reconstructed, [])
    expect(txids.every(txid => reconstructed.findTxid(txid) != null)).toBe(true)
    expect(frontierBytes).toBeLessThan(reconstructed.toUint8Array().length * 2)
  })

  test('concurrent planning shares one workspace without reusing inputs', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals

    const planned = await Promise.all([ctx.wallet.createAction(actionArgs()), ctx.wallet.createAction(actionArgs())])
    const txids = planned.map(action => action.txid!)

    expect(begin).toHaveBeenCalledTimes(1)
    expect(new Set(txids).size).toBe(2)
    await expect(
      ctx.wallet.createAction({
        description: 'Commit concurrently planned actions',
        options: { sendWith: txids }
      })
    ).resolves.toBeDefined()
  })

  test('noSend listing includes staged actions and abort releases their workspace', async () => {
    const begin = jest.spyOn(ctx.storage, 'beginActionBatch')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())

    const listed = await ctx.wallet.listNoSendActions({ labels: [] })
    expect(listed.actions).toContainEqual(expect.objectContaining({ txid: staged.txid, status: 'nosend' }))
    expect((await ctx.wallet.listFailedActions({ labels: [] })).actions).not.toContainEqual(
      expect.objectContaining({ txid: staged.txid })
    )

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

  test('extension accounting requests only the incremental shortfall', () => {
    expect(additionalFundingTarget(new WERR_INSUFFICIENT_FUNDS(31_596, 6))).toBe(6)
  })

  test('runway accounting credits unconsumed reserved inputs by count and value', () => {
    expect(fundingRunwayExtension(4, 1, 5_000, [{ satoshis: 1_500 }])).toEqual({
      nextRunwayTarget: 8,
      requestedOutputs: 7,
      targetSatoshis: 38_500
    })
    expect(
      fundingRunwayExtension(
        4,
        1,
        5_000,
        Array.from({ length: 8 }, () => ({ satoshis: 5_000 }))
      )
    ).toBeUndefined()
    expect(fundingRunwayExtension(64, 1, 100, [{ satoshis: 100 }])).toEqual({
      nextRunwayTarget: 128,
      requestedOutputs: 127,
      targetSatoshis: 12_700
    })
  })

  test('staged outputs and balance are coherent before commit', async () => {
    ctx.wallet.randomVals = randomVals
    const balanceBefore = await ctx.wallet.listOutputs({ basket: specOpWalletBalance })
    const staged = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [
        {
          satoshis: 1,
          lockingScript: '7551',
          outputDescription: 'staged basket output',
          basket: 'funding basket'
        }
      ]
    })
    const listed = await ctx.wallet.listOutputs({ basket: 'funding basket', include: 'locking scripts' })
    expect(listed.outputs).toContainEqual(
      expect.objectContaining({
        outpoint: expect.stringMatching(`^${staged.txid}\\.`),
        lockingScript: '7551'
      })
    )
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
    const events: TelemetryEvent[] = []
    Reflect.set(
      ctx.wallet,
      'telemetry',
      new Telemetry({
        sink: { capture: event => events.push(event) }
      })
    )
    const legacyCreate = jest.spyOn(ctx.storage, 'createAction')
    const legacyProcess = jest.spyOn(ctx.storage, 'processAction')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    ctx.wallet.autoKnownTxids = true
    ctx.wallet.randomVals = randomVals
    const created = await ctx.wallet.createAction({
      ...actionArgs(),
      options: { ...actionArgs().options, signAndProcess: false }
    })
    expect(created.signableTransaction).toBeDefined()
    const pending = ctx.wallet.pendingSignActions[created.signableTransaction!.reference]
    pending.dcr.inputBeef = Array.from(pending.dcr.inputBeef as Uint8Array)
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
    expect(events.some(event => event.name === 'wallet.create_action' && event.spanStatus === 'ok')).toBe(true)
    expect(events.some(event => event.name === 'wallet.create_action.prepare_known_txids' && event.spanStatus === 'ok'))
      .toBe(true)
    expect(events.some(event => event.name === 'wallet.sign_action' && event.spanStatus === 'ok')).toBe(true)
    expect(events.some(event => event.name === 'wallet.crypto.transaction_sign')).toBe(true)
  })

  test('an open batch does not capture a legacy pending signAction', async () => {
    const legacyCreate = jest.spyOn(ctx.storage, 'createAction')
    const legacyProcess = jest.spyOn(ctx.storage, 'processAction')
    ctx.wallet.randomVals = randomVals
    const pending = await ctx.wallet.createAction({
      outputs: [
        {
          satoshis: 1,
          lockingScript: '51',
          outputDescription: 'legacy pending output'
        }
      ],
      description: 'Create legacy pending action before the batch',
      options: { noSend: false, signAndProcess: false, randomizeOutputs: false }
    })
    const staged = await ctx.wallet.createAction(actionArgs())

    await expect(
      ctx.wallet.signAction({
        reference: pending.signableTransaction!.reference,
        spends: {}
      })
    ).resolves.toEqual(expect.objectContaining({ txid: expect.any(String) }))
    expect(legacyCreate).toHaveBeenCalledTimes(1)
    expect(legacyProcess).toHaveBeenCalledTimes(1)

    await expect(
      ctx.wallet.createAction({
        description: 'Commit batch after legacy pending signAction',
        options: { sendWith: [staged.txid!] }
      })
    ).resolves.toBeDefined()
  })

  test('first-action returnTXIDOnly retains internal proof data through commit', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      ...actionArgs(),
      options: { ...actionArgs().options, returnTXIDOnly: true }
    })
    expect(staged.txid).toBeDefined()
    expect(staged.tx).toBeUndefined()
    await expect(
      ctx.wallet.createAction({
        description: 'Commit returnTXIDOnly batch',
        options: { sendWith: [staged.txid!] }
      })
    ).resolves.toBeDefined()
  })

  test('maxPossibleSatoshis output is adjusted and committed atomically', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      outputs: [
        {
          satoshis: maxPossibleSatoshis,
          lockingScript: '51',
          outputDescription: 'maximum available batch output'
        }
      ],
      description: 'Plan maximum available output',
      options: { noSend: true, randomizeOutputs: false }
    })
    await expect(
      ctx.wallet.createAction({
        description: 'Commit maximum available output',
        options: { sendWith: [staged.txid!] }
      })
    ).resolves.toBeDefined()
  })

  test('staged custom inputs are resolved locally without reserving them', async () => {
    const extend = jest.spyOn(ctx.storage, 'extendActionBatch')
    ctx.wallet.randomVals = randomVals
    const source = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [
        {
          satoshis: 2,
          lockingScript: '7551',
          outputDescription: 'staged explicit input source',
          basket: 'funding basket'
        }
      ]
    })
    const spending = await ctx.wallet.createAction({
      inputs: [
        {
          outpoint: `${source.txid}.0`,
          unlockingScript: '00',
          inputDescription: 'spend staged explicit input'
        }
      ],
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

  test('version-1 action batch providers retain the original manifest protocol', async () => {
    const currentCapabilities = await ctx.storage.getCapabilities()
    const current = currentCapabilities.actionBatch
    expect(current).toBeDefined()
    jest.spyOn(ctx.storage, 'getCapabilities').mockResolvedValue({
      actionBatch: {
        version: 1,
        maxInlineBytes: current!.maxInlineBytes,
        maxBlobBytes: current!.maxBlobBytes,
        maxConcurrentUploads: current!.maxConcurrentUploads,
        leaseMs: current!.leaseMs,
        hardLifetimeMs: current!.hardLifetimeMs,
        compactBegin: current!.compactBegin
      }
    })
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    const commitByDigest = jest.spyOn(ctx.storage, 'commitActionBatchByDigest')
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    await ctx.wallet.createAction({
      description: 'Commit through the original action batch protocol',
      options: { sendWith: [staged.txid!] }
    })

    expect(commitByDigest).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledTimes(1)
    const manifest = commit.mock.calls[0][0]
    expect(manifest.format).toBeUndefined()
    expect(manifest.actions[0].deriveLockingScripts).toBeUndefined()
    expect(manifest.actions[0].plan.inputs.every(input => input.sourceLockingScript != null)).toBe(true)
    const requestedScriptDigest = actionBatchBlobDigest(asArray(actionArgs().outputs![0].lockingScript))
    expect(manifest.inlineBlobs?.[requestedScriptDigest]).toBeDefined()
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
    await expect(
      ctx.wallet.createAction({
        outputs: [{ satoshis: 2_000_000_000, lockingScript: '51', outputDescription: 'unfundable output' }],
        description: 'Exhaust available action batch funding',
        options: { noSend: true, randomizeOutputs: false }
      })
    ).rejects.toBeDefined()
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

    await expect(
      ctx.wallet.createAction({
        description: 'Commit after lease expiry',
        options: { sendWith: [staged.txid!] }
      })
    ).resolves.toBeDefined()
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

    await expect(
      ctx.wallet.createAction({
        description: 'Conflicting expired batch commit',
        options: { sendWith: [staged.txid!] }
      })
    ).rejects.toBeDefined()
    await ctx.storage.abortActionBatch(competing.batchId)
  })

  test('a broadcaster failure leaves one durable commit that can be retried', async () => {
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    jest
      .spyOn(ctx.activeStorage, 'attemptToPostReqsToNetwork')
      .mockRejectedValueOnce(new Error('simulated broadcaster outage'))
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    await expect(
      ctx.wallet.createAction({
        description: 'Commit before simulated broadcaster failure',
        options: { sendWith: [staged.txid!], acceptDelayedBroadcast: false }
      })
    ).rejects.toThrow('simulated broadcaster outage')

    const firstManifest = commit.mock.calls[0][0]
    const retried = await ctx.wallet.createAction({
      description: 'Retry commit after simulated broadcaster failure',
      options: { sendWith: [staged.txid!], acceptDelayedBroadcast: false }
    })
    expect(retried.sendWithResults).toEqual([expect.objectContaining({ txid: staged.txid, status: 'unproven' })])
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
    const actions = [
      first,
      {
        ...first,
        reference: second.reference,
        txid: duplicateTxid,
        rawTxDigest: duplicateDigest,
        plan: { ...first.plan, reference: second.reference, lockTime: 1 },
        metadata: second.metadata
      }
    ]
    const withoutDigest = {
      ...captured,
      actions,
      inlineBlobs: { ...captured.inlineBlobs, [duplicateDigest]: duplicateRaw }
    }
    const { digest: _digest, ...semanticManifest } = withoutDigest
    const invalid = { ...semanticManifest, digest: actionBatchManifestDigest(semanticManifest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('not double spend')
  })

  test('duplicate spends fail while planning and leave the valid batch commit-able', async () => {
    ctx.wallet.randomVals = randomVals
    const source = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [
        {
          satoshis: 2,
          lockingScript: '7551',
          outputDescription: 'duplicate-spend source',
          basket: 'funding basket'
        }
      ]
    })
    const spendArgs: CreateActionArgs = {
      inputs: [
        {
          outpoint: `${source.txid}.0`,
          unlockingScript: '00',
          inputDescription: 'spend staged source'
        }
      ],
      inputBEEF: source.tx,
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'spend result' }],
      description: 'Spend staged source once',
      options: { noSend: true, randomizeOutputs: false }
    }
    const first = await ctx.wallet.createAction(spendArgs)
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')

    await expect(
      ctx.wallet.createAction({
        ...spendArgs,
        description: 'Attempt duplicate staged spend'
      })
    ).rejects.toThrow('already consumed by this action batch')
    expect(commit).not.toHaveBeenCalled()

    await expect(
      ctx.wallet.createAction({
        description: 'Commit after rejected duplicate spend',
        options: { sendWith: [source.txid!, first.txid!] }
      })
    ).resolves.toBeDefined()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  test('atomic validation rejects a raw transaction with an invalidated signature', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture signature-validation manifest')

    const action = captured.actions[0]
    const originalRaw = action.rawTxDigest == null ? undefined : captured.inlineBlobs?.[action.rawTxDigest]
    if (originalRaw == null) throw new Error('captured manifest did not inline its transaction')
    const alteredRaw = Uint8Array.from(originalRaw)
    alteredRaw[alteredRaw.length - 4] = 1
    const _altered = Transaction.fromBinary(alteredRaw)
    const alteredTxid = Transaction.fromBinary(alteredRaw).id('hex')
    const alteredDigest = actionBatchBlobDigest(alteredRaw)
    const actions = [
      {
        ...action,
        txid: alteredTxid,
        rawTxDigest: alteredDigest,
        plan: { ...action.plan, lockTime: 1 }
      }
    ]
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
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture source-value validation manifest')
    const actions = captured.actions.map((action, actionIndex) =>
      actionIndex === 0
        ? {
            ...action,
            plan: {
              ...action.plan,
              inputs: action.plan.inputs.map((input, inputIndex) =>
                inputIndex === 0 ? { ...input, sourceSatoshis: input.sourceSatoshis + 1_000_000 } : input
              )
            }
          }
        : action
    )
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('match proven source outputs')
  })

  test('atomic validation rejects ambiguous input mappings', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture input-mapping validation manifest')
    const actions = captured.actions.map((action, actionIndex) =>
      actionIndex === 0
        ? {
            ...action,
            plan: {
              ...action.plan,
              inputs: action.plan.inputs.map((input, inputIndex) => (inputIndex === 0 ? { ...input, vin: 1 } : input))
            }
          }
        : action
    )
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
    const actions = captured.actions.map((action, actionIndex) =>
      actionIndex === 0
        ? {
            ...action,
            plan: {
              ...action.plan,
              inputs: action.plan.inputs.map((input, inputIndex) =>
                inputIndex === 0 ? { ...input, providedBy: 'you' as const } : input
              )
            }
          }
        : action
    )
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
    const actions = captured.actions.map((action, actionIndex) =>
      actionIndex === 1
        ? {
            ...action,
            reference: duplicateReference,
            plan: { ...action.plan, reference: duplicateReference }
          }
        : action
    )
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('unique references')
  })

  test('atomic validation rejects altered requested-output metadata', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture output-metadata validation manifest')
    const actions = captured.actions.map((action, actionIndex) =>
      actionIndex === 0
        ? {
            ...action,
            metadata: {
              ...action.metadata,
              outputs: action.metadata.outputs.map((output, outputIndex) =>
                outputIndex === 0 ? { ...output, basket: 'altered basket' } : output
              )
            }
          }
        : action
    )
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('match planned requested outputs')
  })

  test('atomic validation binds commissions to the active storage policy', async () => {
    ctx.activeStorage.commissionSatoshis = 5
    ctx.activeStorage.commissionPubKeyHex = ctx.identityKey
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture commission validation manifest')
    const actions = captured.actions.map(action => ({
      ...action,
      plan: {
        ...action.plan,
        outputs: action.plan.outputs.map(output =>
          output.purpose === 'storage-commission' ? { ...output, satoshis: output.satoshis + 1 } : output
        )
      }
    }))
    const { digest: _digest, ...withoutDigest } = { ...captured, actions }
    const invalid = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(invalid)).rejects.toThrow('active storage commission')
    await expect(ctx.storage.commitActionBatch(captured)).resolves.toBeDefined()
  })

  test('atomic validation preserves all compact-manifest boundary failures', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture compact-manifest boundary validation')
    const action = captured.actions[0]
    const rawDigest = action.rawTxDigest
    if (rawDigest == null || captured.inlineBlobs?.[rawDigest] == null) {
      throw new Error('captured manifest did not inline its transaction')
    }
    const capturedRaw = Uint8Array.from(captured.inlineBlobs[rawDigest])

    const redigest = (manifest: ActionBatchManifest): ActionBatchManifest => {
      const { digest: _digest, ...semantic } = manifest
      return {
        ...semantic,
        digest: actionBatchManifestDigest(semantic)
      }
    }
    const replaceAction = (replacement: ActionBatchManifest['actions'][number]): ActionBatchManifest =>
      redigest({ ...captured, actions: [replacement] })

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          reference: `${action.reference}-mismatch`
        })
      )
    ).rejects.toThrow('match plan')

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          txid: '00'.repeat(32)
        })
      )
    ).rejects.toThrow('match raw transaction')

    const extraOutputTransaction = Transaction.fromBinary(capturedRaw)
    extraOutputTransaction.addOutput({
      satoshis: 0,
      lockingScript: extraOutputTransaction.outputs[0].lockingScript
    })
    const extraOutputRaw = extraOutputTransaction.toUint8Array()
    const extraOutputDigest = actionBatchBlobDigest(extraOutputRaw)
    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          actions: [
            {
              ...action,
              txid: extraOutputTransaction.id('hex'),
              rawTxDigest: extraOutputDigest
            }
          ],
          inlineBlobs: {
            ...captured.inlineBlobs,
            [extraOutputDigest]: extraOutputRaw
          }
        })
      )
    ).rejects.toThrow('match planned input and output counts')

    const zeroFeeTransaction = Transaction.fromBinary(capturedRaw)
    const plannedInputSatoshis = action.plan.inputs.reduce((sum, input) => sum + input.sourceSatoshis, 0)
    const transactionOutputSatoshis = zeroFeeTransaction.outputs.reduce((sum, output) => sum + output.satoshis, 0)
    const currentFee = plannedInputSatoshis - transactionOutputSatoshis
    expect(currentFee).toBeGreaterThan(0)
    zeroFeeTransaction.outputs[0].satoshis! += currentFee
    const zeroFeeRaw = zeroFeeTransaction.toUint8Array()
    const zeroFeeDigest = actionBatchBlobDigest(zeroFeeRaw)
    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          actions: [
            {
              ...action,
              txid: zeroFeeTransaction.id('hex'),
              rawTxDigest: zeroFeeDigest,
              plan: {
                ...action.plan,
                outputs: action.plan.outputs.map((output, index) =>
                  index === 0 ? { ...output, satoshis: output.satoshis + currentFee } : output
                )
              },
              metadata: {
                ...action.metadata,
                outputs: action.metadata.outputs.map((output, index) =>
                  index === 0 ? { ...output, satoshis: output.satoshis + currentFee } : output
                )
              }
            }
          ],
          inlineBlobs: {
            ...captured.inlineBlobs,
            [zeroFeeDigest]: zeroFeeRaw
          }
        })
      )
    ).rejects.toThrow('meet the active storage fee model')

    const nLockTimeIsFinal = jest.spyOn(ctx.services, 'nLockTimeIsFinal').mockResolvedValueOnce(false)
    await expect(ctx.storage.commitActionBatch(captured)).rejects.toThrow('final nLockTime and sequence values')
    nLockTimeIsFinal.mockRestore()

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          plan: {
            ...action.plan,
            version: action.plan.version + 1
          }
        })
      )
    ).rejects.toThrow('match planned version and lockTime')

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          lockingScriptDigests: action.lockingScriptDigests?.map((digest, index) =>
            index === action.plan.outputs.length - 1 ? action.lockingScriptDigests![0] : digest
          ),
          plan: {
            ...action.plan,
            outputs: action.plan.outputs.map((output, index) =>
              index === action.plan.outputs.length - 1 ? { ...output, vout: 0 } : output
            )
          }
        })
      )
    ).rejects.toThrow('complete sequential vout mappings')

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          plan: {
            ...action.plan,
            noSendChangeOutputVouts: [action.plan.outputs.length + 1]
          }
        })
      )
    ).rejects.toThrow('match planned change outputs')

    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          plan: {
            ...action.plan,
            inputs: action.plan.inputs.map((input, index) =>
              index === 0 ? { ...input, sourceTxid: '11'.repeat(32) } : input
            )
          }
        })
      )
    ).rejects.toThrow('match planned transaction outpoints')

    const changeIndex = action.plan.outputs.findIndex(output => output.purpose === 'change')
    expect(changeIndex).toBeGreaterThanOrEqual(0)
    await expect(
      ctx.storage.commitActionBatch(
        replaceAction({
          ...action,
          plan: {
            ...action.plan,
            outputs: action.plan.outputs.map((output, index) =>
              index === changeIndex ? { ...output, satoshis: output.satoshis + 1 } : output
            )
          }
        })
      )
    ).rejects.toThrow('match planned transaction outputs')

    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          actions: [
            action,
            {
              ...action,
              reference: `${action.reference}-duplicate-txid`,
              plan: {
                ...action.plan,
                reference: `${action.reference}-duplicate-txid`
              }
            }
          ]
        })
      )
    ).rejects.toThrow('unique txids')

    const withoutRawInline = {
      ...captured.inlineBlobs
    }
    delete withoutRawInline[rawDigest]

    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          inlineBlobs: withoutRawInline,
          blobChunks: { ...captured.blobChunks, [rawDigest]: [] }
        })
      )
    ).rejects.toThrow('one or more blob chunks')

    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          inlineBlobs: withoutRawInline,
          blobChunks: {
            ...captured.blobChunks,
            [rawDigest]: ['22'.repeat(32)]
          }
        })
      )
    ).rejects.toThrow('missing action batch blob')

    const corruptDigest = '33'.repeat(32)
    await expect(
      ctx.storage.commitActionBatch(
        redigest({
          ...captured,
          inlineBlobs: {
            ...withoutRawInline,
            [corruptDigest]: Uint8Array.from([1, 2, 3])
          },
          blobChunks: {
            ...captured.blobChunks,
            [rawDigest]: [corruptDigest]
          }
        })
      )
    ).rejects.toThrow('content matching digest')

    const logicalChunk = Uint8Array.from([1, 2, 3])
    const logicalChunkDigest = actionBatchBlobDigest(logicalChunk)
    const logicalMismatch = redigest({
      ...captured,
      inlineBlobs: undefined,
      dependencyBeef: undefined,
      blobChunks: {
        ...captured.blobChunks,
        [rawDigest]: [logicalChunkDigest]
      }
    })
    const prepared = await ctx.storage.prepareActionBatchCommit(logicalMismatch)
    const uploadBytes: Record<string, number[] | Uint8Array> = {
      ...captured.inlineBlobs,
      [logicalChunkDigest]: logicalChunk
    }
    if (captured.dependencyBeefDigest != null && captured.dependencyBeef != null) {
      uploadBytes[captured.dependencyBeefDigest] = captured.dependencyBeef
    }
    for (const digest of prepared.missingDigests) {
      const bytes = uploadBytes[digest]
      if (bytes == null) throw new Error(`missing captured bytes for ${digest}`)
      await ctx.storage.putActionBatchBlob({
        batchId: logicalMismatch.batchId,
        digest,
        bytes
      })
    }
    await expect(ctx.storage.commitActionBatch(logicalMismatch)).rejects.toThrow('chunks matching digest')
  })

  test('compact manifests accept transaction bytes inline without a digest', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture inline-transaction compatibility')
    const action = captured.actions[0]
    const rawDigest = action.rawTxDigest
    if (rawDigest == null || captured.inlineBlobs?.[rawDigest] == null) {
      throw new Error('captured manifest did not inline its transaction')
    }
    const inlineBlobs = { ...captured.inlineBlobs }
    const rawTx = inlineBlobs[rawDigest]
    delete inlineBlobs[rawDigest]
    const { digest: _digest, ...semantic } = {
      ...captured,
      actions: [
        {
          ...action,
          rawTx,
          rawTxDigest: undefined
        }
      ],
      inlineBlobs
    }
    const manifest: ActionBatchManifest = {
      ...semantic,
      digest: actionBatchManifestDigest(semantic)
    }

    await expect(ctx.storage.commitActionBatch(manifest)).resolves.toEqual(
      expect.objectContaining({
        alreadyCommitted: false,
        committedTxids: [staged.txid]
      })
    )
  })

  test('concurrent identical commits persist and broadcast exactly once', async () => {
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction(actionArgs())
    const captured = await captureCommitManifest(ctx, [staged.txid!], 'Capture concurrent-commit manifest')
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

    await expect(ctx.wallet.abortAction({ reference: result.signableTransaction!.reference })).resolves.toEqual({
      aborted: true
    })
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toHaveLength(0)
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('aborted')
    expect((await ctx.wallet.listActions({ labels: ['action batch workload'] })).totalActions).toBe(0)
  })

  test('aborting one staged action preserves independent signed siblings', async () => {
    ctx.wallet.randomVals = randomVals
    const first = await ctx.wallet.createAction({
      ...actionArgs(),
      labels: ['abort batch sibling'],
      options: { ...actionArgs().options, signAndProcess: false }
    })
    const firstSigned = await ctx.wallet.signAction({
      reference: first.signableTransaction!.reference,
      spends: {},
      options: { noSend: true }
    })
    const sibling = await ctx.wallet.createAction({
      ...actionArgs(),
      labels: ['surviving batch sibling']
    })

    await expect(
      ctx.wallet.abortAction({
        reference: first.signableTransaction!.reference
      })
    ).resolves.toEqual({ aborted: true })
    expect((await ctx.wallet.listActions({ labels: ['abort batch sibling'] })).totalActions).toBe(0)
    expect((await ctx.wallet.listActions({ labels: ['surviving batch sibling'] })).actions).toContainEqual(
      expect.objectContaining({ txid: sibling.txid })
    )

    await expect(
      ctx.wallet.createAction({
        description: 'Commit surviving batch sibling',
        options: { sendWith: [sibling.txid!] }
      })
    ).resolves.toBeDefined()
    expect(
      await ctx.activeStorage.findTransactions({
        partial: { userId: ctx.userId, txid: firstSigned.txid }
      })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findTransactions({
        partial: { userId: ctx.userId, txid: sibling.txid }
      })
    ).toHaveLength(1)
  })

  test('aborting a staged parent is refused while another action depends on it', async () => {
    ctx.wallet.randomVals = randomVals
    const source = await ctx.wallet.createAction({
      ...actionArgs(),
      outputs: [
        {
          satoshis: 2,
          lockingScript: '7551',
          outputDescription: 'abort dependency source',
          basket: 'funding basket'
        }
      ]
    })
    const child = await ctx.wallet.createAction({
      inputs: [
        {
          outpoint: `${source.txid}.0`,
          unlockingScript: '00',
          inputDescription: 'depend on staged source'
        }
      ],
      inputBEEF: source.tx,
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'dependent result' }],
      description: 'Create staged dependency',
      options: { noSend: true, randomizeOutputs: false }
    })

    await expect(ctx.wallet.abortAction({ reference: source.txid! })).rejects.toThrow(
      'another staged action depends on it'
    )
    await expect(
      ctx.wallet.createAction({
        description: 'Commit dependency after refused abort',
        options: { sendWith: [source.txid!, child.txid!] }
      })
    ).resolves.toBeDefined()
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
      outputs: [
        {
          satoshis: 1,
          lockingScript: '51',
          outputDescription: 'normal action output'
        }
      ],
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

  test('large finalization derives scripts, packs raw transactions, and commits by manifest digest', async () => {
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
    const uploadPack = jest.spyOn(ctx.storage, 'putActionBatchPack')
    const commit = jest.spyOn(ctx.storage, 'commitActionBatch')
    const commitByDigest = jest.spyOn(ctx.storage, 'commitActionBatchByDigest')
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
    expect(commit).not.toHaveBeenCalled()
    expect(commitByDigest).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    expect(uploadPack).toHaveBeenCalled()
    const manifest = prepare.mock.calls[0][0]
    expect(manifest.format).toBe(2)
    expect(commitByDigest).toHaveBeenCalledWith({
      batchId: manifest.batchId,
      digest: manifest.digest
    })
    const scriptDigest = actionBatchBlobDigest(asArray(script))
    expect(
      manifest.actions.every(
        action =>
          action.deriveLockingScripts === true &&
          action.plan.inputs.every(input => input.sourceLockingScript == null) &&
          action.plan.outputs.every(output => output.lockingScript === '') &&
          action.lockingScriptDigests?.includes(scriptDigest) === true
      )
    ).toBe(true)
    expect(uploadPack.mock.calls.flatMap(([args]) => args.items).some(item => item.digest === scriptDigest)).toBe(false)
  })

  test('final preparation retries a failed speculative eager pack', async () => {
    const capabilities = (await ctx.storage.getCapabilities()).actionBatch
    expect(capabilities?.packedUploads).toBeDefined()
    jest.spyOn(ctx.storage, 'getCapabilities').mockResolvedValue({
      actionBatch: {
        ...capabilities!,
        maxInlineBytes: 1,
        maxBlobBytes: 512,
        packedUploads: {
          ...capabilities!.packedUploads!,
          maxPackBytes: 512,
          eager: true
        }
      }
    })
    const putPack = ctx.storage.putActionBatchPack.bind(ctx.storage)
    const uploadPack = jest
      .spyOn(ctx.storage, 'putActionBatchPack')
      .mockRejectedValueOnce(new Error('transient eager upload failure'))
      .mockImplementation(async args => await putPack(args))
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      outputs: [
        {
          satoshis: 1,
          lockingScript: '00'.repeat(2048),
          outputDescription: 'generic eager retry output'
        }
      ],
      description: 'Stage an eager upload retry',
      options: { noSend: true, randomizeOutputs: false }
    })

    await expect(
      ctx.wallet.createAction({
        description: 'Commit after the speculative upload retry',
        options: { sendWith: [staged.txid!] }
      })
    ).resolves.toBeDefined()
    expect(uploadPack.mock.calls.length).toBeGreaterThan(1)
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
    const uploadPack = jest.spyOn(ctx.storage, 'putActionBatchPack')
    const prepare = jest.spyOn(ctx.storage, 'prepareActionBatchCommit')
    const script = '00'.repeat(1024)
    ctx.wallet.randomVals = randomVals
    const staged = await ctx.wallet.createAction({
      outputs: [{ satoshis: 1, lockingScript: script, outputDescription: 'chunked output script' }],
      description: 'Plan chunked payload action',
      options: { noSend: true, randomizeOutputs: false }
    })
    await ctx.wallet.createAction({
      description: 'Commit chunked payload batch',
      options: { sendWith: [staged.txid!] }
    })

    const manifest = prepare.mock.calls[0][0]
    const rawDigest = manifest.actions[0].rawTxDigest
    expect(rawDigest).toBeDefined()
    expect(manifest.blobChunks?.[rawDigest!]?.length).toBeGreaterThan(1)
    expect(upload).not.toHaveBeenCalled()
    const packedItems = uploadPack.mock.calls.flatMap(([args]) => args.items)
    expect(packedItems.every(item => item.bytes.length <= 128)).toBe(true)
    expect(new Set(packedItems.map(item => item.digest)).size).toBe(packedItems.length)
  })
})
