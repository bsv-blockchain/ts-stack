import * as sdk from '../../sdk'
import { StorageIdb } from '../StorageIdb'

/**
 * Looks for unpropagated state:
 *
 * 1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
 * 2. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.
 * 3. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.
 *
 * @param storage
 * @param args
 * @returns
 */
export async function reviewStatusIdb (
  storage: StorageIdb,
  args: { agedLimit: Date, trx?: sdk.TrxToken }
): Promise<{ log: string }> {
  const r: { log: string } = { log: '' }

  // 1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
  const invalidTxids: string[] = []
  await storage.filterProvenTxReqs({ partial: { status: 'invalid' }, trx: args.trx }, txReq => {
    invalidTxids.push(txReq.txid)
  })
  for (const txid of invalidTxids) {
    const txs = await storage.findTransactions({ partial: { txid }, trx: args.trx })
    for (const tx of txs) {
      if (tx.status !== 'failed') {
        r.log += `transaction ${tx.transactionId} updated to status of 'failed' was ${tx.status}\n`
        await storage.updateTransactionStatus('failed', tx.transactionId, undefined, undefined, args.trx)
      }
    }
  }

  // 2. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.
  const provenTxs: Record<string, number> = {}
  await storage.filterProvenTxs({ partial: {}, trx: args.trx }, provenTx => {
    provenTxs[provenTx.txid] = provenTx.provenTxId
  })
  for (const [txid, provenTxId] of Object.entries(provenTxs)) {
    const txs = await storage.findTransactions({ partial: { txid }, trx: args.trx })
    for (const tx of txs) {
      if (tx.provenTxId == null) {
        r.log += `transaction ${tx.transactionId} updated to status of 'completed' with provenTxId ${provenTxId}\n`
        await storage.updateTransaction(tx.transactionId, { status: 'completed', provenTxId }, args.trx)
      }
    }
  }

  // 3. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.
  const failedTxs = await storage.findTransactions({ partial: { status: 'failed' }, trx: args.trx })
  for (const tx of failedTxs) {
    let blocked = false
    if (tx.txid != null && tx.txid !== '') {
      const reqs = await storage.findProvenTxReqs({ partial: { txid: tx.txid }, trx: args.trx })
      blocked = reqs.some(req => !['invalid', 'doubleSpend'].includes(req.status))
    }
    if (blocked) continue

    const outputs = await storage.findOutputs({ partial: { userId: tx.userId, spentBy: tx.transactionId }, trx: args.trx })
    for (const output of outputs) {
      await storage.updateOutput(output.outputId, { spendable: true, spentBy: undefined }, args.trx)
      r.log += `output ${output.outputId} released from failed transaction ${tx.transactionId}\n`
    }
  }

  return r
}
