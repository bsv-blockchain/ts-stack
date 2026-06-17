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

  r.log += await failInvalidTransactions(storage, args.trx)
  r.log += await completeProvenTransactions(storage, args.trx)
  r.log += await releaseFailedOutputs(storage, args.trx)

  return r
}

/**
 * 1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
 */
async function failInvalidTransactions (storage: StorageIdb, trx?: sdk.TrxToken): Promise<string> {
  let log = ''
  const invalidTxids: string[] = []
  await storage.filterProvenTxReqs({ partial: { status: 'invalid' }, trx }, txReq => {
    invalidTxids.push(txReq.txid)
  })
  for (const txid of invalidTxids) {
    const txs = await storage.findTransactions({ partial: { txid }, trx })
    for (const tx of txs) {
      if (tx.status !== 'failed') {
        log += `transaction ${tx.transactionId} updated to status of 'failed' was ${tx.status}\n`
        await storage.updateTransactionStatus('failed', tx.transactionId, undefined, undefined, trx)
      }
    }
  }
  return log
}

/**
 * 2. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.
 */
async function completeProvenTransactions (storage: StorageIdb, trx?: sdk.TrxToken): Promise<string> {
  let log = ''
  const provenTxs: Record<string, number> = {}
  await storage.filterProvenTxs({ partial: {}, trx }, provenTx => {
    provenTxs[provenTx.txid] = provenTx.provenTxId
  })
  for (const [txid, provenTxId] of Object.entries(provenTxs)) {
    const txs = await storage.findTransactions({ partial: { txid }, trx })
    for (const tx of txs) {
      if (tx.provenTxId == null) {
        log += `transaction ${tx.transactionId} updated to status of 'completed' with provenTxId ${provenTxId}\n`
        await storage.updateTransaction(tx.transactionId, { status: 'completed', provenTxId }, trx)
      }
    }
  }
  return log
}

/**
 * 3. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.
 */
async function releaseFailedOutputs (storage: StorageIdb, trx?: sdk.TrxToken): Promise<string> {
  let log = ''
  const failedTxs = await storage.findTransactions({ partial: { status: 'failed' }, trx })
  for (const tx of failedTxs) {
    if (await isFailedTxBlocked(storage, tx, trx)) continue

    const outputs = await storage.findOutputs({ partial: { userId: tx.userId, spentBy: tx.transactionId }, trx })
    for (const output of outputs) {
      await storage.updateOutput(output.outputId, { spendable: true, spentBy: undefined }, trx)
      log += `output ${output.outputId} released from failed transaction ${tx.transactionId}\n`
    }
  }
  return log
}

/**
 * A failed transaction's outputs stay locked while any matching provenTxReq is in a non-terminal state.
 */
async function isFailedTxBlocked (storage: StorageIdb, tx: { txid?: string | null }, trx?: sdk.TrxToken): Promise<boolean> {
  if (tx.txid == null || tx.txid === '') return false
  const reqs = await storage.findProvenTxReqs({ partial: { txid: tx.txid }, trx })
  return reqs.some(req => !['invalid', 'doubleSpend'].includes(req.status))
}
