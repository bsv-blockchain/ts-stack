import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import type { TableOutput } from '../schema/tables'
import type { StorageProvider } from '../StorageProvider'

/**
 * Restore the locking script of an output read with `noScript: true`.
 *
 * `validateOutputScript` only reloads a script offloaded into a raw
 * transaction storage still holds. A script kept on the row is left cleared,
 * so a funding output chosen from a `noScript` scan would reach the signer
 * without one. Reread the row in that case.
 */
export async function restoreOutputScript(storage: StorageProvider, o: TableOutput, trx?: TrxToken): Promise<void> {
  await storage.validateOutputScript(o, trx)
  if (o.lockingScript != null && o.lockingScript.length > 0) return
  const stored = await storage.findOutputById(o.outputId, trx)
  if (stored?.lockingScript != null && stored.lockingScript.length > 0) o.lockingScript = stored.lockingScript
}
