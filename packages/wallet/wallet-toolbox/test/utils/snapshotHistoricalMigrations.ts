import { StorageKnex } from '../../src/storage/StorageKnex'
import { KnexMigrations, SNAPSHOT_SQLITE_INDEX_MIGRATION } from '../../src/storage/schema/KnexMigrations'

/** Deliberately build the historical schema whose migration a fixture exercises. */
export async function migrateBeforeSqliteGeneration(
  source: StorageKnex,
  storageName: string,
  storageIdentityKey: string
): Promise<string> {
  const migrationSource = new KnexMigrations(source.chain, storageName, storageIdentityKey, 1024)
  delete migrationSource.migrations[SNAPSHOT_SQLITE_INDEX_MIGRATION]
  const config = { migrationSource, disableTransactions: false }
  const sqlite = String(source.knex.client.config.client).includes('sqlite')
  if (sqlite) await source.knex.raw('PRAGMA foreign_keys=OFF')
  try {
    await source.knex.migrate.latest(config)
    return await source.knex.migrate.currentVersion(config)
  } finally {
    if (sqlite) await source.knex.raw('PRAGMA foreign_keys=ON')
  }
}
