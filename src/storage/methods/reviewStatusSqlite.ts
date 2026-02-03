import { StorageSqlite } from '../StorageSqlite'
import { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'

export async function reviewStatusSqlite(
  storage: StorageSqlite,
  args: { agedLimit: Date; trx?: TrxToken }
): Promise<{ log: string }> {
  const r: { log: string } = { log: '' }

  const runQuery = async (sql: string, log: string): Promise<void> => {
    try {
      await storage.exec(sql)
      const count = storage.changes()
      if (count > 0) {
        r.log += `${count} ${log}\n`
      }
    } catch (eu: unknown) {
      const e = WalletError.fromUnknown(eu)
      throw eu
    }
  }

  await runQuery(
    `UPDATE transactions SET status = 'failed'
     WHERE status != 'failed'
     AND EXISTS (
       SELECT 1 FROM proven_tx_reqs AS r
       WHERE transactions.txid = r.txid AND r.status = 'invalid'
     )`,
    `transactions updated to status of 'failed' where provenTxReq with matching txid is 'invalid'`
  )

  await runQuery(
    `UPDATE outputs SET spentBy = NULL, spendable = 1
     WHERE EXISTS (
       SELECT 1 FROM transactions AS t
       WHERE outputs.spentBy = t.transactionId AND t.status = 'failed'
     )`,
    `outputs updated to spendable where spentBy is a transaction with status 'failed'`
  )

  await runQuery(
    `UPDATE transactions SET status = 'completed',
     provenTxId = (SELECT provenTxId FROM proven_txs AS p WHERE transactions.txid = p.txid)
     WHERE provenTxId IS NULL
     AND EXISTS (
       SELECT 1 FROM proven_txs AS p WHERE transactions.txid = p.txid
     )`,
    `transactions updated with provenTxId and status of 'completed' where provenTx with matching txid exists`
  )

  return r
}
