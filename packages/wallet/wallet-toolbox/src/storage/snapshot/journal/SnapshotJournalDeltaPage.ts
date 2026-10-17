import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalDelta, SnapshotJournalDeltaPage } from './SnapshotJournalTypes'
export type { SnapshotJournalDelta, SnapshotJournalDeltaPage } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { walletSnapshotSourceQuery } from '../KnexWalletReadSnapshot'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import { snapshotJournalSourceIndexes, type SnapshotJournalSourceIndexes } from './SnapshotJournalSourceGenerations'
import {
  readSnapshotJournalMetadataPage,
  snapshotJournalMetadataQuery,
  type SnapshotJournalInterval,
  type SnapshotJournalMetadata,
  type SnapshotJournalPosition
} from './SnapshotJournalPage'

interface Source {
  table: WalletSnapshotTable
  name: string
  keys: readonly string[]
}

// Journal IDs follow observer order, not portable archive or sync dependency order.
const sources: readonly Source[] = [
  { table: 'transactions', name: 'transactions', keys: ['transactionId'] },
  { table: 'outputs', name: 'outputs', keys: ['outputId'] },
  { table: 'certificates', name: 'certificates', keys: ['certificateId'] },
  { table: 'txLabels', name: 'tx_labels', keys: ['txLabelId'] },
  { table: 'outputBaskets', name: 'output_baskets', keys: ['basketId'] },
  { table: 'outputTags', name: 'output_tags', keys: ['outputTagId'] },
  { table: 'commissions', name: 'commissions', keys: ['commissionId'] },
  { table: 'syncStates', name: 'sync_states', keys: ['syncStateId'] },
  { table: 'provenTxs', name: 'proven_txs', keys: ['provenTxId'] },
  { table: 'provenTxReqs', name: 'proven_tx_reqs', keys: ['provenTxReqId'] },
  { table: 'txLabelMaps', name: 'tx_labels_map', keys: ['txLabelId', 'transactionId'] },
  { table: 'outputTagMaps', name: 'output_tags_map', keys: ['outputTagId', 'outputId'] },
  { table: 'certificateFields', name: 'certificate_fields', keys: ['certificateId', 'fieldName'] }
]

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or inconsistent snapshot journal delta source')
}

function driver(k: Knex): boolean {
  const client = k.client.config.client
  if (!k.isTransaction) return invalid()
  if (client === 'better-sqlite3' || client === 'sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

function position(row: SnapshotJournalMetadata): SnapshotJournalPosition {
  return { revision: row.revision, id1: row.id1, id2: row.id2, exactText: row.exactText }
}

function values(source: Source, row: SnapshotJournalMetadata): Array<string | number> {
  if (source.table === 'certificateFields') {
    if (row.id2 !== 0) return invalid()
    return [row.id1, row.exactText]
  }
  if (row.exactText !== '' || (source.keys.length === 1 ? row.id2 !== 0 : row.id2 < 1)) return invalid()
  return source.keys.length === 1 ? [row.id1] : [row.id1, row.id2]
}

async function columns(k: Knex, source: Source, mysql: boolean): Promise<string[]> {
  const rows: Array<{ name: unknown }> = mysql
    ? (
        await k.raw(
          'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 65',
          [source.name]
        )
      )[0]
    : await k.raw('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 65', [source.name])
  if (
    rows.length === 0 ||
    rows.length > 64 ||
    rows.some(({ name }) => typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > 128 || name === '')
  )
    return invalid()
  const names = rows.map(({ name }) => name as string)
  if (new Set(names).size !== names.length || source.keys.some(key => !names.includes(key))) return invalid()
  return names
}

/** An exact physical event is relevant only while this profile retains references.
 * Scope events separately carry membership acquisition/loss. Never let another
 * profile's global change create a destination object or consume an unbounded scan. */
export async function snapshotJournalPhysicalMember(
  k: Knex,
  interval: SnapshotJournalInterval,
  row: SnapshotJournalMetadata,
  mysql: boolean
): Promise<boolean> {
  const records: Array<{ refs: unknown; present: unknown }> = await k(
    mysql ? 'snapshot_global_keys' : 'snapshot_global_keys_v2'
  )
    .select('refs', 'present')
    .where({ tableId: interval.tableId === 8 ? 1 : 0, userId: interval.userId, rowId: row.id1 })
    .limit(2)
  if (records.length > 1) return invalid()
  const record = records[0]
  if (record === undefined) return false
  if (
    typeof record.refs !== 'number' &&
    (typeof record.refs !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(record.refs))
  )
    return invalid()
  const refs = Number(record.refs)
  if (!Number.isSafeInteger(refs) || refs < 0 || ![0, 1, false, true].includes(record.present as number | boolean))
    return invalid()
  if (refs === 0) return false
  if ((record.present === 1 || record.present === true) !== row.present) return invalid()
  return true
}

function pointQuery(
  k: Knex,
  source: Source,
  userId: number,
  key: Array<number | string>,
  mysql: boolean,
  indexes: SnapshotJournalSourceIndexes
): Knex.QueryBuilder {
  const query = walletSnapshotSourceQuery(
    k,
    source.table,
    userId,
    indexes.profile,
    indexes.relation,
    indexes.certificate,
    indexes.global
  )
  for (const [index, column] of source.keys.entries()) {
    void query.where(source.name + '.' + column, key[index])
    if (column === 'fieldName')
      void query.whereRaw(mysql ? 'CAST(?? AS BINARY)=CAST(? AS BINARY)' : 'CAST(?? AS BLOB)=CAST(? AS BLOB)', [
        source.name + '.' + column,
        key[index]
      ])
  }
  const parents: Partial<Record<WalletSnapshotTable, Array<[string, string]>>> = {
    txLabelMaps: [
      ['tx_labels', 'txLabelId'],
      ['transactions', 'transactionId']
    ],
    outputTagMaps: [
      ['output_tags', 'outputTagId'],
      ['outputs', 'outputId']
    ],
    certificateFields: [['certificates', 'certificateId']]
  }
  for (const [table, key] of parents[source.table] ?? [])
    void query.whereExists(
      k(table)
        .select(k.raw('1'))
        .where(table + '.userId', userId)
        .whereRaw('??=??', [table + '.' + key, source.name + '.' + key])
    )
  if (source.table === 'certificateFields') void query.where(source.name + '.userId', userId)
  return query
}

function charge(k: Knex, source: Source, fields: string[], mysql: boolean): Knex.Raw {
  const expression = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  return k.raw('(' + fields.map(() => '2*coalesce(' + expression + ',0)+64').join('+') + ') as ??', [
    ...fields.map(field => source.name + '.' + field),
    '__deltaBytes'
  ])
}

/** Internal delta materialization, on the caller's already validated complete
 * journal/index generation. The SAME pinned transaction must supply the receipt,
 * epoch, floor, high-water and every metadata/payload read. The high-water must
 * describe this view, not an arbitrary historical revision. This helper grants no
 * source lease, capability, destination checkpoint or primary-change authority.
 * No column/schema/ownership verdict survives this call. */
export async function readSnapshotJournalDeltaPage(
  k: Knex,
  input: SnapshotJournalInterval,
  maxBytes = 262144,
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<SnapshotJournalDeltaPage> {
  const mysql = driver(k)
  const indexes = snapshotJournalSourceIndexes(k, inputIndexes)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16777216) return invalid()
  const interval = { ...input, ...(input.after === undefined ? {} : { after: { ...input.after } }) }
  // Validate and detach before the first asynchronous boundary, including empty intervals.
  snapshotJournalMetadataQuery(k, interval)
  const source = sources[interval.tableId]
  if (source === undefined) return invalid()
  const metadata = await readSnapshotJournalMetadataPage(k, interval)
  const changes: SnapshotJournalDelta[] = []
  let fields: string[] | undefined,
    payloadBytes = 0,
    examined = 0,
    after = interval.after
  for (const entry of metadata.rows) {
    const key = values(source, entry)
    const member = interval.stream === 'scope' || (await snapshotJournalPhysicalMember(k, interval, entry, mysql))
    let rowBytes = 0
    if (member && entry.present) {
      fields ??= await columns(k, source, mysql)
      const sizes: Array<{ __deltaBytes: unknown }> = await pointQuery(k, source, interval.userId, key, mysql, indexes)
        .select(charge(k, source, fields, mysql))
        .limit(2)
      if (sizes.length !== 1) return invalid()
      rowBytes = Number(sizes[0].__deltaBytes)
      if (!Number.isSafeInteger(rowBytes) || rowBytes < 0) return invalid()
    }
    const bytes = rowBytes + 256 + 2 * Buffer.byteLength(entry.exactText, 'utf8')
    if (!Number.isSafeInteger(bytes) || payloadBytes + bytes > maxBytes) {
      if (examined === 0) throw new SnapshotResourceLimitError('Snapshot journal delta exceeds maxBytes')
      break
    }
    if (member) {
      if (!entry.present) changes.push({ metadata: { ...entry }, present: false })
      else {
        const rows: Array<Record<string, unknown>> = await pointQuery(k, source, interval.userId, key, mysql, indexes)
          .select(source.name + '.*')
          .limit(2)
        const raw = rows[0]
        if (fields === undefined) return invalid()
        if (rows.length !== 1 || raw === undefined || Reflect.ownKeys(raw).length !== fields.length) return invalid()
        // Native SQLite and MySQL rows can belong to the driver's realm/class.
        // Detach only the freshly observed bounded SQL columns, without getters,
        // before the strict plain-data frame parser sees them. Cells stay raw.
        const entries = fields.map(field => {
          const descriptor = Object.getOwnPropertyDescriptor(raw, field)
          if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            return invalid()
          return [field, descriptor.value] as const
        })
        const row = Object.fromEntries(entries)
        if (source.keys.some((field, index) => row[field] !== key[index])) return invalid()
        changes.push({ metadata: { ...entry }, present: true, row })
      }
    }
    payloadBytes += bytes
    examined++
    after = position(entry)
  }
  return {
    table: source.table,
    changes,
    examined,
    payloadBytes,
    complete: examined === metadata.rows.length && metadata.complete,
    ...(after === undefined ? {} : { after: { ...after } })
  }
}
