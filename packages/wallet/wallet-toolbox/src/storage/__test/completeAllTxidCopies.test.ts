import { _tu } from '../../../test/utils/TestUtilsWalletStorage'

describe('proof completion fan-out', () => {
  test('completes every local transaction row sharing the proven txid', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'completeAllTxidCopies' })
    const { activeStorage } = ctx
    try {
      const txid = 'ab'.repeat(32)
      const firstUser = await _tu.insertTestUser(activeStorage)
      const secondUser = await _tu.insertTestUser(activeStorage)
      const { tx: first } = await _tu.insertTestTransaction(activeStorage, firstUser, false, {
        txid,
        status: 'unproven'
      })
      const { tx: second } = await _tu.insertTestTransaction(activeStorage, secondUser, false, {
        txid,
        status: 'unproven'
      })
      const req = await _tu.insertTestProvenTxReq(activeStorage, txid)
      await activeStorage.updateProvenTxReq(req.provenTxReqId, {
        status: 'unmined',
        notify: JSON.stringify({ transactionIds: [first.transactionId] })
      })

      const args = {
        provenTxReqId: req.provenTxReqId,
        txid,
        status: 'unmined' as const,
        attempts: 0,
        history: '{}',
        height: 123,
        index: 4,
        blockHash: 'cd'.repeat(32),
        merkleRoot: 'ef'.repeat(32),
        merklePath: [1, 2, 3]
      }
      const result = await activeStorage.updateProvenTxReqWithNewProvenTx(args)

      let transactions = await activeStorage.findTransactions({ partial: { txid } })
      expect(transactions).toHaveLength(2)
      expect(transactions.every(transaction => transaction.status === 'completed')).toBe(true)
      expect(transactions.every(transaction => transaction.provenTxId === result.provenTxId)).toBe(true)

      // Recreate the production drift after the proof already exists. A later
      // Monitor proof event must heal the omitted local transaction as well.
      await activeStorage.updateTransaction(second.transactionId, { status: 'unproven' })
      await activeStorage.updateProvenTxReq(req.provenTxReqId, {
        notified: true,
        notify: JSON.stringify({ transactionIds: [first.transactionId] })
      })
      await activeStorage.updateProvenTxReqWithNewProvenTx(args)

      transactions = await activeStorage.findTransactions({ partial: { txid } })
      expect(transactions.every(transaction => transaction.status === 'completed')).toBe(true)
      const savedReq = (await activeStorage.findProvenTxReqs({ partial: { txid } }))[0]
      expect(JSON.parse(savedReq.notify).transactionIds).toEqual([first.transactionId, second.transactionId])
    } finally {
      await ctx.storage.destroy()
    }
  })
})
