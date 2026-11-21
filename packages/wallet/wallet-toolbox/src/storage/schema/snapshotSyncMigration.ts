import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'

export const SNAPSHOT_SYNC_MIGRATION = '2026-09-30-001 add durable snapshot sync'
export const snapshotSyncPrimaryChangeSqlite = `CREATE TRIGGER IF NOT EXISTS snapshot_sync_primary_change AFTER UPDATE OF activeStorage ON users
      WHEN OLD.activeStorage IS NOT NEW.activeStorage BEGIN
        INSERT INTO snapshot_sync_primary_epochs (userId, epoch) VALUES (NEW.userId, 1)
        ON CONFLICT(userId) DO UPDATE SET epoch = epoch + 1;
      END`

export const snapshotSyncPrimaryChangeMysqlBody = `BEGIN IF NOT (OLD.activeStorage <=> NEW.activeStorage) THEN
        INSERT INTO snapshot_sync_primary_epochs (userId, epoch) VALUES (NEW.userId, 1)
        ON DUPLICATE KEY UPDATE epoch = epoch + 1;
      END IF; END`

/** Fresh database-owned ABA fence inspection. A migration history row alone
 * cannot establish that the current primary trigger is still installed. */
export async function verifySnapshotSyncPrimaryFence(knex: Knex): Promise<void> {
  const mysql = String(knex.client.config.client).includes('mysql')
  if (mysql) {
    const [rows]: Array<
      Array<{
        ACTION_STATEMENT: string
        EVENT_OBJECT_TABLE: string
        ACTION_TIMING: string
        EVENT_MANIPULATION: string
        ACTION_ORIENTATION: string
      }>
    > = await knex.raw(
      `SELECT ACTION_STATEMENT, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?
       AND OCTET_LENGTH(ACTION_STATEMENT)<=4096 LIMIT 2`,
      ['snapshot_sync_primary_change']
    )
    const row = rows[0],
      normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
    if (
      rows.length !== 1 ||
      row.EVENT_OBJECT_TABLE !== 'users' ||
      row.ACTION_TIMING !== 'AFTER' ||
      row.EVENT_MANIPULATION !== 'UPDATE' ||
      row.ACTION_ORIENTATION !== 'ROW' ||
      normalize(row.ACTION_STATEMENT) !== normalize(snapshotSyncPrimaryChangeMysqlBody)
    )
      throw new Error('Snapshot sync destination primary fence is incomplete or changed')
  } else {
    const rows = await knex('sqlite_master')
      .where({ name: 'snapshot_sync_primary_change', type: 'trigger', tbl_name: 'users' })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [snapshotSyncPrimaryChangeSqlite.replace(' IF NOT EXISTS', '')])
      .select('name')
      .limit(2)
    if (rows.length !== 1) throw new Error('Snapshot sync destination primary fence is incomplete or changed')
  }
}

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
    await runInSeries(['snapshot_sync_sessions', 'snapshot_sync_ids', 'snapshot_sync_primary_epochs'], async table => {
      const constraint = table + '_user'
      const [existing]: Array<Array<{ name: string }>> = await knex.raw(
        "SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
        [table, constraint]
      )
      if (existing.length === 0)
        await knex.schema.table(table, definition => {
          definition.foreign('userId', constraint).references('userId').inTable('users')
        })
    })
    const [triggers]: Array<Array<{ name: string }>> = await knex.raw(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?',
      ['snapshot_sync_primary_change']
    )
    if (triggers.length === 0)
      await knex.raw(`CREATE TRIGGER snapshot_sync_primary_change AFTER UPDATE ON users
      FOR EACH ROW ${snapshotSyncPrimaryChangeMysqlBody}`)
  } else {
    await knex.raw(snapshotSyncPrimaryChangeSqlite)
  }
}

export async function removeSnapshotSyncTables(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS snapshot_sync_primary_change')
  await knex.schema.dropTableIfExists('snapshot_sync_primary_epochs')
  await knex.schema.dropTableIfExists('snapshot_sync_ids')
  await knex.schema.dropTableIfExists('snapshot_sync_sessions')
}
