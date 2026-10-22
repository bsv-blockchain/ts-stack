import { KnexMigrations, SNAPSHOT_JOURNAL_DESTINATION_MIGRATION } from '../../src/storage/schema/KnexMigrations'
import type { StorageKnex } from '../../src/storage/StorageKnex'

/** Historical test schema only. These fixtures exercise the actual first
 * installation, incomplete bootstrap, custom policy and refused ownership
 * transitions. Applying the new registered complete generation beforehand
 * would replace the state under test. No production migration is changed,
 * no lifecycle stamp is invented, and no oracle/assertion is weakened. */
export function historicalSnapshotJournalMigrations(
  storage: StorageKnex,
  storageName: string,
  storageIdentityKey: string
): KnexMigrations {
  const migrations = new KnexMigrations(storage.chain, storageName, storageIdentityKey, 1024)
  migrations.migrations = Object.fromEntries(
    Object.entries(migrations.migrations).filter(([name]) => name < SNAPSHOT_JOURNAL_DESTINATION_MIGRATION)
  )
  return migrations
}

export async function migrateBeforeSnapshotJournal(
  storage: StorageKnex,
  storageName: string,
  storageIdentityKey: string,
  migrationSource = historicalSnapshotJournalMigrations(storage, storageName, storageIdentityKey)
): Promise<string> {
  const client = String(storage.knex.client.config.client)
  if (client !== 'sqlite3' && client !== 'better-sqlite3')
    throw new Error('Historical journal fixture requires actual SQLite')
  const config = { migrationSource, disableTransactions: false }
  await storage.knex.raw('PRAGMA foreign_keys = OFF')
  try {
    await storage.knex.migrate.latest(config)
    return await storage.knex.migrate.currentVersion(config)
  } finally {
    await storage.knex.raw('PRAGMA foreign_keys = ON')
  }
}
