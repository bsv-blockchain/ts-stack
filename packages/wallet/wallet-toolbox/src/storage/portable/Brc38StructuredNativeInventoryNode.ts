import type { Knex } from 'knex'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38StructuredNativeFieldInventoryPolicy } from './Brc38StructuredNativeFieldInventoryNode'
import { inspectBrc38StructuredNativeRestoreInventory } from './Brc38StreamedNativeInventoryNode'

/** Complete original private inventory, comparison DATA only. Every call
 * retains the genuine original owner/source/layout/journal and all13 native
 * postimages; this never supplies a reusable publication verdict. */
export async function inspectBrc38PrivateStructuredNativeInventory(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectBrc38StructuredNativeRestoreInventory(k, admission, 'private', policy, signal)
}
/** Actual READY native-profile inspection, before activation/new writes. Its
 * independent finite read scope never renews the expired private import. */
export async function inspectBrc38ReadyPublishedStructuredNativeInventory(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectBrc38StructuredNativeRestoreInventory(k, admission, 'published-native', policy, signal)
}
/** Independent physically read-only copy content. The actual copy factory
 * also retains inode/hash/catalog/RECEIVING deadline checks before and after
 * this callback. It cannot enroll a native producer or grant a writer. */
export async function inspectBrc38PublishedCopyStructuredInventory(
  k: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  policy: Brc38StructuredNativeFieldInventoryPolicy,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectBrc38StructuredNativeRestoreInventory(k, admission, 'published-copy', policy, signal)
}
