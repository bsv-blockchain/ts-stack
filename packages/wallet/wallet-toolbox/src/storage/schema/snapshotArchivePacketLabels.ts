import type { Knex } from 'knex'

export const SNAPSHOT_ARCHIVE_PACKET_LABEL_MIGRATION = '2026-10-26-001 widen snapshot archive packet labels'

async function column(knex: Knex) {
  const [rows] = await knex.raw(
    'SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    ['snapshot_archive_pages', 'tableName']
  )
  if (!Array.isArray(rows) || rows.length !== 1) return undefined
  const row = rows[0]
  if (
    row.DATA_TYPE !== 'varchar' ||
    row.IS_NULLABLE !== 'NO' ||
    row.COLUMN_DEFAULT !== null ||
    row.EXTRA !== '' ||
    row.COLUMN_COMMENT !== '' ||
    typeof row.CHARACTER_SET_NAME !== 'string' ||
    typeof row.COLLATION_NAME !== 'string' ||
    !/^[a-zA-Z0-9_]+$/.test(row.CHARACTER_SET_NAME) ||
    !/^[a-zA-Z0-9_]+$/.test(row.COLLATION_NAME)
  )
    return undefined
  return {
    width: Number(row.CHARACTER_MAXIMUM_LENGTH),
    charset: row.CHARACTER_SET_NAME as string,
    collation: row.COLLATION_NAME as string
  }
}

/** SQLite's existing declared VARCHAR(32) is unbounded; preserve its native DDL.
 * MySQL enforces that old width and must fit the existing <=64 packet labels. */
export async function supportsSnapshotArchivePacketLabels(knex: Knex): Promise<boolean> {
  if (!String(knex.client.config.client).includes('mysql')) return true
  return (await column(knex))?.width === 64
}

export async function widenSnapshotArchivePacketLabels(knex: Knex): Promise<void> {
  if (!String(knex.client.config.client).includes('mysql')) return
  const before = await column(knex)
  if (before === undefined || ![32, 64].includes(before.width))
    throw new Error('Snapshot archive packet label column differs from its owned schema')
  if (before.width === 64) return
  await knex.raw('ALTER TABLE ?? MODIFY COLUMN ?? VARCHAR(64) CHARACTER SET ?? COLLATE ?? NOT NULL', [
    'snapshot_archive_pages',
    'tableName',
    before.charset,
    before.collation
  ])
  const after = await column(knex)
  if (after?.width !== 64 || after.charset !== before.charset || after.collation !== before.collation)
    throw new Error('Snapshot archive packet label widening did not preserve its character contract')
}

export async function refuseSnapshotArchivePacketLabelDowngrade(): Promise<void> {
  throw new Error('Snapshot archive packet labels require forward recovery; narrowing could truncate stored artifacts')
}
