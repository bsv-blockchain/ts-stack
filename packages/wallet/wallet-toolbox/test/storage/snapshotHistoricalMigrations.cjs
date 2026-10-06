// Native fixtures deliberately retain the schema whose migration they qualify.
const { KnexMigrations, SNAPSHOT_SQLITE_INDEX_MIGRATION } = require('../../out/src/storage/schema/KnexMigrations.js')
async function migrateBeforeSqliteGeneration(source, name, identity) {
  const migrationSource = new KnexMigrations(source.chain, name, identity, 1024)
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
module.exports = { migrateBeforeSqliteGeneration }
