import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { requireBrc38PackedRead, hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { installBrc38NativePackedTextSchema, hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { verifyBrc38NativeTailLayout } from './Brc38NativeTailLayoutNode'
import {
  installBrc38SqlProjectedStructuredSchema,
  hasBrc38SqlProjectedStructuredSchema
} from './Brc38SqlProjectedStructuredStaging'
import {
  installBrc38ImportStructuredProvenanceSchema,
  verifyBrc38ImportStructuredProvenanceSchema
} from './Brc38ImportStructuredProvenanceNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { runInSeries } from '../../utility/runInSeries'

export const brc38StructuredNativeReceiverMigration = '2026-10-07-002 private structured native receiver auxiliaries'
const nativeTables = Object.freeze([
  'users',
  'proven_txs',
  'proven_tx_reqs',
  'transactions',
  'outputs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'commissions',
  'sync_states'
])
function invalid(): never {
  throw new Error('Fresh private structured native receiver schema differs')
}

/** Private receiver schema inspection, freshly performed under the actual
 * authenticated private actor. Expected SQL and migration names are DATA;
 * no cached schema result can substitute for this inspection. */
export async function verifyBrc38StructuredNativeReceiverSchema(k: Knex.Transaction): Promise<void> {
  if (k.isTransaction !== true || !isBrc38OwnedPrivateNativeSqlite(k)) invalid()
  requireBrc38PackedRead(k)
  await verifyBrc38AuthenticatedSourceSeal(k)
  await verifyBrc38NativeTailLayout(k)
  await verifyBrc38ImportJournalSchema(k)
  if (
    !(await hasBrc38NativePackedSchema(k)) ||
    !(await hasBrc38NativePackedTextSchema(k)) ||
    !(await hasBrc38SqlProjectedStructuredSchema(k))
  )
    invalid()
  await verifyBrc38ImportStructuredProvenanceSchema(k)
  requireBrc38PackedRead(k)
  if (!isBrc38OwnedPrivateNativeSqlite(k)) invalid()
}

/** Fresh private candidate only, before destination generation/schema receipts
 * are captured. The existing binary budget is shared by TEXT; original raw
 * source/canonical families stay sealed. All auxiliary DDL is a single owned
 * savepoint, so a caught failure cannot retain partial installation. */
export async function installBrc38StructuredNativeReceiverSchema(k: Knex.Transaction): Promise<void> {
  if (k.isTransaction !== true || !isBrc38OwnedPrivateNativeWriter(k)) invalid()
  await verifyBrc38AuthenticatedSourceSeal(k)
  await verifyBrc38NativeTailLayout(k)
  await verifyBrc38ImportJournalSchema(k)
  if (
    !(await hasBrc38NativePackedSchema(k)) ||
    (await hasBrc38NativePackedTextSchema(k)) ||
    (await hasBrc38SqlProjectedStructuredSchema(k))
  )
    invalid()
  await runInSeries(nativeTables, async table => {
    const value = await k(table).select(k.raw('1 AS present')).limit(1)
    if (value.length !== 0) invalid()
  })
  await k.raw('SAVEPOINT brc38_structured_native_schema')
  try {
    await installBrc38NativePackedTextSchema(k)
    await installBrc38SqlProjectedStructuredSchema(k)
    await installBrc38ImportStructuredProvenanceSchema(k)
    await verifyBrc38StructuredNativeReceiverSchema(k)
    await k.raw('RELEASE brc38_structured_native_schema')
  } catch (cause) {
    try {
      await k.raw('ROLLBACK TO brc38_structured_native_schema')
      await k.raw('RELEASE brc38_structured_native_schema')
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Structured receiver schema rollback failed')
    }
    throw cause
  }
}
