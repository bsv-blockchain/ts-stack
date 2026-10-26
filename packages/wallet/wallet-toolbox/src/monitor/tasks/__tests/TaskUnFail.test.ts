import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { TaskUnFail } from '../TaskUnFail'
import { blockHash } from '../../../services/chaintracker/chaintracks/util/blockHeaderUtilities'

function proofHeader(merkleRoot: string, height = 1) {
  const base = {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot,
    time: 1,
    bits: 0,
    nonce: 0
  }
  return { ...base, height, hash: blockHash(base) }
}

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
        merklePath: new MerklePath(1, [[{ offset: 0, hash: txid, txid: true }]]),
        header: proofHeader(txid)
      })
      const validateRoot = jest.spyOn(ctx.monitor.chaintracks, 'isValidRootForHeight').mockResolvedValue(true)

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
      expect(validateRoot).toHaveBeenCalledWith(txid, 1)

      const savedTx = (await ctx.activeStorage.findTransactions({
        partial: { transactionId: tx.transactionId }
      }))[0]
      expect(savedTx.status).toBe('unproven')
    } finally {
      await ctx.storage.destroy()
    }
  })

  test('does not restore a failed transaction when the local chain rejects the proof root', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'taskUnFailForgedProof' })
    try {
      const user = await _tu.insertTestUser(ctx.activeStorage)
      const recoveredTx = new Transaction()
      recoveredTx.addInput({
        sourceTXID: 'cd'.repeat(32),
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      recoveredTx.addOutput({ lockingScript: Script.fromASM('OP_1'), satoshis: 1 })
      const txid = recoveredTx.id('hex')
      const { tx } = await _tu.insertTestTransaction(ctx.activeStorage, user, false, {
        txid,
        status: 'failed',
        rawTx: recoveredTx.toBinary()
      })
      const req = await _tu.insertTestProvenTxReq(ctx.activeStorage, txid)
      await ctx.activeStorage.updateProvenTxReq(req.provenTxReqId, {
        status: 'unfail',
        rawTx: recoveredTx.toBinary(),
        notify: JSON.stringify({ transactionIds: [tx.transactionId] })
      })
      jest.spyOn(ctx.monitor.services, 'getMerklePath').mockResolvedValue({
        name: 'forged',
        merklePath: new MerklePath(1, [[{ offset: 0, hash: txid, txid: true }]]),
        header: proofHeader(txid)
      })
      const validateRoot = jest.spyOn(ctx.monitor.chaintracks, 'isValidRootForHeight').mockResolvedValue(false)

      await new TaskUnFail(ctx.monitor).runTask()

      const savedReq = (await ctx.activeStorage.findProvenTxReqs({
        partial: { provenTxReqId: req.provenTxReqId }
      }))[0]
      expect(savedReq.status).toBe('invalid')
      expect(savedReq.history).toContain('unfailProofRejected')
      const savedTx = (await ctx.activeStorage.findTransactions({
        partial: { transactionId: tx.transactionId }
      }))[0]
      expect(savedTx.status).toBe('failed')
      expect(validateRoot).toHaveBeenCalledWith(txid, 1)
    } finally {
      await ctx.storage.destroy()
    }
  })

  test('re-reads the first page so status updates do not skip later requests', async () => {
    let remaining = Array.from({ length: 205 }, (_, index) => ({
      provenTxReqId: index + 1,
      created_at: new Date(0),
      updated_at: new Date(0),
      txid: index.toString(16).padStart(64, '0'),
      rawTx: [],
      status: 'unfail' as const,
      history: '{}',
      notify: '{}',
      attempts: 0,
      notified: false
    }))
    const findProvenTxReqs = jest.fn(async ({ paged }: any) => remaining.slice(paged.offset, paged.offset + paged.limit))
    const storage = {
      isStorageProvider: () => true,
      findProvenTxReqs,
      updateProvenTxReqDynamics: async (id: number) => {
        remaining = remaining.filter(req => req.provenTxReqId !== id)
      }
    }
    const getMerklePath = jest.fn(async () => ({ name: 'none' }))
    const task = new TaskUnFail({
      storage,
      services: { getMerklePath },
      chaintracks: { isValidRootForHeight: async () => false }
    } as any)

    await task.runTask()

    expect(remaining).toHaveLength(0)
    expect(getMerklePath).toHaveBeenCalledTimes(205)
    expect(findProvenTxReqs.mock.calls.every(([args]) => args.paged.offset === 0)).toBe(true)
  })
})
