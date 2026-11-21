import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import {
  installBrc38PrivateNativeCandidateSchema,
  type Brc38PrivateNativeRestoreOptions
} from './Brc38PrivateNativeRestoreNode'
import { SNAPSHOT_JOURNAL_SOURCE_MIGRATION } from '../schema/KnexMigrations'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { hasBrc38NativePreparedFieldsSchema } from './Brc38NativePreparedFieldSchemaNode'
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private candidate schema-order case failed')
}
/** Fresh genuine authenticated structured store and original finite resource
 * admission. Run both ordinary v5 and optional local receiver variants on
 * independent actual candidates. Nondefault policy detects silent use of the
 * ordinary source migration defaults; fresh schema checks detect an early seal. */
export async function verifyBrc38PrivateNativeCandidateSchemaOrder(
  store: KnexBrc38StagingStore,
  options: Brc38PrivateNativeRestoreOptions,
  localBaseline: boolean,
  check: () => void
): Promise<void> {
  const bound = store.binding
  requireCase(
    bound !== undefined &&
      options.receiptPolicy.receiptLimit === 7 &&
      options.receiptPolicy.receiptLifetimeMs === 123456
  )
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions(bound.binding.chain),
    knex: store.knex,
    snapshotSync: false
  })
  storage.setServices(options.services)
  check()
  await store.withAuthenticatedPrivateStructuredDestination(async () => {
    await installBrc38PrivateNativeCandidateSchema(
      storage,
      store,
      bound.binding.targetStorageIdentityKey,
      options,
      true,
      true,
      localBaseline
    )
    const generation = await readSnapshotJournalSqliteGeneration(store.knex, options.receiptPolicy)
    requireCase(generation.complete && generation.enabled)
    await store.knex.transaction(async trx => {
      store.assertPrivateNativeWriteTransaction(trx)
      requireCase((await hasBrc38NativePackedTextSchema(trx)) && (await hasBrc38NativePreparedFieldsSchema(trx)))
      requireCase((await hasBrc38NativeLocalPackedLayout(trx)) === localBaseline)
    })
    const migrations = (await store.knex('knex_migrations').select('name').orderBy('id', 'desc').limit(1)) as Array<{
        name: string
      }>,
      retention = (await store
        .knex('snapshot_journal_retention')
        .where({ id: 1 })
        .first('receiptLimit', 'receiptLifetimeMs')) as { receiptLimit: number; receiptLifetimeMs: number } | undefined
    requireCase(
      migrations.length === 1 &&
        migrations[0].name === SNAPSHOT_JOURNAL_SOURCE_MIGRATION &&
        retention?.receiptLimit === 7 &&
        retention.receiptLifetimeMs === 123456
    )
    // Re-entry preserves the actual generation, ledger and original policy.
    await installBrc38PrivateNativeCandidateSchema(
      storage,
      store,
      bound.binding.targetStorageIdentityKey,
      options,
      true,
      true,
      localBaseline
    )
    requireCase(
      JSON.stringify(await readSnapshotJournalSqliteGeneration(store.knex, options.receiptPolicy)) ===
        JSON.stringify(generation)
    )
    check()
  })
}
