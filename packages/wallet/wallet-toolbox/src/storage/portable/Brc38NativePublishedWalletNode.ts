import type { Knex } from 'knex'
import { readBrc38ImportJournal } from './Brc38NativeImportJournalNode'
import type { FixedProfile, State } from './Brc38PublishedProfileReceiptNode'
import { verifyBrc38PublishedWalletData } from './Brc38PublishedWalletData'

/** Caller retains physical/kernel/inventory and original fixed/copy validation. */
export async function verifyBrc38PublishedWallet(k: Knex, fixed: FixedProfile, state: State): Promise<void> {
  // Reuse an already retained native transaction without manufacturing a
  // child actor; an actual native root retains its original transaction path.
  const receipt =
    k.isTransaction === true
      ? await readBrc38ImportJournal(k as Knex.Transaction, fixed.admission)
      : await k.transaction(async trx => await readBrc38ImportJournal(trx, fixed.admission))
  await verifyBrc38PublishedWalletData(k, fixed, state, receipt)
}
