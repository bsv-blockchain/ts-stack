import { readNativeSnapshotSyncMappingRevision } from './NativeSnapshotSyncMappingSchemaNode'
import type { Knex } from 'knex'
import { requireBrc38PackedRead } from '../portable/Brc38NativePackedSchemaNode'
import { snapshotSyncPrimaryChangeSqlite } from '../schema/snapshotSyncMigration'

type Column = readonly [name: string, type: string, notNull: number, primary: number]
const columns: Readonly<Record<string, readonly Column[]>> = {
  snapshot_sync_sessions: [
    ['userId', 'INTEGER', 1, 1],
    ['sourceStorageIdentityKey', 'varchar(130)', 1, 2],
    ['sessionId', 'varchar(64)', 1, 0],
    ['snapshotId', 'varchar(64)', 1, 0],
    ['version', 'INTEGER', 1, 0],
    ['sourceUserId', 'bigint', 1, 0],
    ['identityKey', 'varchar(130)', 1, 0],
    ['destinationStorageIdentityKey', 'varchar(130)', 1, 0],
    ['chain', 'varchar(8)', 1, 0],
    ['activeStorage', 'varchar(130)', 0, 0],
    ['sourceActiveStorage', 'varchar(130)', 0, 0],
    ['sourceUserCreatedAt', 'varchar(64)', 1, 0],
    ['sourceUserUpdatedAt', 'varchar(64)', 1, 0],
    ['primaryEpoch', 'bigint', 1, 0],
    ['expiresAt', 'bigint', 1, 0],
    ['tableIndex', 'INTEGER', 1, 0],
    ['sequence', 'INTEGER', 1, 0],
    ['cursor', 'TEXT', 0, 0]
  ],
  snapshot_sync_ids: [
    ['userId', 'INTEGER', 1, 1],
    ['sourceStorageIdentityKey', 'varchar(130)', 1, 2],
    ['entity', 'varchar(32)', 1, 3],
    ['incomingId', 'bigint', 1, 4],
    ['localId', 'bigint', 1, 0]
  ],
  snapshot_sync_primary_epochs: [
    ['userId', 'INTEGER', 1, 1],
    ['epoch', 'bigint', 1, 0]
  ]
}
function invalid(): never {
  throw new Error('Native snapshot sync current auxiliary schema or primary fence differs')
}

/** Fresh bounded shape, PK/FK/index and exact primary-trigger inspection.
 * This is not a persisted/cached schema verdict, source grant or checkpoint.
 * The enclosing native transaction/generation/profile owner remains required.
 * Original stock providers keep their own migration/compatibility path. */
export async function verifyNativeSnapshotSyncSchema(trx: Knex.Transaction): Promise<void> {
  requireBrc38PackedRead(trx)
  for (const [table, expected] of Object.entries(columns)) {
    const rows = (await trx.raw(
      'SELECT cid,name,type,"notnull",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid LIMIT ?',
      [table, expected.length + 1]
    )) as Array<{
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
    }>
    if (
      rows.length !== expected.length ||
      rows.some(
        (row, index) =>
          row.cid !== index ||
          row.name !== expected[index][0] ||
          row.type.toLowerCase() !== expected[index][1].toLowerCase() ||
          row.notnull !== expected[index][2] ||
          row.pk !== expected[index][3] ||
          row.dflt_value !== null
      )
    )
      invalid()
    const foreign = (await trx.raw('PRAGMA foreign_key_list(??)', [table])) as Array<{
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
      match: string
    }>
    if (
      foreign.length !== 1 ||
      foreign[0].id !== 0 ||
      foreign[0].seq !== 0 ||
      foreign[0].table !== 'users' ||
      foreign[0].from !== 'userId' ||
      foreign[0].to !== 'userId' ||
      foreign[0].on_update !== 'NO ACTION' ||
      foreign[0].on_delete !== 'NO ACTION' ||
      foreign[0].match !== 'NONE'
    )
      invalid()
    const indexes = (await trx.raw('PRAGMA index_list(??)', [table])) as Array<{
      name: string
      unique: number
      origin: string
      partial: number
    }>
    // INTEGER PRIMARY KEY is the native rowid alias and owns no extra index.
    if (table === 'snapshot_sync_primary_epochs') {
      if (indexes.length !== 0) invalid()
    } else {
      if (
        indexes.length !== 1 ||
        indexes[0].name !== `sqlite_autoindex_${table}_1` ||
        indexes[0].unique !== 1 ||
        indexes[0].origin !== 'pk' ||
        indexes[0].partial !== 0
      )
        invalid()
      const keys = (await trx.raw('PRAGMA index_info(??)', [indexes[0].name])) as Array<{
          seqno: number
          cid: number
          name: string
        }>,
        primary = expected.filter(column => column[3] > 0)
      if (
        keys.length !== primary.length ||
        keys.some(
          (key, index) =>
            key.seqno !== index ||
            key.name !== primary[index][0] ||
            key.cid !== expected.findIndex(column => column[0] === key.name)
        )
      )
        invalid()
    }
    requireBrc38PackedRead(trx)
  }
  const sql = snapshotSyncPrimaryChangeSqlite.replace(' IF NOT EXISTS', ''),
    trigger = (await trx('sqlite_schema')
      .where({ name: 'snapshot_sync_primary_change', type: 'trigger', tbl_name: 'users' })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined,
    named = (await trx('sqlite_schema')
      .whereRaw('substr(name,1,14)=?', ['snapshot_sync_'])
      .count({ count: '*' })
      .first()) as { count: unknown } | undefined
  if (trigger?.count !== 1 || named?.count !== 4) invalid()
  await readNativeSnapshotSyncMappingRevision(trx)
  requireBrc38PackedRead(trx)
}
