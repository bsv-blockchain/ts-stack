import { KnexMigrations, SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION } from '../../src/storage/schema/KnexMigrations'
import type { StorageKnex } from '../../src/storage/StorageKnex'

/** Real old-provider schema, including every previous journal migration. No
 * capability stamp or schema verdict is invented for compatibility tests. */
export async function migrateBeforeSnapshotContentReceipts(
  storage: StorageKnex,
  name: string,
  identity: string
): Promise<void> {
  const client = String(storage.knex.client.config.client)
  if (client !== 'sqlite3' && client !== 'better-sqlite3')
    throw new Error('Historical content receipt fixture requires actual SQLite')
  const migrationSource = new KnexMigrations(storage.chain, name, identity, 1024)
  migrationSource.migrations = Object.fromEntries(
    Object.entries(migrationSource.migrations).filter(([name]) => name < SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION)
  )
  await storage.knex.raw('PRAGMA foreign_keys=OFF')
  try {
    await storage.knex.migrate.latest({ migrationSource, disableTransactions: false })
  } finally {
    await storage.knex.raw('PRAGMA foreign_keys=ON')
  }
}
