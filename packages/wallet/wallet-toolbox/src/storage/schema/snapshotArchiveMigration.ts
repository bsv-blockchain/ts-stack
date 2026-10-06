import type { Knex } from 'knex'

export const SNAPSHOT_ARCHIVE_MIGRATION = '2026-09-30-002 add snapshot archive staging'

/** Separate from standard wallet tables and legacy synchronization checkpoints. */
export async function addSnapshotArchiveTables(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('snapshot_archive_capacity'))) {
    await knex.schema.createTable('snapshot_archive_capacity', table => {
      table.integer('id').primary()
      table.integer('archives').notNullable()
      table.bigInteger('reservedBytes').notNullable()
    })
  }
  await knex('snapshot_archive_capacity').insert({ id: 1, archives: 0, reservedBytes: 0 }).onConflict('id').ignore()
  if (!(await knex.schema.hasTable('snapshot_archives'))) {
    await knex.schema.createTable('snapshot_archives', table => {
      table.string('archiveId', 64).primary()
      table.string('identityKey', 130).notNullable().unique()
      table.string('writerToken', 64).notNullable()
      table.string('state', 16).notNullable()
      table.text('binding', 'mediumtext').notNullable()
      table.bigInteger('expiresAt').notNullable().index()
      table.bigInteger('reservedBytes').notNullable()
      table.bigInteger('usedBytes').notNullable()
      table.integer('nextSequence').notNullable()
      table.integer('tableIndex').notNullable()
      table.bigInteger('rows').notNullable()
      table.string('digest', 64).notNullable()
    })
  }
  if (!(await knex.schema.hasTable('snapshot_archive_pages'))) {
    await knex.schema.createTable('snapshot_archive_pages', table => {
      table.string('archiveId', 64).notNullable()
      table.integer('sequence').notNullable()
      table.string('tableName', 32).notNullable()
      table.integer('rows').notNullable()
      table.boolean('done').notNullable()
      table.string('digest', 64).notNullable()
      const mysql = String(knex.client.config.client).includes('mysql')
      table.specificType('payload', mysql ? 'MEDIUMBLOB' : 'BLOB').notNullable()
      table.primary(['archiveId', 'sequence'])
    })
  }
}

export async function removeSnapshotArchiveTables(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('snapshot_archive_pages')
  await knex.schema.dropTableIfExists('snapshot_archives')
  await knex.schema.dropTableIfExists('snapshot_archive_capacity')
}
