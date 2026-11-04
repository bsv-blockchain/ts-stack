import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const SNAPSHOT_ARCHIVE_OWNER_MIGRATION = '2026-10-01-001 add snapshot archive source owners'

export async function addSnapshotArchiveOwnerTable(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('snapshot_archive_owners'))) {
    await knex.schema.createTable('snapshot_archive_owners', table => {
      table.integer('slot').primary()
      table.string('identityKey', 130).notNullable()
      table.string('requestId', 64).notNullable()
      table.string('claimToken', 64).notNullable()
      table.string('archiveId', 64).nullable().unique()
      table.unique(['identityKey', 'requestId'])
    })
  }
}

export async function removeSnapshotArchiveOwnerTable(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('snapshot_archive_owners')) {
    if ((await knex('snapshot_archive_owners').first('slot')) !== undefined) {
      throw new WERR_INVALID_OPERATION('Drain snapshot archive sources before removing their schema')
    }
  }
  await knex.schema.dropTableIfExists('snapshot_archive_owners')
}
