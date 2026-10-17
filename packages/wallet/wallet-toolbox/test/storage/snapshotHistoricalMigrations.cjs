// Native fixtures deliberately retain the schema whose migration they qualify.
const assert = require('node:assert/strict')
const {
  KnexMigrations,
  SNAPSHOT_SQLITE_INDEX_MIGRATION,
  SNAPSHOT_JOURNAL_SOURCE_MIGRATION
} = require('../../out/src/storage/schema/KnexMigrations.js')
async function migrateBeforeSqliteGeneration(source, name, identity) {
  const migrationSource = new KnexMigrations(source.chain, name, identity, 1024)
  migrationSource.migrations = Object.fromEntries(
    Object.entries(migrationSource.migrations).filter(([name]) => name < SNAPSHOT_SQLITE_INDEX_MIGRATION)
  )
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
async function migrateBeforeJournalGeneration(source, name, identity) {
  const migrationSource = new KnexMigrations(source.chain, name, identity, 1024)
  migrationSource.migrations = Object.fromEntries(
    Object.entries(migrationSource.migrations).filter(([name]) => name < SNAPSHOT_JOURNAL_SOURCE_MIGRATION)
  )
  const config = { migrationSource, disableTransactions: false }
  const sqlite = String(source.knex.client.config.client).includes('sqlite')
  if (sqlite) await source.knex.raw('PRAGMA foreign_keys=OFF')
  try {
    await source.knex.migrate.latest(config)
    assert.equal(await source.knex.schema.hasTable('snapshot_journal_generation'), false)
    assert.equal((await source.knex('knex_migrations').where('name', SNAPSHOT_JOURNAL_SOURCE_MIGRATION)).length, 0)
    return await source.knex.migrate.currentVersion(config)
  } finally {
    if (sqlite) await source.knex.raw('PRAGMA foreign_keys=ON')
  }
}
module.exports = { migrateBeforeSqliteGeneration, migrateBeforeJournalGeneration }
