import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import type { Knex } from 'knex'
import { requireBrc38NativeProfileReadTransaction } from './Brc38PublishedProfileNode'
import { verifyBrc38ImportJournalReadSchema } from './Brc38NativeImportJournalSchemaNode'
import { createBrc38ImportProvenanceStore } from './Brc38ImportProvenanceNode'
import { hasBrc38SqlBinarySchema } from './Brc38SqlBinaryStaging'
import { hasBrc38SqlTextSchema } from './Brc38SqlTextStaging'
import { hasBrc38SqlStructuredSchema } from './Brc38SqlStructuredStaging'
import { hasBrc38SqlCanonicalStructuredSchema } from './Brc38SqlCanonicalStructuredStaging'
import { hasBrc38SqlProjectedStructuredSchema } from './Brc38SqlProjectedStructuredStaging'
import { brc38NativePriorImportTables, type Brc38NativePriorImportTable } from './Brc38NativePriorImportTables'

/** Optional-family selection is fresh scalar DATA inside the actual source
 * view. Partial/changed definitions refuse; an absent family remains absent.
 * This function grants no receipt/source/profile/row authority. */
export async function inspectBrc38NativePriorImportFamily(
  k: Knex.Transaction,
  table: Brc38NativePriorImportTable
): Promise<boolean> {
  requireBrc38NativeProfileReadTransaction(k)
  if (!brc38NativePriorImportTables.includes(table)) throw new TypeError('Invalid prior-import family')
  const pair =
    table === 'brc38_import_journal' || table === 'brc38_import_ids'
      ? ['brc38_import_journal', 'brc38_import_ids']
      : table.startsWith('brc38_import_')
        ? table.includes('_streamed_')
          ? ['brc38_import_streamed_original_budget', 'brc38_import_streamed_original']
          : table.includes('_structured_')
            ? ['brc38_import_structured_original_budget', 'brc38_import_structured_original']
            : ['brc38_import_original_budget', 'brc38_import_original']
        : undefined
  if (pair !== undefined) {
    const objects = (await k('sqlite_schema').whereIn('tbl_name', pair).count({ count: '*' }).first()) as
      { count: unknown } | undefined
    if (objects?.count === 0) return false
    if (pair[0] === 'brc38_import_journal') await verifyBrc38ImportJournalReadSchema(k)
    else {
      await verifyBrc38ImportJournalReadSchema(k)
      await createBrc38ImportProvenanceStore(
        table.includes('_streamed_') ? 'streamed' : table.includes('_structured_') ? 'structured' : 'legacy',
        Brc38RetiredNativeReadNode.isReadTransaction(k) ? 'retired-read' : 'published-native'
      ).verify(k)
    }
    requireBrc38NativeProfileReadTransaction(k)
    return true
  }
  const present = table.startsWith('private_binary_')
    ? await hasBrc38SqlBinarySchema(k)
    : table.startsWith('private_text_')
      ? await hasBrc38SqlTextSchema(k)
      : table.startsWith('private_canonical_')
        ? await hasBrc38SqlCanonicalStructuredSchema(k)
        : table.startsWith('private_projected_')
          ? await hasBrc38SqlProjectedStructuredSchema(k)
          : await hasBrc38SqlStructuredSchema(k)
  requireBrc38NativeProfileReadTransaction(k)
  return present
}
