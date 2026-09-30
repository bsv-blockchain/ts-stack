import type { Knex } from 'knex'

export const SNAPSHOT_SYNC_MIGRATION = '2026-09-30-001 add durable snapshot sync'

/** Auxiliary tables only: preserve standard-table traversal and legacy sync-map JSON. */
export async function addSnapshotSyncTables(knex: Knex): Promise<void> {
  const mysql = String(knex.client.config.client).includes('mysql')
  const userColumn = (table: Knex.CreateTableBuilder): Knex.ColumnBuilder => {
    const column = table.integer('userId').unsigned().notNullable()
    // MySQL creates foreign keys in separate DDL. Install/recover them below.
    if (!mysql) column.references('userId').inTable('users')
    return column
  }
  // MySQL DDL commits implicitly. Creations are idempotent after interruption.
  if (!(await knex.schema.hasTable('snapshot_sync_sessions'))) {
    await knex.schema.createTable('snapshot_sync_sessions', table => {
      userColumn(table)
      table.string('sourceStorageIdentityKey', 130).notNullable()
      table.string('sessionId', 64).notNullable()
      table.string('snapshotId', 64).notNullable()
      table.integer('version').notNullable()
      table.bigInteger('sourceUserId').unsigned().notNullable()
      table.string('identityKey', 130).notNullable()
      table.string('destinationStorageIdentityKey', 130).notNullable()
      table.string('chain', 8).notNullable()
      table.string('activeStorage', 130).nullable()
      table.string('sourceActiveStorage', 130).nullable()
      table.string('sourceUserCreatedAt', 64).notNullable()
      table.string('sourceUserUpdatedAt', 64).notNullable()
      table.bigInteger('primaryEpoch').notNullable()
      table.bigInteger('expiresAt').notNullable()
      table.integer('tableIndex').notNullable()
      table.integer('sequence').notNullable()
      table.text('cursor').nullable()
      table.primary(['userId', 'sourceStorageIdentityKey'])
    })
  }
  if (!(await knex.schema.hasTable('snapshot_sync_ids'))) {
    await knex.schema.createTable('snapshot_sync_ids', table => {
      userColumn(table)
      table.string('sourceStorageIdentityKey', 130).notNullable()
      table.string('entity', 32).notNullable()
      table.bigInteger('incomingId').unsigned().notNullable()
      table.bigInteger('localId').unsigned().notNullable()
      table.primary(['userId', 'sourceStorageIdentityKey', 'entity', 'incomingId'])
    })
  }
  if (!(await knex.schema.hasTable('snapshot_sync_primary_epochs'))) {
    await knex.schema.createTable('snapshot_sync_primary_epochs', table => {
      userColumn(table).primary()
      table.bigInteger('epoch').notNullable()
    })
  }
  // A primary may change away and back to the same identity. A database-owned
  // counter fences that ABA transition, including older/independent writers.
  if (mysql) {
    for (const table of ['snapshot_sync_sessions', 'snapshot_sync_ids', 'snapshot_sync_primary_epochs']) {
      const constraint = table + '_user'
      const [existing]: Array<Array<{ name: string }>> = await knex.raw(
        "SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
        [table, constraint]
      )
      if (existing.length === 0)
        await knex.schema.table(table, definition => {
          definition.foreign('userId', constraint).references('userId').inTable('users')
        })
    }
    const [triggers]: Array<Array<{ name: string }>> = await knex.raw(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
      ['snapshot_sync_primary_change']
    )
    if (triggers.length === 0)
      await knex.raw(`CREATE TRIGGER snapshot_sync_primary_change AFTER UPDATE ON users
      FOR EACH ROW BEGIN IF NOT (OLD.activeStorage <=> NEW.activeStorage) THEN
        INSERT INTO snapshot_sync_primary_epochs (userId, epoch) VALUES (NEW.userId, 1)
        ON DUPLICATE KEY UPDATE epoch = epoch + 1;
      END IF; END`)
  } else {
    await knex.raw(`CREATE TRIGGER IF NOT EXISTS snapshot_sync_primary_change AFTER UPDATE OF activeStorage ON users
      WHEN OLD.activeStorage IS NOT NEW.activeStorage BEGIN
        INSERT INTO snapshot_sync_primary_epochs (userId, epoch) VALUES (NEW.userId, 1)
        ON CONFLICT(userId) DO UPDATE SET epoch = epoch + 1;
      END`)
  }
}

export async function removeSnapshotSyncTables(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS snapshot_sync_primary_change')
  await knex.schema.dropTableIfExists('snapshot_sync_primary_epochs')
  await knex.schema.dropTableIfExists('snapshot_sync_ids')
  await knex.schema.dropTableIfExists('snapshot_sync_sessions')
}
