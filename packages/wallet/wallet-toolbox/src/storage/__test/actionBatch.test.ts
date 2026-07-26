import { Validation } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import { cleanupExpiredActionBatches } from '../methods/actionBatch'
import {
  ACTION_BATCH_MAX_INLINE_BYTES
} from '../methods/actionBatchBlobs'
import { actionBatchBlobDigest, actionBatchManifestDigest } from '../../utility/actionBatchDigest'

function firstAction () {
  return Validation.validateCreateActionArgs({
    description: 'reserve action batch funding',
    outputs: [{
      satoshis: 1,
      lockingScript: '51',
      outputDescription: 'reservation test output'
    }],
    options: { noSend: true, randomizeOutputs: false }
  })
}

async function preparePackedItems (
  ctx: TestWalletNoSetup,
  batchId: string,
  items: Array<{ digest: string, bytes: number[] | Uint8Array }>
): Promise<void> {
  const logicalBytes = items.flatMap(item => Array.from(item.bytes))
  const dependencyBeefDigest = actionBatchBlobDigest(logicalBytes)
  const withoutDigest = {
    batchId,
    actions: [],
    dependencyBeefDigest,
    blobChunks: { [dependencyBeefDigest]: items.map(item => item.digest) },
    sendWith: [],
    isDelayed: true
  }
  await ctx.storage.prepareActionBatchCommit({
    ...withoutDigest,
    digest: actionBatchManifestDigest(withoutDigest)
  })
}

describe('action batch reservations', () => {
  jest.setTimeout(120000)
  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName ?? 'actionBatchStorage')
  })

  afterEach(async () => {
    await ctx.wallet.destroy()
  })

  test('capability is advertised and concurrent batches reserve disjoint outputs', async () => {
    expect((await ctx.storage.getCapabilities()).actionBatch).toMatchObject({
      version: 1,
      compactBegin: true,
      packedUploads: { eager: false }
    })
    const first = await ctx.storage.beginActionBatch({ batchId: 'reservation-a', firstAction: firstAction() })
    const second = await ctx.storage.beginActionBatch({ batchId: 'reservation-b', firstAction: firstAction() })
    const firstIds = new Set(first.reservedOutputs.map(output => output.outputId))
    const secondIds = second.reservedOutputs.map(output => output.outputId)
    expect(secondIds.every(outputId => !firstIds.has(outputId))).toBe(true)
    expect(first.reservedOutputs.length).toBeLessThanOrEqual(4)
    expect(second.reservedOutputs.length).toBeLessThanOrEqual(4)
    await ctx.storage.abortActionBatch(first.batchId)
    await ctx.storage.abortActionBatch(second.batchId)
  })

  test('compact begin accepts deferred external proofs and exact script lengths', async () => {
    const action = firstAction()
    action.inputs.push({
      outpoint: { txid: '33'.repeat(32), vout: 0 },
      inputDescription: 'deferred external source',
      sequenceNumber: 0xffffffff,
      unlockingScriptLength: 1
    })
    action.outputs[0].lockingScript = ''

    const begun = await ctx.storage.beginActionBatch({
      batchId: 'compact-bootstrap',
      firstAction: action,
      firstActionOutputScriptLengths: [ACTION_BATCH_MAX_INLINE_BYTES * 4]
    })
    expect(begun.batchId).toBe('compact-bootstrap')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('compact begin validates its output length summary', async () => {
    await expect(ctx.storage.beginActionBatch({
      batchId: 'invalid-compact-bootstrap',
      firstAction: firstAction(),
      firstActionOutputScriptLengths: [2]
    })).rejects.toThrow('firstActionOutputScriptLengths')
  })

  test('legacy noSendChange cannot consume an output reserved by another workspace', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'legacy-reservation-guard', firstAction: firstAction() })
    const reserved = begun.reservedOutputs[0]
    expect(reserved).toBeDefined()
    const args = firstAction()
    args.options.noSendChange = [{ txid: reserved.txid!, vout: reserved.vout }]
    await expect(ctx.storage.createAction(args)).rejects.toThrow('active action batch')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('renewal extends the lease without crossing the hard lifetime', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'renew-batch', firstAction: firstAction() })
    const renewed = await ctx.storage.renewActionBatch(begun.batchId)
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(begun.expiresAt))
    expect(Date.parse(renewed.expiresAt)).toBeLessThanOrEqual(Date.parse(begun.hardExpiresAt))
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('first-action persisted noSendChange is reserved and returned explicitly', async () => {
    const legacy = await _tu.createLegacyWalletSQLiteCopy('actionBatchPersistedNoSendChange', 'legacy')
    try {
      legacy.wallet.randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]
      const seed = await legacy.wallet.createAction({
        description: 'seed persisted noSend change',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'seed output' }],
        options: { noSend: true, randomizeOutputs: false }
      })
      expect(seed.noSendChange).toBeDefined()
      const noSendChange = seed.noSendChange ?? []
      expect(noSendChange).not.toHaveLength(0)
      const first = Validation.validateCreateActionArgs({
        description: 'reuse persisted noSend change',
        outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'reuse output' }],
        options: { noSend: true, noSendChange, randomizeOutputs: false }
      })
      const begun = await legacy.storage.beginActionBatch({ batchId: 'persisted-nosend-change', firstAction: first })
      const explicitOutpoints = begun.explicitOutputs.map(output => `${output.txid}.${output.vout}`)
      expect(explicitOutpoints).toEqual(expect.arrayContaining(noSendChange))
      await legacy.storage.abortActionBatch(begun.batchId)
    } finally {
      await legacy.wallet.destroy()
    }
  })

  test('expiry cleanup releases reservations and staged blobs', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'expire-batch', firstAction: firstAction() })
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    expect(batch).toBeDefined()
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).not.toHaveLength(0)
    await ctx.activeStorage.updateActionBatch(batch!.actionBatchId, { expiresAt: new Date(Date.now() - 60_000) })

    expect(await cleanupExpiredActionBatches(ctx.activeStorage)).toBe(1)
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toHaveLength(0)
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('expired')
  })

  test('expiry cleanup rechecks a batch that was renewed after the candidate scan', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'renew-during-cleanup', firstAction: firstAction() })
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    expect(batch).toBeDefined()
    await ctx.activeStorage.updateActionBatch(batch!.actionBatchId, { expiresAt: new Date(Date.now() - 60_000) })
    const findExpired = ctx.activeStorage.findExpiredActionBatches.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findExpiredActionBatches').mockImplementationOnce(async now => {
      const candidates = await findExpired(now)
      await ctx.activeStorage.updateActionBatch(batch!.actionBatchId, {
        expiresAt: new Date(Date.now() + 60_000)
      })
      return candidates
    })

    expect(await cleanupExpiredActionBatches(ctx.activeStorage)).toBe(0)
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).not.toHaveLength(0)
    expect((await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId))?.status).toBe('active')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('begin failure releases reservations created before dependency hydration', async () => {
    jest.spyOn(ctx.activeStorage, 'getBeefForTransaction').mockRejectedValueOnce(new Error('dependency hydration failed'))
    await expect(ctx.storage.beginActionBatch({
      batchId: 'begin-hydration-failure',
      firstAction: firstAction()
    })).rejects.toThrow('dependency hydration failed')
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, 'begin-hydration-failure')
    expect(batch?.status).toBe('aborted')
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toHaveLength(0)
  })

  test('extension hydration failure does not leak new reservations', async () => {
    const begun = await ctx.storage.beginActionBatch({
      batchId: 'extension-hydration-failure',
      firstAction: firstAction()
    })
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    const before = await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)
    const hydrate = jest.spyOn(ctx.activeStorage, 'getBeefForTransaction')
      .mockRejectedValueOnce(new Error('dependency hydration failed'))

    await expect(ctx.storage.extendActionBatch({
      batchId: begun.batchId,
      targetSatoshis: 1,
      requestedOutputs: 1,
      explicitOutpoints: [],
      includeSourceTransactions: false
    })).rejects.toThrow('dependency hydration failed')

    expect(hydrate).toHaveBeenCalled()
    expect(await ctx.activeStorage.findActionBatchOutputIds(batch!.actionBatchId)).toEqual(before)
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('begin atomically rejects funding spent after candidate selection', async () => {
    const findForUpdate = ctx.activeStorage.findOutputsByOutpointsForUpdate.bind(ctx.activeStorage)
    jest.spyOn(ctx.activeStorage, 'findOutputsByOutpointsForUpdate').mockImplementationOnce(async (...args) => {
      const outputs = await findForUpdate(...args)
      return Object.fromEntries(Object.entries(outputs).map(([outpoint, output]) => [
        outpoint,
        { ...output, spendable: false, spentBy: 1 }
      ]))
    })

    await expect(ctx.storage.beginActionBatch({
      batchId: 'concurrently-spent-funding',
      firstAction: firstAction()
    })).rejects.toThrow('no longer spendable')
    expect(await ctx.activeStorage.findActionBatch(ctx.userId, 'concurrently-spent-funding')).toBeUndefined()
  })

  test('blob staging accepts only prepared manifest digests and idempotent duplicates', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'blob-batch', firstAction: firstAction() })
    const bytes = [1, 2, 3, 4]
    await expect(ctx.storage.putActionBatchBlob({
      batchId: begun.batchId,
      digest: '00'.repeat(32),
      bytes
    })).rejects.toBeDefined()
    const digest = actionBatchBlobDigest(bytes)
    await expect(ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest, bytes }))
      .rejects.toThrow('prepared action batch manifest')
    const withoutDigest = {
      batchId: begun.batchId,
      actions: [],
      dependencyBeefDigest: digest,
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await ctx.storage.prepareActionBatchCommit(manifest)
    const unrequestedBytes = [5, 6, 7]
    await expect(ctx.storage.putActionBatchBlob({
      batchId: begun.batchId,
      digest: actionBatchBlobDigest(unrequestedBytes),
      bytes: unrequestedBytes
    })).rejects.toThrow('prepared action batch manifest')
    await ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest, bytes })
    await ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest, bytes })
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    const storedBlob = await ctx.activeStorage.findActionBatchBlobRecord(batch!.actionBatchId, digest)
    expect(storedBlob?.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(storedBlob?.bytes ?? [])).toEqual(bytes)
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('packed blobs require manifest authorization and remain content-addressed', async () => {
    const begun = await ctx.storage.beginActionBatch({
      batchId: 'eager-pack',
      firstAction: firstAction()
    })
    const first = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index & 0xff)
    const second = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 11)
    const items = [first, second].map(bytes => ({
      digest: actionBatchBlobDigest(bytes),
      bytes
    }))

    const pack = {
      batchId: begun.batchId,
      items,
      maxPackBytes: 8 * 1024 * 1024,
      maxItems: 4096,
      preferredEncodings: ['identity'] as ['identity']
    }
    await expect(ctx.storage.putActionBatchPack(pack))
      .rejects.toThrow('prepared action batch manifest')
    await preparePackedItems(ctx, begun.batchId, items)
    await ctx.storage.putActionBatchPack(pack)
    await ctx.storage.putActionBatchPack(pack)

    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    const blobs = await ctx.activeStorage.findActionBatchBlobRecords(
      batch!.actionBatchId,
      items.map(item => item.digest)
    )
    expect(blobs).toHaveLength(2)
    expect(blobs.map(blob => blob.digest).sort()).toEqual(items.map(item => item.digest).sort())

    const unrequested = Uint8Array.of(4, 5, 6)
    await expect(ctx.storage.putActionBatchPack({
      ...pack,
      items: [{ digest: actionBatchBlobDigest(unrequested), bytes: unrequested }]
    })).rejects.toThrow('prepared action batch manifest')
    await expect(ctx.storage.putActionBatchPack({
      ...pack,
      items: [{ digest: '00'.repeat(32), bytes: first }],
    })).rejects.toThrow('match bytes')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('packed blob persistence spans conservative SQL parameter chunks', async () => {
    const begun = await ctx.storage.beginActionBatch({
      batchId: 'large-item-count-pack',
      firstAction: firstAction()
    })
    const items = Array.from({ length: 550 }, (_, index) => {
      const bytes = Uint8Array.of(index >>> 8, index & 0xff)
      return { digest: actionBatchBlobDigest(bytes), bytes }
    })

    await preparePackedItems(ctx, begun.batchId, items)
    await ctx.storage.putActionBatchPack({
      batchId: begun.batchId,
      items,
      maxPackBytes: 8 * 1024 * 1024,
      maxItems: 4096,
      preferredEncodings: ['identity']
    })

    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    const blobs = await ctx.activeStorage.findActionBatchBlobRecords(
      batch!.actionBatchId,
      items.map(item => item.digest)
    )
    expect(blobs).toHaveLength(items.length)
    expect(new Set(blobs.map(blob => blob.digest)).size).toBe(items.length)
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('logical blobs may span more than the former 64-chunk ceiling', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'many-chunks', firstAction: firstAction() })
    const chunk = [7]
    const chunkDigest = actionBatchBlobDigest(chunk)
    const chunks = Array(65).fill(chunkDigest)
    const dependencyBeefDigest = actionBatchBlobDigest(chunks.map(() => chunk[0]))
    const withoutDigest = {
      batchId: begun.batchId,
      actions: [],
      dependencyBeefDigest,
      blobChunks: { [dependencyBeefDigest]: chunks },
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }

    await ctx.storage.prepareActionBatchCommit(manifest)
    await ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest: chunkDigest, bytes: chunk })
    await expect(ctx.storage.commitActionBatch(manifest))
      .rejects.toThrow('at least one signed action')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('commit rejects a prepared manifest while a required upload is incomplete', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'partial-upload', firstAction: firstAction() })
    const dependencyBeefDigest = actionBatchBlobDigest([1, 2, 3])
    const withoutDigest = {
      batchId: begun.batchId,
      actions: [],
      dependencyBeefDigest,
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.prepareActionBatchCommit(manifest)).resolves.toMatchObject({
      missingDigests: [dependencyBeefDigest]
    })
    await expect(ctx.storage.commitActionBatch(manifest)).rejects.toThrow(`missing action batch blob ${dependencyBeefDigest}`)
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('commit rejects a manifest without signed actions', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'empty-manifest', firstAction: firstAction() })
    const withoutDigest = {
      batchId: begun.batchId,
      actions: [],
      dependencyBeef: [],
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.commitActionBatch(manifest)).rejects.toThrow('at least one signed action')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('prepare rejects payloads above the advertised inline limit', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'oversized-inline', firstAction: firstAction() })
    const bytes = new Uint8Array(ACTION_BATCH_MAX_INLINE_BYTES + 1)
    const dependencyBeefDigest = actionBatchBlobDigest(bytes)
    const withoutDigest = {
      batchId: begun.batchId,
      actions: [],
      dependencyBeefDigest,
      inlineBlobs: { [dependencyBeefDigest]: bytes },
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.prepareActionBatchCommit(manifest)).rejects.toThrow('inline payload within provider limit')
    await ctx.storage.abortActionBatch(begun.batchId)
  })

  test('prepared format-2 manifests retain digests rather than inline bytes', async () => {
    const begun = await ctx.storage.beginActionBatch({
      batchId: 'compact-inline-prepare',
      firstAction: firstAction()
    })
    const dependencyBeef = Uint8Array.of(1, 2, 3)
    const withoutDigest = {
      format: 2 as const,
      batchId: begun.batchId,
      actions: [],
      dependencyBeef,
      dependencyBeefDigest: actionBatchBlobDigest(dependencyBeef),
      sendWith: [],
      isDelayed: true
    }
    const manifest = { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) }
    await expect(ctx.storage.prepareActionBatchCommit(manifest))
      .rejects.toThrow('digest-only bytes')
    await ctx.storage.abortActionBatch(begun.batchId)
  })
})
