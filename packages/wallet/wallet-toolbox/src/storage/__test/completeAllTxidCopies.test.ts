import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { WalletServices } from '../../sdk/WalletServices.interfaces'
import { UpdateProvenTxReqWithNewProvenTxArgs } from '../../sdk/WalletStorage.interfaces'

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
      expect(result.notified).toBe(true)

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
      expect(savedReq.notified).toBe(true)
    } finally {
      await ctx.storage.destroy()
    }
  })

  test('retries completed unnotified fan-out and restores purge eligibility', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'retryIncompleteProofFanout' })
    const { activeStorage } = ctx
    try {
      const txid = 'bc'.repeat(32)
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

      const originalUpdate = activeStorage.updateTransaction.bind(activeStorage)
      let failSecondUpdate = true
      const updateSpy = jest.spyOn(activeStorage, 'updateTransaction').mockImplementation(async (id, update, trx) => {
        if (failSecondUpdate && id === second.transactionId && update.status === 'completed') {
          failSecondUpdate = false
          throw new Error('injected fan-out failure')
        }
        return await originalUpdate(id, update, trx)
      })

      const result = await activeStorage.updateProvenTxReqWithNewProvenTx(proofArgs(req.provenTxReqId, txid))
      updateSpy.mockRestore()

      expect(result.notified).toBe(false)
      let savedReq = (await activeStorage.findProvenTxReqs({ partial: { txid } }))[0]
      expect(savedReq.status).toBe('completed')
      expect(savedReq.notified).toBe(false)

      // Exercise the stale non-null provenTxId blind spot as well as the
      // transient update failure. Generic reviewStatus only repairs null IDs.
      const staleProven = await _tu.insertTestProvenTx(activeStorage, 'ca'.repeat(32))
      await activeStorage.updateTransaction(second.transactionId, {
        status: 'completed',
        provenTxId: staleProven.provenTxId
      })

      const reconciliation = await activeStorage.reconcileCompletedProvenTxReqs()
      expect(reconciliation.log).toContain(`completed req ${req.provenTxReqId}`)

      const transactions = await activeStorage.findTransactions({ partial: { txid } })
      expect(transactions.every(transaction => transaction.status === 'completed')).toBe(true)
      expect(transactions.every(transaction => transaction.provenTxId === result.provenTxId)).toBe(true)
      savedReq = (await activeStorage.findProvenTxReqs({ partial: { txid } }))[0]
      expect(savedReq.notified).toBe(true)

      await activeStorage.updateProvenTxReq(req.provenTxReqId, {
        updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24)
      })
      await activeStorage.purgeData({
        purgeCompleted: true,
        purgeFailed: false,
        purgeSpent: false,
        purgeCompletedAge: 1
      })
      await expect(activeStorage.findProvenTxReqs({ partial: { txid } })).resolves.toEqual([])
    } finally {
      await ctx.storage.destroy()
    }
  })

  test('repairs failed transaction bookkeeping without holding a transaction during UTXO checks', async () => {
    const ctx = await _tu.createSQLiteTestSetup1Wallet({ databaseName: 'repairFailedProofCopy' })
    const { activeStorage } = ctx
    try {
      const user = await _tu.insertTestUser(activeStorage)
      const lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress())

      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript, satoshis: 1_000 })
      const fundingTxid = fundingTx.id('hex')

      const provedTx = new Transaction()
      provedTx.addInput({
        sourceTXID: fundingTxid,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      provedTx.addOutput({ lockingScript, satoshis: 900 })
      const txid = provedTx.id('hex')

      const { tx: fundingRecord } = await _tu.insertTestTransaction(activeStorage, user, false, {
        status: 'completed',
        txid: fundingTxid
      })
      const { tx: failedRecord } = await _tu.insertTestTransaction(activeStorage, user, false, {
        status: 'failed',
        txid,
        rawTx: provedTx.toBinary()
      })
      const consumedOutput = await _tu.insertTestOutput(activeStorage, fundingRecord, 0, 1_000, undefined, false, {
        txid: fundingTxid,
        lockingScript: lockingScript.toBinary(),
        scriptLength: lockingScript.toBinary().length,
        scriptOffset: undefined,
        spendable: true,
        spentBy: undefined
      })
      const generatedOutput = await _tu.insertTestOutput(activeStorage, failedRecord, 0, 900, undefined, false, {
        txid,
        lockingScript: lockingScript.toBinary(),
        scriptLength: lockingScript.toBinary().length,
        scriptOffset: undefined,
        spendable: false,
        spentBy: undefined
      })
      const req = await _tu.insertTestProvenTxReq(activeStorage, txid)
      await activeStorage.updateProvenTxReq(req.provenTxReqId, {
        status: 'unmined',
        rawTx: provedTx.toBinary(),
        notify: JSON.stringify({ transactionIds: [] })
      })
      let transactionActive = false
      const originalTransaction = activeStorage.transaction.bind(activeStorage)
      const transactionSpy = jest.spyOn(activeStorage, 'transaction').mockImplementation(async (scope, trx) =>
        await originalTransaction(async token => {
          transactionActive = true
          try {
            const result = await scope(token)
            return result
          } finally {
            transactionActive = false
          }
        }, trx)
      )
      activeStorage.setServices({
        isUtxo: async () => {
          expect(transactionActive).toBe(false)
          return true
        }
      } as unknown as WalletServices)

      const result = await activeStorage.updateProvenTxReqWithNewProvenTx(proofArgs(req.provenTxReqId, txid))
      transactionSpy.mockRestore()

      const completed = (await activeStorage.findTransactions({ partial: { transactionId: failedRecord.transactionId } }))[0]
      expect(completed.status).toBe('completed')
      expect(completed.provenTxId).toBe(result.provenTxId)

      const reservedInput = (await activeStorage.findOutputs({ partial: { outputId: consumedOutput.outputId } }))[0]
      expect(reservedInput.spendable).toBe(false)
      expect(reservedInput.spentBy).toBe(failedRecord.transactionId)

      const restoredOutput = (await activeStorage.findOutputs({ partial: { outputId: generatedOutput.outputId } }))[0]
      expect(restoredOutput.spendable).toBe(true)

      const savedReq = (await activeStorage.findProvenTxReqs({ partial: { txid } }))[0]
      expect(JSON.parse(savedReq.notify).transactionIds).toEqual([failedRecord.transactionId])
      expect(savedReq.notified).toBe(true)
    } finally {
      await ctx.storage.destroy()
    }
  })
})

function proofArgs (provenTxReqId: number, txid: string): UpdateProvenTxReqWithNewProvenTxArgs {
  return {
    provenTxReqId,
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
}
