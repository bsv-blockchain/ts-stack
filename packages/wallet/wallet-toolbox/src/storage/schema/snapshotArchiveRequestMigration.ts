import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

export const SNAPSHOT_ARCHIVE_REQUEST_MIGRATION = '2026-09-30-003 add snapshot archive requests'

export async function addSnapshotArchiveRequestTable(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('snapshot_archive_requests'))) {
    await knex.schema.createTable('snapshot_archive_requests', table => {
      table.string('identityKey', 130).notNullable()
      table.string('requestId', 64).notNullable()
      table.string('claimToken', 64).notNullable()
      table.string('state', 16).notNullable()
      table.string('requestJson', 512).notNullable()
      table.bigInteger('expiresAt').notNullable().index()
      table.bigInteger('reservedBytes').notNullable()
      table.string('archiveId', 64).nullable()
      table.boolean('released').notNullable()
      table.primary(['identityKey', 'requestId'])
    })
  }
}

export async function removeSnapshotArchiveRequestTable(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('snapshot_archive_requests')) {
    const active = await knex('snapshot_archive_requests').where({ released: false }).first('requestId')
    if (active !== undefined) {
      throw new WERR_INVALID_OPERATION('Close snapshot archive requests before removing their schema')
    }
  }
  await knex.schema.dropTableIfExists('snapshot_archive_requests')
}
