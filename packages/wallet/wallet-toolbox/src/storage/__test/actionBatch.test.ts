import { Validation } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import { cleanupExpiredActionBatches } from '../methods/actionBatch'
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
    expect((await ctx.storage.getCapabilities()).actionBatch?.version).toBe(1)
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

  test('blob staging rejects digest mismatches and accepts idempotent duplicates', async () => {
    const begun = await ctx.storage.beginActionBatch({ batchId: 'blob-batch', firstAction: firstAction() })
    const bytes = [1, 2, 3, 4]
    await expect(ctx.storage.putActionBatchBlob({
      batchId: begun.batchId,
      digest: '00'.repeat(32),
      bytes
    })).rejects.toBeDefined()
    const digest = actionBatchBlobDigest(bytes)
    await ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest, bytes })
    await ctx.storage.putActionBatchBlob({ batchId: begun.batchId, digest, bytes })
    const batch = await ctx.activeStorage.findActionBatch(ctx.userId, begun.batchId)
    expect((await ctx.activeStorage.findActionBatchBlobRecord(batch!.actionBatchId, digest))?.bytes).toEqual(bytes)
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
})
