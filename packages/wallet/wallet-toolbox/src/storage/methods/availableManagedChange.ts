import type { TransactionStatus } from '../../sdk/types'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import type { StorageProvider } from '../StorageProvider'
import type { TableOutput } from '../schema/tables/TableOutput'
import { isAutoSpendableChangeOutput, managedChangeOutputFields } from './managedChange'

/**
 * Return the exact set of wallet-managed outputs currently eligible for
 * automatic funding. Keeping this predicate shared prevents the planner,
 * allocator, action-batch reservations, and availability count from drifting.
 */
export async function availableManagedChange (
  storage: StorageProvider,
  userId: number,
  basketId: number,
  excludeSending: boolean,
  trx?: TrxToken
): Promise<TableOutput[]> {
  const statuses: TransactionStatus[] = ['completed', 'unproven']
  if (!excludeSending) statuses.push('sending')
  const outputs = (await storage.findOutputs({
    partial: { userId, basketId, spendable: true, ...managedChangeOutputFields },
    txStatus: statuses,
    noScript: true,
    trx
  })).filter(isAutoSpendableChangeOutput)
  if (outputs.length === 0) return outputs
  const reserved = new Set(await storage.findReservedActionBatchOutputIds(outputs.map(output => output.outputId), trx))
  return outputs.filter(output => !reserved.has(output.outputId))
}
