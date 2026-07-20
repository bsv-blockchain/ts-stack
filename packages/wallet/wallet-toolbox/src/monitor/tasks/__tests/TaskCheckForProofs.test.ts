import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { TableProvenTxReq } from '../../../storage/schema/tables'
import { getProofs, TaskCheckForProofs } from '../TaskCheckForProofs'

describe('TaskCheckForProofs', () => {
  test('marks a request with missing rawTx invalid without aborting the batch', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'proofMissingRawTx' })
    try {
      const txid = 'de'.repeat(32)
      const req = await _tu.insertTestProvenTxReq(ctx.activeStorage, txid)
      await ctx.activeStorage.updateProvenTxReq(req.provenTxReqId, { status: 'unmined' })
      const saved = (await ctx.activeStorage.findProvenTxReqs({ partial: { provenTxReqId: req.provenTxReqId } }))[0]
      const malformed = { ...saved, rawTx: undefined } as unknown as TableProvenTxReq

      const result = await getProofs(
        new TaskCheckForProofs(ctx.monitor),
        [malformed],
        Number.MAX_SAFE_INTEGER
      )

      expect(result.invalid).toHaveLength(1)
      const updated = (await ctx.activeStorage.findProvenTxReqs({ partial: { provenTxReqId: req.provenTxReqId } }))[0]
      expect(updated.status).toBe('invalid')
    } finally {
      await ctx.storage.destroy()
    }
  })
})
