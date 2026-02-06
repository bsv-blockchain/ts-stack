import { Beef } from '@bsv/sdk'
import { StorageSqlite } from '../StorageSqlite'
import { PurgeParams, PurgeResults, StorageGetBeefOptions, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'

export async function purgeDataSqlite(
  storage: StorageSqlite,
  params: PurgeParams,
  trx?: TrxToken
): Promise<PurgeResults> {
  const r: PurgeResults = { count: 0, log: '' }
  const defaultAge = 1000 * 60 * 60 * 24 * 14

  const runPurgeExec = async (sql: string, sqlParams: any[], log: string): Promise<void> => {
    try {
      await storage.exec(sql, sqlParams)
      const count = storage.changes()
      if (count > 0) {
        r.count += count
        r.log += `${count} ${log}\n`
      }
    } catch (eu: unknown) {
      const e = WalletError.fromUnknown(eu)
      throw eu
    }
  }

  if (params.purgeCompleted) {
    const age = params.purgeCompletedAge || defaultAge
    const before = toSqlWhereDate(new Date(Date.now() - age))

    await runPurgeExec(
      `UPDATE transactions SET inputBEEF = NULL, rawTx = NULL
       WHERE updated_at < ? AND status = 'completed' AND provenTxId IS NOT NULL
       AND (inputBEEF IS NOT NULL OR rawTx IS NOT NULL)`,
      [before],
      'completed transactions purged of transient data'
    )

    const completedReqs = await storage.getAll<{ provenTxReqId: number }>(
      `SELECT provenTxReqId FROM proven_tx_reqs
       WHERE updated_at < ? AND status = 'completed' AND provenTxId IS NOT NULL AND notified = 1`,
      [before]
    )
    const completedReqIds = completedReqs.map(o => o.provenTxReqId)

    if (completedReqIds.length > 0) {
      const placeholders = completedReqIds.map(() => '?').join(',')
      await runPurgeExec(
        `DELETE FROM proven_tx_reqs WHERE provenTxReqId IN (${placeholders})`,
        completedReqIds,
        'completed proven_tx_reqs deleted'
      )
    }
  }

  if (params.purgeFailed) {
    const age = params.purgeFailedAge || defaultAge
    const before = toSqlWhereDate(new Date(Date.now() - age))

    const failedTxs = await storage.getAll<{ transactionId: number }>(
      `SELECT transactionId FROM transactions WHERE updated_at < ? AND status = 'failed'`,
      [before]
    )
    const failedTxIds = failedTxs.map(tx => tx.transactionId)

    await deleteTransactions(storage, failedTxIds, r, 'failed', true)

    const invalidReqs = await storage.getAll<{ provenTxReqId: number }>(
      `SELECT provenTxReqId FROM proven_tx_reqs WHERE updated_at < ? AND status = 'invalid'`,
      [before]
    )
    if (invalidReqs.length > 0) {
      const ids = invalidReqs.map(o => o.provenTxReqId)
      const placeholders = ids.map(() => '?').join(',')
      await runPurgeExec(
        `DELETE FROM proven_tx_reqs WHERE provenTxReqId IN (${placeholders})`,
        ids,
        'invalid proven_tx_reqs deleted'
      )
    }

    const doubleSpendReqs = await storage.getAll<{ provenTxReqId: number }>(
      `SELECT provenTxReqId FROM proven_tx_reqs WHERE updated_at < ? AND status = 'doubleSpend'`,
      [before]
    )
    if (doubleSpendReqs.length > 0) {
      const ids = doubleSpendReqs.map(o => o.provenTxReqId)
      const placeholders = ids.map(() => '?').join(',')
      await runPurgeExec(
        `DELETE FROM proven_tx_reqs WHERE provenTxReqId IN (${placeholders})`,
        ids,
        'doubleSpend proven_tx_reqs deleted'
      )
    }
  }

  if (params.purgeSpent) {
    const age = params.purgeSpentAge || defaultAge
    const before = toSqlWhereDate(new Date(Date.now() - age))

    const beef = new Beef()
    const utxos = await storage.findOutputs({
      partial: { spendable: true },
      txStatus: ['sending', 'unproven', 'completed', 'nosend']
    })
    for (const utxo of utxos) {
      const options: StorageGetBeefOptions = {
        mergeToBeef: beef,
        ignoreServices: true
      }
      if (utxo.txid) await storage.getBeefForTransaction(utxo.txid, options)
    }
    const proofTxids: Record<string, boolean> = {}
    for (const btx of beef.txs) proofTxids[btx.txid] = true

    const spentTxs = await storage.getAll<{ transactionId: number; txid: string }>(
      `SELECT transactionId, txid FROM transactions
       WHERE updated_at < ? AND status = 'completed'
       AND NOT EXISTS (SELECT outputId FROM outputs AS o WHERE o.transactionId = transactions.transactionId AND o.spendable = 1)`,
      [before]
    )
    const nptxs = spentTxs.filter(t => !proofTxids[t.txid || ''])
    const spentTxIds = nptxs.map(tx => tx.transactionId)

    if (spentTxIds.length > 0) {
      const placeholders = spentTxIds.map(() => '?').join(',')
      const now = new Date().toISOString()
      await runPurgeExec(
        `UPDATE outputs SET spentBy = NULL, updated_at = ? WHERE spendable = 0 AND spentBy IN (${placeholders})`,
        [now, ...spentTxIds],
        'spent outputs no longer tracked by spentBy'
      )
      await deleteTransactions(storage, spentTxIds, r, 'spent', false)
    }
  }

  await runPurgeExec(
    `DELETE FROM proven_txs
     WHERE NOT EXISTS (SELECT 1 FROM transactions AS t WHERE t.txid = proven_txs.txid OR t.provenTxId = proven_txs.provenTxId)
     AND NOT EXISTS (SELECT 1 FROM proven_tx_reqs AS r WHERE r.txid = proven_txs.txid OR r.provenTxId = proven_txs.provenTxId)`,
    [],
    'orphan proven_txs deleted'
  )

  return r
}

async function deleteTransactions(
  storage: StorageSqlite,
  transactionIds: number[],
  r: PurgeResults,
  reason: string,
  markNotSpentBy: boolean
): Promise<void> {
  if (transactionIds.length === 0) return

  const runExec = async (sql: string, params: any[], log: string): Promise<void> => {
    await storage.exec(sql, params)
    const count = storage.changes()
    if (count > 0) {
      r.count += count
      r.log += `${count} ${log}\n`
    }
  }

  const txPlaceholders = transactionIds.map(() => '?').join(',')

  const outputs = await storage.getAll<{ outputId: number }>(
    `SELECT outputId FROM outputs WHERE transactionId IN (${txPlaceholders})`,
    transactionIds
  )
  const outputIds = outputs.map(o => o.outputId)

  if (outputIds.length > 0) {
    const outPlaceholders = outputIds.map(() => '?').join(',')
    await runExec(
      `DELETE FROM output_tags_map WHERE outputId IN (${outPlaceholders})`,
      outputIds,
      `${reason} output_tags_map deleted`
    )
    await runExec(`DELETE FROM outputs WHERE outputId IN (${outPlaceholders})`, outputIds, `${reason} outputs deleted`)
  }

  await runExec(
    `DELETE FROM tx_labels_map WHERE transactionId IN (${txPlaceholders})`,
    transactionIds,
    `${reason} tx_labels_map deleted`
  )

  await runExec(
    `DELETE FROM commissions WHERE transactionId IN (${txPlaceholders})`,
    transactionIds,
    `${reason} commissions deleted`
  )

  if (markNotSpentBy) {
    const now = new Date().toISOString()
    await runExec(
      `UPDATE outputs SET spendable = 1, spentBy = NULL, updated_at = ? WHERE spentBy IN (${txPlaceholders})`,
      [now, ...transactionIds],
      'unspent outputs updated to spendable'
    )
  }

  await runExec(
    `DELETE FROM transactions WHERE transactionId IN (${txPlaceholders})`,
    transactionIds,
    `${reason} transactions deleted`
  )
}

function toSqlWhereDate(d: Date): string {
  let s = d.toISOString()
  s = s.replace('T', ' ')
  s = s.replace('Z', '')
  return s
}
