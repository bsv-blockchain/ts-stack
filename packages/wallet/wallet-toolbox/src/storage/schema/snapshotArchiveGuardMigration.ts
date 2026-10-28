import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { snapshotArchiveLimits } from '../snapshot/archive/SnapshotArchive'

export const SNAPSHOT_ARCHIVE_GUARD_MIGRATION = '2026-10-01-002 add snapshot archive source guards'

/** Older candidate owners default to zero and can never be inferred to use a guard. */
export async function addSnapshotArchiveGuardTable(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('snapshot_archive_owners', 'guardVersion'))) {
    await knex.schema.alterTable('snapshot_archive_owners', table => {
      table.integer('guardVersion').notNullable().defaultTo(0)
    })
  }
  if (!(await knex.schema.hasTable('snapshot_archive_owner_slots'))) {
    await knex.schema.createTable('snapshot_archive_owner_slots', table => {
      table.integer('slot').primary()
      table.text('bindingJson').nullable()
    })
  }
  await knex('snapshot_archive_owner_slots')
    .insert(Array.from({ length: snapshotArchiveLimits.archives }, (_, slot) => ({ slot, bindingJson: null })))
    .onConflict('slot')
    .ignore()
}

export async function removeSnapshotArchiveGuardTable(knex: Knex): Promise<void> {
  if ((await knex('snapshot_archive_owners').first('slot')) !== undefined) {
    throw new WERR_INVALID_OPERATION('Drain snapshot archive sources before removing their guards')
  }
  await knex.schema.dropTableIfExists('snapshot_archive_owner_slots')
  if (await knex.schema.hasColumn('snapshot_archive_owners', 'guardVersion')) {
    await knex.schema.alterTable('snapshot_archive_owners', table => table.dropColumn('guardVersion'))
  }
}
