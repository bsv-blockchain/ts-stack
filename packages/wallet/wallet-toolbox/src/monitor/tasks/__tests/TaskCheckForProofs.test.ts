import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { TableProvenTxReq } from '../../../storage/schema/tables'
import { getProofs, TaskCheckForProofs } from '../TaskCheckForProofs'

describe('TaskCheckForProofs', () => {
  test('skips non-provable requests and completes requests already linked to a proof', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'proofRequestBoundaries' })
    try {
      const skipped = await _tu.insertTestProvenTxReq(ctx.activeStorage)
      await ctx.activeStorage.updateProvenTxReq(skipped.provenTxReqId, { status: 'invalid' })
      const skippedApi = (
        await ctx.activeStorage.findProvenTxReqs({
          partial: { provenTxReqId: skipped.provenTxReqId }
        })
      )[0]

      const skippedResult = await getProofs(new TaskCheckForProofs(ctx.monitor), [skippedApi], Number.MAX_SAFE_INTEGER)

      expect(skippedResult.log).toContain("status of 'invalid' is not ready")
      expect(skippedResult.proven).toHaveLength(0)
      expect(skippedResult.invalid).toHaveLength(0)

      const txid = 'ab'.repeat(32)
      const proof = await _tu.insertTestProvenTx(ctx.activeStorage, txid)
      const linked = await _tu.insertTestProvenTxReq(ctx.activeStorage, txid, proof.provenTxId, true)
      const linkedApi = (
        await ctx.activeStorage.findProvenTxReqs({
          partial: { provenTxReqId: linked.provenTxReqId }
        })
      )[0]

      const linkedResult = await getProofs(new TaskCheckForProofs(ctx.monitor), [linkedApi], Number.MAX_SAFE_INTEGER)

      expect(linkedResult.log).toContain(`Already linked to provenTxId ${proof.provenTxId}`)
      expect(linkedResult.proven).toEqual([linkedApi])
      const completed = (
        await ctx.activeStorage.findProvenTxReqs({
          partial: { provenTxReqId: linked.provenTxReqId }
        })
      )[0]
      expect(completed.status).toBe('completed')
      expect(completed.notified).toBe(false)
    } finally {
      await ctx.storage.destroy()
    }
  })

  test('marks a request with missing rawTx invalid without aborting the batch', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'proofMissingRawTx' })
    try {
      const txid = 'de'.repeat(32)
      const req = await _tu.insertTestProvenTxReq(ctx.activeStorage, txid)
      await ctx.activeStorage.updateProvenTxReq(req.provenTxReqId, { status: 'unmined' })
      const saved = (await ctx.activeStorage.findProvenTxReqs({ partial: { provenTxReqId: req.provenTxReqId } }))[0]
      const malformed = { ...saved, rawTx: undefined } as unknown as TableProvenTxReq

      const result = await getProofs(new TaskCheckForProofs(ctx.monitor), [malformed], Number.MAX_SAFE_INTEGER)

      expect(result.invalid).toHaveLength(1)
      const updated = (await ctx.activeStorage.findProvenTxReqs({ partial: { provenTxReqId: req.provenTxReqId } }))[0]
      expect(updated.status).toBe('invalid')
    } finally {
      await ctx.storage.destroy()
    }
  })
})
