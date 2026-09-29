import type { StorageProvider } from '../StorageProvider'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import type { TableProvenTx } from '../schema/tables'

function* proofBatches(txids: string[]) {
  for (let offset = 0; offset < txids.length; offset += 250) yield txids.slice(offset, offset + 250)
}

/** Bound SQL parameters even for legacy callers supplying a large proof page. */
export async function findProofRecords(
  storage: StorageProvider,
  txids: string[],
  trx?: TrxToken
): Promise<TableProvenTx[]> {
  const unique = [...new Set(txids)]
  const records: TableProvenTx[] = []
  // Consume one SQL batch at a time; callers may share a transaction connection.
  for await (const batch of proofBatches(unique)) {
    records.push(...(await storage.findProvenTxs({ partial: {}, txids: batch, trx })))
  }
  return records
}

/** All started work drains before a failure escapes; at most eight checks run. */
export async function mapProofWork<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failed = false
  function* pendingIndexes() {
    while (!failed && next < items.length) yield next++
  }
  const workers = Array.from({ length: Math.min(items.length, 8) }, async () => {
    // Each worker consumes serially; all eight share the same admission cursor.
    for await (const index of pendingIndexes()) {
      // A peer may fail while the iterator hands this worker its next index.
      if (failed) break
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
