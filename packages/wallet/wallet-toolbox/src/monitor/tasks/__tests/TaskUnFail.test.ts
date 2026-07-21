import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { TaskUnFail } from '../TaskUnFail'

describe('TaskUnFail', () => {
  test('persists the unfail transition and does not process the request again', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'taskUnFailTransition' })
    try {
      const user = await _tu.insertTestUser(ctx.activeStorage)
      const recoveredTx = new Transaction()
      recoveredTx.addInput({
        sourceTXID: 'ab'.repeat(32),
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      recoveredTx.addOutput({ lockingScript: Script.fromASM('OP_1'), satoshis: 1 })
      const txid = recoveredTx.id('hex')
      const { tx } = await _tu.insertTestTransaction(ctx.activeStorage, user, false, {
        txid,
        status: 'completed',
        rawTx: recoveredTx.toBinary()
      })
      const req = await _tu.insertTestProvenTxReq(ctx.activeStorage, txid)
      await ctx.activeStorage.updateProvenTxReq(req.provenTxReqId, {
        status: 'unfail',
        attempts: 7,
        rawTx: recoveredTx.toBinary(),
        notify: JSON.stringify({ transactionIds: [tx.transactionId] })
      })
      const getMerklePath = jest.spyOn(ctx.monitor.services, 'getMerklePath').mockResolvedValue({
        name: 'test',
        merklePath: new MerklePath(1, [[{ offset: 0, hash: txid, txid: true }]])
      })

      const task = new TaskUnFail(ctx.monitor)
      await task.runTask()
      await task.runTask()

      const savedReq = (await ctx.activeStorage.findProvenTxReqs({
        partial: { provenTxReqId: req.provenTxReqId }
      }))[0]
      expect(savedReq.status).toBe('unmined')
      expect(savedReq.attempts).toBe(0)
      expect(savedReq.history).toContain('"status_was":"unfail","status_now":"unmined"')
      expect(getMerklePath).toHaveBeenCalledTimes(1)

      const savedTx = (await ctx.activeStorage.findTransactions({
        partial: { transactionId: tx.transactionId }
      }))[0]
      expect(savedTx.status).toBe('unproven')
    } finally {
      await ctx.storage.destroy()
    }
  })
})
