import type { StorageProvider } from '../StorageProvider'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import type { TableProvenTx } from '../schema/tables'

/** Bound SQL parameters even for legacy callers supplying a large proof page. */
export async function findProofRecords(
  storage: StorageProvider,
  txids: string[],
  trx?: TrxToken
): Promise<TableProvenTx[]> {
  const unique = [...new Set(txids)]
  const records: TableProvenTx[] = []
  for (let offset = 0; offset < unique.length; offset += 250) {
    records.push(...(await storage.findProvenTxs({ partial: {}, txids: unique.slice(offset, offset + 250), trx })))
  }
  return records
}

/** All started work drains before a failure escapes; at most eight checks run. */
export async function mapProofWork<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failed = false
  const workers = Array.from({ length: Math.min(items.length, 8) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await work(items[index])
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  const settled = await Promise.allSettled(workers)
  for (const result of settled) if (result.status === 'rejected') throw result.reason
  return results
}
