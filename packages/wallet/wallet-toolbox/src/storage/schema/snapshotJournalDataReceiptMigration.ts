import type { Knex } from 'knex'
import {
  snapshotComparisonReceiptSchema,
  snapshotComparisonReceiptDdl,
  verifySnapshotComparisonReceiptSchema,
  snapshotSyncContentReceiptSchema
} from './snapshotSyncReceiptMigration'

export const SNAPSHOT_JOURNAL_DATA_RECEIPT_MIGRATION = '2026-10-17-002 add journal DATA copy receipts'
export const SNAPSHOT_JOURNAL_DATA_RECEIPTS = 'snapshot_sync_journal_data_receipts'
const specification = snapshotComparisonReceiptSchema(
  SNAPSHOT_JOURNAL_DATA_RECEIPTS,
  'snapshot_sync_journal_data_receipts_user',
  [
    ...snapshotSyncContentReceiptSchema.columns.map(
      ([name, type, nullable]) => [name, name === 'activeStorage' ? 'varchar(256)' : type, nullable] as const
    ),
    ['checkpointJson', 'varchar(4096)', true]
  ]
)

/** Separate optional DATA; no legacy ACK is fabricated or reinterpreted. */
export function snapshotJournalDataReceiptDdl(k: Knex): string {
  return snapshotComparisonReceiptDdl(k, specification)
}
export async function verifySnapshotJournalDataReceiptSchema(k: Knex): Promise<void> {
  await verifySnapshotComparisonReceiptSchema(k, specification)
}
export async function addSnapshotJournalDataReceiptSchema(k: Knex): Promise<void> {
  const ddl = snapshotJournalDataReceiptDdl(k)
  if (!(await k.schema.hasTable(SNAPSHOT_JOURNAL_DATA_RECEIPTS))) await k.raw(ddl)
  await verifySnapshotJournalDataReceiptSchema(k)
}
export async function removeSnapshotJournalDataReceiptSchema(k: Knex): Promise<void> {
  snapshotJournalDataReceiptDdl(k)
  if (await k.schema.hasTable(SNAPSHOT_JOURNAL_DATA_RECEIPTS)) {
    await verifySnapshotJournalDataReceiptSchema(k)
    await k.schema.dropTable(SNAPSHOT_JOURNAL_DATA_RECEIPTS)
  }
}
