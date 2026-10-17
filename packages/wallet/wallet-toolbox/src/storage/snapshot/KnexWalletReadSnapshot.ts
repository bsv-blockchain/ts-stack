import { observeWalletSnapshotFieldReader } from './observeWalletSnapshotFieldReader'
import {
  hydrateBrc38NativePackedWalletRows,
  brc38NativePackedWalletRowCharge,
  type Brc38NativePackedWalletTable
} from '../portable/Brc38NativePackedWalletNode'
import { hasBrc38NativePackedSchema } from '../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from '../portable/Brc38NativePackedTextSchemaNode'
import {
  hydrateBrc38NativePackedTextWalletRows,
  prechargeBrc38NativePackedTextWalletRows,
  brc38NativePackedTextWalletRowCharge,
  isBrc38NativePackedTextWalletTable,
  type Brc38NativePackedTextWalletTable
} from '../portable/Brc38NativePackedTextWalletNode'
import { brc38NativePackedLength } from '../portable/Brc38NativePackedFieldsNode'
import { brc38NativePackedTextLength } from '../portable/Brc38NativePackedTextFieldsNode'
import { readBrc38NativeTextBytes, readBrc38NativeTextExtent } from '../portable/Brc38NativeTextReadNode'
import {
  brc38NativeTextCoordinate,
  brc38NativeTextProtocolSupports,
  type Brc38NativeTextRead
} from '../portable/Brc38NativeBlobProtocol'
import { isBrc38NativeBinaryReadTransaction, readBrc38NativeBinaryExtent } from '../portable/Brc38NativeBinaryReadNode'
import type { Brc38NativeBlobRead } from '../portable/Brc38NativeBlobProtocol'
import { readGenerationIndexState, type SnapshotIndexState } from '../schema/snapshotSqliteIndexState'
import { readSnapshotGlobalIndexState } from '../schema/snapshotGlobalIndexMigration'
import { readSnapshotCertificateIndexState } from '../schema/snapshotCertificateIndexMigration'
import { readSnapshotRelationIndexState } from '../schema/snapshotRelationIndexMigration'
import { readSnapshotProfileIndexState } from '../schema/snapshotProfileIndexMigration'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { RetainedReadSnapshot } from './RetainedReadSnapshot'
import { detachBrc38PrivateChunk } from '../portable/Brc38PrivateChunkPipe'
import type {
  PackedSnapshotRow,
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotPage,
  WalletSnapshotPageLimits,
  WalletSnapshotBinaryColumn,
  WalletSnapshotBinaryReader,
  WalletSnapshotMetadataPage,
  WalletSnapshotMetadataRow,
  WalletSnapshotFieldReader,
  WalletSnapshotFieldMetadataPage,
  WalletSnapshotFieldMetadataRow,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotTable,
  WalletSnapshotTables
} from './WalletReadSnapshot'

interface TableDefinition {
  name: string
  keys: string[]
  booleans?: string[]
  dates?: string[]
}

// Preserve existing logical keys and the standard-table indexes used by legacy
// OFFSET checkpoints. Auxiliary profile keys retain the same snapshot order. Map/field order is explicitly
// storage-key order, not the canonical BRC-38 array order.
const definitions: Record<WalletSnapshotTable, TableDefinition> = {
  provenTxs: { name: 'proven_txs', keys: ['provenTxId'] },
  provenTxReqs: {
    name: 'proven_tx_reqs',
    keys: ['provenTxReqId'],
    booleans: ['notified', 'wasBroadcast']
  },
  outputBaskets: { name: 'output_baskets', keys: ['basketId'], booleans: ['isDeleted'] },
  transactions: { name: 'transactions', keys: ['transactionId'], booleans: ['isOutgoing'] },
  commissions: { name: 'commissions', keys: ['commissionId'], booleans: ['isRedeemed'] },
  outputs: { name: 'outputs', keys: ['outputId'], booleans: ['spendable', 'change'] },
  outputTags: { name: 'output_tags', keys: ['outputTagId'], booleans: ['isDeleted'] },
  outputTagMaps: {
    name: 'output_tags_map',
    keys: ['outputTagId', 'outputId'],
    booleans: ['isDeleted']
  },
  txLabels: { name: 'tx_labels', keys: ['txLabelId'], booleans: ['isDeleted'] },
  txLabelMaps: {
    name: 'tx_labels_map',
    keys: ['txLabelId', 'transactionId'],
    booleans: ['isDeleted']
  },
  certificates: { name: 'certificates', keys: ['certificateId'], booleans: ['isDeleted'] },
  certificateFields: { name: 'certificate_fields', keys: ['fieldName', 'certificateId'] },
  syncStates: { name: 'sync_states', keys: ['syncStateId'], booleans: ['init'], dates: ['when'] }
}

const auxiliaryTableIds: Partial<Record<WalletSnapshotTable, number>> = {
  transactions: 0,
  outputs: 1,
  certificates: 2,
  txLabels: 3,
  outputBaskets: 4,
  outputTags: 5,
  commissions: 6,
  syncStates: 7
}

const auxiliaryRelationTableIds: Partial<Record<WalletSnapshotTable, number>> = {
  txLabelMaps: 0,
  outputTagMaps: 1
}

function definition(table: WalletSnapshotTable): TableDefinition {
  if (!Object.hasOwn(definitions, table)) throw new WERR_INVALID_PARAMETER('table', 'a wallet snapshot table')
  return definitions[table]
}

function bound(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from 1 to ${ceiling}`)
  }
  return result
}

function position(
  cursor: WalletSnapshotCursor | undefined,
  snapshotId: string,
  table: WalletSnapshotTable,
  keys: string[]
): Array<number | string> | undefined {
  if (cursor === undefined) return undefined
  if (
    cursor?.version !== 1 ||
    cursor.snapshotId !== snapshotId ||
    cursor.table !== table ||
    !Array.isArray(cursor.after) ||
    cursor.after.length !== keys.length ||
    cursor.after.some((value, index) =>
      keys[index] === 'fieldName'
        ? typeof value !== 'string' || value.length > 200 || Array.from(value).length > 100
        : !Number.isSafeInteger(value) || (value as number) < 1
    )
  ) {
    throw new WERR_INVALID_PARAMETER('cursor', 'a version-one position for this snapshot and table')
  }
  // Detach before the asynchronous database boundary.
  return [...cursor.after]
}

/** Lexicographic seek, using the same database collation as ORDER BY. */
function seek(
  query: Knex.QueryBuilder,
  keys: string[],
  after: Array<number | string>,
  inclusive: boolean,
  mysql: boolean
): void {
  if (mysql && keys.length === 2) {
    const first = inclusive ? '<' : '>'
    const last = inclusive ? '<=' : '>'
    void query.whereRaw(`(?? ${first} ? OR (?? = ? AND ?? ${last} ?))`, [
      keys[0],
      after[0],
      keys[0],
      after[0],
      keys[1],
      after[1]
    ])
    return
  }
  void query.whereRaw(
    `(${keys.map(() => '??').join(', ')}) ${inclusive ? '<=' : '>'} (${keys.map(() => '?').join(', ')})`,
    [...keys, ...after]
  )
}

function owned(k: Knex, table: string, id: string, source: string, userId: number): Knex.QueryBuilder {
  return k(table)
    .select(k.raw('?', [1]))
    .where(`${table}.userId`, userId)
    .whereRaw('?? = ??', [`${table}.${id}`, source])
}

const globalTableIds: Partial<Record<WalletSnapshotTable, number>> = {
  provenTxReqs: 0,
  provenTxs: 1
}
function relationSourceQuery(
  k: Knex,
  table: WalletSnapshotTable,
  userId: number,
  relationId: number,
  state: SnapshotIndexState
): Knex.QueryBuilder {
  const { name } = definitions[table]

  const [left, right] = definitions[table].keys
  // The maintenance index begins with the same profile prefix. MySQL can
  // choose it and sort the complete profile before LIMIT; bind paging to the
  // auxiliary primary key whose suffix is the unchanged cursor order.
  const sqliteKeys = state === 'v2' ? 'snapshot_relation_keys_v2' : 'snapshot_relation_keys'
  const relationKeys = String(k.client.config.client).includes('mysql')
    ? k.raw('?? FORCE INDEX (??)', ['snapshot_relation_keys', 'PRIMARY'])
    : sqliteKeys
  const query = k(relationKeys)
    .crossJoin(name, function () {
      void this.on('snapshotLeftId', '=', `${name}.${left}`).andOn('snapshotRightId', '=', `${name}.${right}`)
    })
    .where({ snapshotTableId: relationId, snapshotUserId: userId })
  // Read the recorded membership and keep source lookups indexed even before
  // InnoDB has refreshed cardinality statistics after bootstrap or bulk writes.
  if (String(k.client.config.client).includes('mysql'))
    void query.whereBetween('snapshotMembership', [1, 3]).hintComment(['JOIN_FIXED_ORDER()', `JOIN_INDEX(${name})`])
  return query
}
function certificateSourceQuery(k: Knex, userId: number, state: SnapshotIndexState): Knex.QueryBuilder {
  const name = 'certificate_fields'

  const mysql = String(k.client.config.client).includes('mysql')
  const sqliteKeys = state === 'v2' ? 'snapshot_certificate_field_keys_v2' : 'snapshot_certificate_field_keys'
  const keys = mysql ? k.raw('?? FORCE INDEX (??)', ['snapshot_certificate_field_keys', 'PRIMARY']) : sqliteKeys
  const query = k(keys)
    .crossJoin(name, function () {
      void this.on('snapshotFieldName', '=', `${name}.fieldName`).andOn(
        'snapshotCertificateId',
        '=',
        `${name}.certificateId`
      )
    })
    .where('snapshotUserId', userId)
  if (mysql)
    void query
      .whereBetween('snapshotMembership', [1, 3])
      .hintComment(['JOIN_FIXED_ORDER()', 'JOIN_INDEX(certificate_fields)'])
  return query
}
function globalSourceQuery(
  k: Knex,
  table: WalletSnapshotTable,
  userId: number,
  globalId: number,
  state: SnapshotIndexState
): Knex.QueryBuilder {
  const { name } = definitions[table]

  const mysql = String(k.client.config.client).includes('mysql')
  const sqliteKeys = state === 'v2' ? 'snapshot_global_keys_v2' : 'snapshot_global_keys'
  const keys = mysql ? k.raw('?? FORCE INDEX (??)', ['snapshot_global_keys', 'snapshot_global_page']) : sqliteKeys
  const keyTable = mysql ? 'snapshot_global_keys' : sqliteKeys
  const query = k(keys)
    .crossJoin(name, `${keyTable}.rowId`, `${name}.${definitions[table].keys[0]}`)
    .where({ [`${keyTable}.tableId`]: globalId, [`${keyTable}.userId`]: userId, [`${keyTable}.present`]: 1 })
    .where(`${keyTable}.refs`, '>', 0)
  if (mysql) void query.hintComment(['JOIN_FIXED_ORDER()', `JOIN_INDEX(${name})`])
  return query
}

/** Shared profile selection for local paging and archive closure checks. */
export function walletSnapshotSourceQuery(
  k: Knex,
  table: WalletSnapshotTable,
  userId: number,
  profileIndexes: SnapshotIndexState = false,
  relationIndexes: SnapshotIndexState = false,
  certificateIndexes: SnapshotIndexState = false,
  globalIndexes: SnapshotIndexState = false
): Knex.QueryBuilder {
  const { name } = definitions[table]
  const tableId = auxiliaryTableIds[table]
  if (profileIndexes && tableId !== undefined)
    return k(profileIndexes === 'v2' ? 'snapshot_profile_keys_v2' : 'snapshot_profile_keys')
      .crossJoin(name, 'snapshotRowId', `${name}.${definitions[table].keys[0]}`)
      .where({ snapshotTableId: tableId, snapshotUserId: userId })
      .where(`${name}.userId`, userId)
  const relationId = auxiliaryRelationTableIds[table]
  if (relationIndexes && relationId !== undefined)
    return relationSourceQuery(k, table, userId, relationId, relationIndexes)
  if (certificateIndexes && table === 'certificateFields') return certificateSourceQuery(k, userId, certificateIndexes)
  const globalId = globalTableIds[table]
  if (globalIndexes && globalId !== undefined) return globalSourceQuery(k, table, userId, globalId, globalIndexes)
  const query = k(name)
  if (table === 'provenTxReqs') {
    return query.whereExists(owned(k, 'transactions', 'txid', `${name}.txid`, userId))
  }
  if (table === 'provenTxs') {
    // Include proofs referenced only by a request as well as transaction proofs.
    return query.where(function () {
      void this.whereExists(owned(k, 'transactions', 'provenTxId', `${name}.provenTxId`, userId)).orWhereExists(
        k('proven_tx_reqs')
          .select(k.raw('?', [1]))
          .whereRaw('?? = ??', ['proven_tx_reqs.provenTxId', `${name}.provenTxId`])
          .whereExists(owned(k, 'transactions', 'txid', 'proven_tx_reqs.txid', userId))
      )
    })
  }
  if (table === 'txLabelMaps') {
    return query.where(function () {
      void this.whereExists(owned(k, 'tx_labels', 'txLabelId', `${name}.txLabelId`, userId)).orWhereExists(
        owned(k, 'transactions', 'transactionId', `${name}.transactionId`, userId)
      )
    })
  }
  if (table === 'outputTagMaps') {
    return query.where(function () {
      void this.whereExists(owned(k, 'output_tags', 'outputTagId', `${name}.outputTagId`, userId)).orWhereExists(
        owned(k, 'outputs', 'outputId', `${name}.outputId`, userId)
      )
    })
  }
  if (table === 'certificateFields') {
    return query.where(function () {
      void this.where(`${name}.userId`, userId).orWhereExists(
        owned(k, 'certificates', 'certificateId', `${name}.certificateId`, userId)
      )
    })
  }
  return query.where(`${name}.userId`, userId)
}

function normalize<T>(storage: StorageKnex, row: Record<string, unknown>, schema: TableDefinition): T {
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (value === null) row[key] = undefined
    else if (key === 'created_at' || key === 'updated_at' || schema.dates?.includes(key) === true) {
      row[key] = storage.validateDate(value as Date)
    } else if (schema.booleans?.includes(key) === true) row[key] = value !== 0 && value !== false
    else if (value instanceof Uint8Array) row[key] = new Uint8Array(value)
  }
  return row as T
}

function charge(k: Knex, columns: string[], mysql: boolean, alias = true): Knex.Raw {
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const cellCharge = `2 * coalesce(${length}, 0) + 64`
  return k.raw(
    `(${columns.map(() => cellCharge).join(' + ')})${alias ? ' as ??' : ''}`,
    alias ? [...columns, '__snapshotBytes'] : columns
  )
}

function keyColumn(k: Knex, key: string, mysql: boolean): string | Knex.Raw {
  if (key !== 'fieldName') return key
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  // Preserve all characters, including embedded NUL and astral code points.
  // SQLite substr/length(text) stop at NUL. Bound bytes in SQL before loading
  // this key, then validate its 100-character schema limit in the cursor parser.
  return k.raw(`case when ${length} <= 400 then ?? end as ??`, [key, key, key])
}

function relationGuard(k: Knex, table: WalletSnapshotTable, userId: number): Knex.Raw {
  const name = definitions[table].name
  const relations: Partial<Record<WalletSnapshotTable, Array<[string, string]>>> = {
    txLabelMaps: [
      ['tx_labels', 'txLabelId'],
      ['transactions', 'transactionId']
    ],
    outputTagMaps: [
      ['output_tags', 'outputTagId'],
      ['outputs', 'outputId']
    ],
    certificateFields: [
      ['certificates', 'certificateId'],
      ['users', 'userId']
    ]
  }
  const relation = relations[table]
  if (relation === undefined) return k.raw('1 as ??', ['__snapshotOwned'])
  return k.raw(`(${relation.map(() => 'exists ?').join(' and ')}) as ??`, [
    ...relation.map(([target, id]) => owned(k, target, id, `${name}.${id}`, userId)),
    '__snapshotOwned'
  ])
}

async function columnNames(k: Knex, table: string, mysql: boolean): Promise<string[]> {
  if (!mysql) return Object.keys(await k(table).columnInfo())
  // Knex's columnInfo binds client.config.connection.database, which is absent
  // with an externally supplied mysql2 pool. Inspect this retained connection's
  // actual database instead, with a bounded metadata result.
  const [rows]: Array<Array<{ name: string }>> = await k.raw(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 65',
    [table]
  )
  return rows.map(row => row.name)
}

interface SnapshotContext {
  storage: StorageKnex
  userId: number
  snapshotId: string
  profileIndexes: SnapshotIndexState
  relationIndexes: SnapshotIndexState
  certificateIndexes: SnapshotIndexState
  globalIndexes: SnapshotIndexState
}

/** Select a complete prefix without fetching payloads or skipping oversized rows. */
function boundedPrefix(
  candidates: Array<Record<string, number | string>>,
  maxBytes: number
): { count: number; payloadBytes: number } {
  let payloadBytes = 0
  let count = 0
  for (const candidate of candidates) {
    if (candidate.__snapshotBytes == null) throw new WERR_INVALID_OPERATION('Snapshot logical row allocation differs')
    if (Number(candidate.__snapshotOwned) !== 1) {
      throw new WERR_INVALID_OPERATION('Snapshot relation does not belong to this wallet profile')
    }
    const bytes = Number(candidate.__snapshotBytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WERR_INVALID_OPERATION('Invalid snapshot row size')
    if (payloadBytes + bytes > maxBytes) {
      if (count === 0)
        throw new SnapshotResourceLimitError('Snapshot row exceeds maxBytes; large-value streaming is required')
      break
    }
    payloadBytes += bytes
    count++
  }
  return { count, payloadBytes }
}

async function readPage<T extends WalletSnapshotTable>(
  context: SnapshotContext,
  trx: TrxToken,
  table: T,
  after: Array<number | string> | undefined,
  limits: { maxRows: number; maxBytes: number }
): Promise<WalletSnapshotPage<T>> {
  const { storage, userId, snapshotId, profileIndexes, relationIndexes, certificateIndexes, globalIndexes } = context
  const k = storage.toDb(trx)
  const schema = definitions[table]
  const fields = await columnNames(k, schema.name, storage.dbtype === 'MySQL')
  if (fields.length === 0 || fields.length > 64) throw new WERR_INVALID_OPERATION('Unsupported snapshot schema')
  let orderKeys = schema.keys
  if (profileIndexes && auxiliaryTableIds[table] !== undefined) orderKeys = ['snapshotRowId']
  if (relationIndexes && auxiliaryRelationTableIds[table] !== undefined)
    orderKeys = ['snapshotLeftId', 'snapshotRightId']
  if (certificateIndexes && table === 'certificateFields') orderKeys = ['snapshotFieldName', 'snapshotCertificateId']
  if (globalIndexes && (table === 'provenTxs' || table === 'provenTxReqs')) orderKeys = ['rowId']
  const base = (): Knex.QueryBuilder => {
    const q = walletSnapshotSourceQuery(
      k,
      table,
      userId,
      profileIndexes,
      relationIndexes,
      certificateIndexes,
      globalIndexes
    )
    if (after !== undefined) seek(q, orderKeys, after, false, storage.dbtype === 'MySQL')
    for (const key of orderKeys) void q.orderBy(key)
    return q
  }
  const keyColumns = schema.keys.map(key => keyColumn(k, key, storage.dbtype === 'MySQL')),
    packed = isBrc38NativeBinaryReadTransaction(k) && (await hasBrc38NativePackedSchema(k)),
    text =
      isBrc38NativePackedTextWalletTable(schema.name) &&
      isBrc38NativeBinaryReadTransaction(k) &&
      (await hasBrc38NativePackedTextSchema(k as Knex.Transaction)),
    baseCharge =
      packed && binaryColumns[table] !== undefined
        ? brc38NativePackedWalletRowCharge(k, schema.name as Brc38NativePackedWalletTable, fields, 2, 64)
        : charge(k, fields, storage.dbtype === 'MySQL', false),
    chargeExpression = k.raw('? AS __snapshotBytes', [
      text
        ? brc38NativePackedTextWalletRowCharge(
            k as Knex.Transaction,
            schema.name as Brc38NativePackedTextWalletTable,
            fields,
            baseCharge
          )
        : baseCharge
    ])
  // Only bounded keys and lengths cross the driver boundary in this pass. A
  // giant blob/history must not be loaded merely to discover it exceeds budget.
  const candidates: Array<Record<string, number | string>> = await base()
    .select(...keyColumns, chargeExpression, relationGuard(k, table, userId))
    .limit(limits.maxRows)
  const { count, payloadBytes } = boundedPrefix(candidates, limits.maxBytes)
  const last = candidates[count - 1]
  const cursor: WalletSnapshotCursor | undefined =
    last === undefined ? undefined : { version: 1, snapshotId, table, after: schema.keys.map(key => last[key]) }
  // Validate database keys too, including SQLite strings without enforced SQL length.
  const end = position(cursor, snapshotId, table, schema.keys)
  let rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
  if (end !== undefined) {
    const query = base().select(`${schema.name}.*`).limit(count)
    seek(query, orderKeys, end, true, storage.dbtype === 'MySQL')
    const raw: Array<Record<string, unknown>> = await query
    if (text) await prechargeBrc38NativePackedTextWalletRows(k, schema.name as Brc38NativePackedTextWalletTable, raw)
    if (packed && binaryColumns[table] !== undefined)
      await hydrateBrc38NativePackedWalletRows(k, schema.name as Brc38NativePackedWalletTable, raw)
    if (text) await hydrateBrc38NativePackedTextWalletRows(k, schema.name as Brc38NativePackedTextWalletTable, raw)
    rows = raw.map(row => normalize(storage, row, schema))
  }
  return {
    rows,
    payloadBytes,
    cursor,
    done: count === candidates.length && candidates.length < limits.maxRows
  }
}

// Keep the existing optional positional call contract while grouping the four
// index-generation selections captured by the same retained view.
type SnapshotIndexFlags = [
  profileIndexes?: SnapshotIndexState,
  relationIndexes?: SnapshotIndexState,
  certificateIndexes?: SnapshotIndexState,
  globalIndexes?: SnapshotIndexState
]

const binaryColumns: Partial<Record<WalletSnapshotTable, readonly WalletSnapshotBinaryColumn[]>> = {
  provenTxs: ['rawTx', 'merklePath'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
}
function metadataQuery(
  context: SnapshotContext,
  k: Knex,
  table: WalletSnapshotTable,
  after?: Array<number | string>
): Knex.QueryBuilder {
  const { userId, profileIndexes, relationIndexes, certificateIndexes, globalIndexes } = context
  let keys = definitions[table].keys
  if (profileIndexes && auxiliaryTableIds[table] !== undefined) keys = ['snapshotRowId']
  if (relationIndexes && auxiliaryRelationTableIds[table] !== undefined) keys = ['snapshotLeftId', 'snapshotRightId']
  if (certificateIndexes && table === 'certificateFields') keys = ['snapshotFieldName', 'snapshotCertificateId']
  if (globalIndexes && (table === 'provenTxs' || table === 'provenTxReqs')) keys = ['rowId']
  const query = walletSnapshotSourceQuery(
    k,
    table,
    userId,
    profileIndexes,
    relationIndexes,
    certificateIndexes,
    globalIndexes
  )
  if (after !== undefined) seek(query, keys, after, false, context.storage.dbtype === 'MySQL')
  for (const field of keys) void query.orderBy(field)
  return query
}

const structuredColumns: Partial<Record<WalletSnapshotTable, readonly Brc38NativeTextRead['field'][]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther'],
  transactions: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix'],
  outputs: [
    'outputDescription',
    'spendingDescription',
    'customInstructions',
    'derivationPrefix',
    'derivationSuffix',
    'type',
    'purpose'
  ],
  commissions: ['keyOffset'],
  certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
  certificateFields: ['fieldValue', 'masterKey']
}

/** Same actual retained native view, with no full BLOB or structured TEXT
 * crossing the driver merely to discover its size. Advertised only by the
 * original native view factory; every call still checks actual membership.
 * Raw cells have no advertised digest. A caller-supplied digest cannot replace
 * a source read or make the source claim a hash it has not computed. */
export function createKnexWalletSnapshotFieldReader(
  storage: StorageKnex,
  userId: number,
  snapshotId: string,
  view: RetainedReadSnapshot,
  ...[
    profileIndexes = false,
    relationIndexes = false,
    certificateIndexes = false,
    globalIndexes = false
  ]: SnapshotIndexFlags
): WalletSnapshotFieldReader {
  const context: SnapshotContext = {
    storage,
    userId,
    snapshotId,
    profileIndexes,
    relationIndexes,
    certificateIndexes,
    globalIndexes
  }
  return observeWalletSnapshotFieldReader({
    async readMetadataPage<T extends WalletSnapshotTable>(
      table: T,
      cursor?: WalletSnapshotCursor,
      limits: WalletSnapshotPageLimits = {}
    ): Promise<WalletSnapshotFieldMetadataPage<T>> {
      const schema = definition(table),
        after = position(cursor, snapshotId, table, schema.keys),
        maxRows = bound(limits.maxRows, 128, 1000, 'maxRows'),
        maxBytes = bound(limits.maxBytes, 262144, 16777216, 'maxBytes')
      return await view.read(async token => {
        const k = storage.toDb(token)
        if (!isBrc38NativeBinaryReadTransaction(k))
          throw new WERR_INVALID_OPERATION('Actual native field snapshot required')
        const fields = await columnNames(k, schema.name, false)
        if (
          fields.length < 1 ||
          fields.length > 64 ||
          fields.some(field => field.startsWith('__snapshot_field_')) ||
          schema.keys.some(field => !fields.includes(field))
        )
          throw new WERR_INVALID_OPERATION('Unsupported field snapshot schema')
        const binaries = (binaryColumns[table] ?? []).filter(field => fields.includes(field)),
          texts = (structuredColumns[table] ?? []).filter(field => fields.includes(field)),
          large: readonly string[] = [...binaries, ...texts],
          metadata = fields.filter(field => !large.includes(field)),
          packedBinary = binaries.length !== 0 && (await hasBrc38NativePackedSchema(k)),
          packedText = texts.length !== 0 && (await hasBrc38NativePackedTextSchema(k))
        if (texts.length !== 0 && !packedText) {
          const protocol = (await k.raw('SELECT brc38_text_read_protocol() AS abi')) as Array<{ abi: number }>
          if (
            protocol.length !== 1 ||
            !brc38NativeTextProtocolSupports(table as Brc38NativeTextRead['table'], protocol[0].abi)
          )
            throw new WERR_INVALID_OPERATION('Native TEXT protocol differs')
        }
        const candidates: Array<Record<string, number | string>> = await metadataQuery(context, k, table, after)
          .select(
            ...schema.keys.map(field => keyColumn(k, field, false)),
            k.raw('? + ? AS __snapshotBytes', [charge(k, metadata, false, false), 256 * large.length]),
            relationGuard(k, table, userId)
          )
          .limit(maxRows)
        const { count, payloadBytes } = boundedPrefix(candidates, maxBytes),
          result: Array<WalletSnapshotFieldMetadataRow<T>> = []
        if (count !== 0) {
          const lengths = large.map((field, index) => {
            let expression: Knex.Raw
            if (binaries.includes(field as WalletSnapshotBinaryColumn))
              expression = packedBinary
                ? brc38NativePackedLength(k, {
                    table: table as Brc38NativeBlobRead['table'],
                    field: field as Brc38NativeBlobRead['field']
                  })
                : k.raw('length(??)', [`${schema.name}.${field}`])
            else if (packedText)
              expression = brc38NativePackedTextLength(k, {
                table: table as Brc38NativeTextRead['table'],
                field: field as Brc38NativeTextRead['field']
              })
            else {
              const coordinate = brc38NativeTextCoordinate(
                table as Brc38NativeTextRead['table'],
                field as Brc38NativeTextRead['field']
              )
              expression = k.raw('brc38_text_extent_bytes(?,?,??.rowid)', [coordinate[0], coordinate[1], schema.name])
            }
            return k.raw('? AS ??', [expression, `__snapshot_field_${index}`])
          })
          const rows = (await metadataQuery(context, k, table, after)
            .select(...metadata.map(field => `${schema.name}.${field}`), ...lengths)
            .limit(count)) as Array<Record<string, unknown>>
          if (rows.length !== count) throw new WERR_INVALID_OPERATION('Native field metadata prefix changed')
          for (const [index, row] of rows.entries()) {
            if (schema.keys.some(field => row[field] !== candidates[index][field]))
              throw new WERR_INVALID_OPERATION('Native field metadata keys differ from preflight')
            const extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = Object.create(null)
            for (const [ordinal, field] of large.entries()) {
              const name = `__snapshot_field_${ordinal}`,
                selected = row[name]
              delete row[name]
              if (selected === null) {
                row[field] = undefined
                continue
              }
              const bytes = typeof selected === 'number' || typeof selected === 'string' ? Number(selected) : NaN
              if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1000000000)
                throw new WERR_INVALID_OPERATION('Native field logical length differs')
              extents[field] = Object.freeze<WalletSnapshotFieldDescriptor>({
                kind: binaries.includes(field as WalletSnapshotBinaryColumn) ? 'binary' : 'utf8',
                bytes
              })
            }
            const positionValue: WalletSnapshotCursor = {
              version: 1,
              snapshotId,
              table,
              after: schema.keys.map(field => candidates[index][field])
            }
            position(positionValue, snapshotId, table, schema.keys)
            result.push({
              fields: normalize(storage, row, schema),
              extents: Object.freeze(extents),
              cursor: positionValue
            })
          }
        }
        return {
          rows: result,
          payloadBytes,
          done: count === candidates.length && candidates.length < maxRows,
          ...(result.length === 0
            ? {}
            : { cursor: { ...result[result.length - 1].cursor, after: [...result[result.length - 1].cursor.after] } })
        }
      })
    },
    async readFieldExtent(table, cursor, field, offset, length, selectedExpected) {
      const schema = definition(table),
        sourceKey = position(cursor, snapshotId, table, schema.keys),
        expected = Object.freeze({
          kind: selectedExpected.kind,
          bytes: selectedExpected.bytes,
          sha256: selectedExpected.sha256
        }),
        binary = (binaryColumns[table] ?? []).includes(field as WalletSnapshotBinaryColumn),
        text = (structuredColumns[table] ?? []).includes(field as Brc38NativeTextRead['field'])
      if (
        sourceKey === undefined ||
        (!binary && !text) ||
        expected.kind !== (binary ? 'binary' : 'utf8') ||
        expected.sha256 !== undefined ||
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes < 0 ||
        expected.bytes > 1000000000 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 65536 ||
        offset > expected.bytes - length
      )
        throw new WERR_INVALID_PARAMETER('extent', 'an exact native field extent from this view')
      return await view.read(async token => {
        const k = storage.toDb(token)
        if (!isBrc38NativeBinaryReadTransaction(k))
          throw new WERR_INVALID_OPERATION('Actual native field snapshot required')
        const query = walletSnapshotSourceQuery(
          k,
          table,
          userId,
          profileIndexes,
          relationIndexes,
          certificateIndexes,
          globalIndexes
        )
        for (const [index, key] of schema.keys.entries()) void query.where(`${schema.name}.${key}`, sourceKey[index])
        const packed = binary && (await hasBrc38NativePackedSchema(k)),
          logicalBytes = packed
            ? brc38NativePackedLength(k, {
                table: table as Brc38NativeBlobRead['table'],
                field: field as Brc38NativeBlobRead['field']
              })
            : k.raw('length(??)', [`${schema.name}.${field}`]),
          rows = (await query
            .select(
              k.raw('??.rowid AS __nativeRowId,typeof(??) AS storedKind', [schema.name, `${schema.name}.${field}`]),
              ...(binary ? [k.raw('? AS storedLength', [logicalBytes])] : []),
              relationGuard(k, table, userId)
            )
            .limit(2)) as Array<{
            __nativeRowId: number
            storedKind: string
            storedLength?: unknown
            __snapshotOwned: unknown
          }>,
          row = rows[0]
        if (
          rows.length !== 1 ||
          row === undefined ||
          Number(row.__snapshotOwned) !== 1 ||
          row.storedKind !== (binary ? 'blob' : 'text')
        )
          throw new WERR_INVALID_OPERATION('Actual native field coordinate differs')
        if (binary) {
          if (
            (typeof row.storedLength !== 'number' && typeof row.storedLength !== 'string') ||
            Number(row.storedLength) !== expected.bytes
          )
            throw new WERR_INVALID_OPERATION('Actual native binary length differs')
          if (length === 0) return new Uint8Array(0)
          return await readBrc38NativeBinaryExtent(k, {
            table: table as Brc38NativeBlobRead['table'],
            field: field as Brc38NativeBlobRead['field'],
            rowId: row.__nativeRowId,
            offset,
            totalBytes: expected.bytes,
            length
          })
        }
        const input = {
          table: table as Brc38NativeTextRead['table'],
          field: field as Brc38NativeTextRead['field'],
          rowId: row.__nativeRowId
        }
        if ((await readBrc38NativeTextBytes(k, input)) !== expected.bytes)
          throw new WERR_INVALID_OPERATION('Actual native TEXT length differs')
        if (length === 0) return new Uint8Array(0)
        return await readBrc38NativeTextExtent(k, { ...input, offset, totalBytes: expected.bytes, length })
      })
    }
  })
}

/** Native metadata/extent adapter over the SAME owned retained transaction as
 * ordinary pages. Metadata is charged in SQL before loading; raw blobs cross
 * the driver only as exact bounded slices. A cursor/length never authorizes a
 * different source/profile. Storage-key ordering stays explicitly separate
 * from canonical archive-array sorting. No remote capability is advertised. */
export function createKnexWalletSnapshotBinaryReader(
  storage: StorageKnex,
  userId: number,
  snapshotId: string,
  view: RetainedReadSnapshot,
  ...[
    profileIndexes = false,
    relationIndexes = false,
    certificateIndexes = false,
    globalIndexes = false
  ]: SnapshotIndexFlags
): WalletSnapshotBinaryReader {
  const context: SnapshotContext = {
    storage,
    userId,
    snapshotId,
    profileIndexes,
    relationIndexes,
    certificateIndexes,
    globalIndexes
  }
  return {
    async readMetadataPage<T extends WalletSnapshotTable>(
      table: T,
      cursor?: WalletSnapshotCursor,
      limits: WalletSnapshotPageLimits = {}
    ): Promise<WalletSnapshotMetadataPage<T>> {
      const schema = definition(table),
        after = position(cursor, snapshotId, table, schema.keys)
      const maxRows = bound(limits.maxRows, 128, 1000, 'maxRows'),
        maxBytes = bound(limits.maxBytes, 262144, 16777216, 'maxBytes')
      return await view.read(async token => {
        const k = storage.toDb(token),
          mysql = storage.dbtype === 'MySQL'
        // Fresh column inventory in this call, never a schema/authority verdict
        // retained for another operation or generation.
        const fields = await columnNames(k, schema.name, mysql)
        if (
          fields.length < 1 ||
          fields.length > 64 ||
          fields.some(field => field.startsWith('__snapshot_binary_')) ||
          schema.keys.some(field => !fields.includes(field))
        )
          throw new WERR_INVALID_OPERATION('Unsupported snapshot schema')
        const binaries = (binaryColumns[table] ?? []).filter(field => fields.includes(field))
        const packed = isBrc38NativeBinaryReadTransaction(k) && (await hasBrc38NativePackedSchema(k))
        const metadata = fields.filter(field => !binaries.includes(field as WalletSnapshotBinaryColumn)),
          text =
            isBrc38NativePackedTextWalletTable(schema.name) &&
            isBrc38NativeBinaryReadTransaction(k) &&
            (await hasBrc38NativePackedTextSchema(k as Knex.Transaction)),
          baseCharge = charge(k, metadata, mysql, false),
          rowCharge = text
            ? brc38NativePackedTextWalletRowCharge(
                k as Knex.Transaction,
                schema.name as Brc38NativePackedTextWalletTable,
                metadata,
                baseCharge
              )
            : baseCharge
        const candidates: Array<Record<string, number | string>> = await metadataQuery(context, k, table, after)
          .select(
            ...schema.keys.map(field => keyColumn(k, field, mysql)),
            k.raw('? AS __snapshotBytes', [rowCharge]),
            relationGuard(k, table, userId)
          )
          .limit(maxRows)
        for (const row of candidates) {
          if (row.__snapshotBytes == null) throw new WERR_INVALID_OPERATION('Snapshot logical row allocation differs')
          row.__snapshotBytes = Number(row.__snapshotBytes) + 256 * binaries.length
        }
        const { count, payloadBytes } = boundedPrefix(candidates, maxBytes)
        const result: Array<WalletSnapshotMetadataRow<T>> = []
        if (count !== 0) {
          const rows: Array<Record<string, unknown>> = await metadataQuery(context, k, table, after)
            .select(
              ...metadata.map(field => `${schema.name}.${field}`),
              ...binaries.map((field, index) =>
                packed
                  ? k.raw('? AS ??', [
                      brc38NativePackedLength(k as Knex.Transaction, {
                        table: table as Brc38NativeBlobRead['table'],
                        field: field as Brc38NativeBlobRead['field']
                      }),
                      `__snapshot_binary_${index}`
                    ])
                  : k.raw(`${mysql ? 'octet_length(??)' : 'length(??)'} AS ??`, [
                      `${schema.name}.${field}`,
                      `__snapshot_binary_${index}`
                    ])
              )
            )
            .limit(count)
          if (rows.length !== count) throw new WERR_INVALID_OPERATION('Snapshot metadata prefix changed')
          if (text)
            await hydrateBrc38NativePackedTextWalletRows(k, schema.name as Brc38NativePackedTextWalletTable, rows)
          for (const [index, row] of rows.entries()) {
            if (schema.keys.some(field => row[field] !== candidates[index][field]))
              throw new WERR_INVALID_OPERATION('Snapshot metadata keys differ from their preflight')
            const lengths: Partial<Record<WalletSnapshotBinaryColumn, number>> = {}
            for (const [column, field] of binaries.entries()) {
              const name = `__snapshot_binary_${column}`,
                value = row[name]
              delete row[name]
              if (value === null) continue
              const length = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
              if (!Number.isSafeInteger(length) || length < 0)
                throw new WERR_INVALID_OPERATION('Snapshot binary length is invalid')
              lengths[field] = length
            }
            const positionValue: WalletSnapshotCursor = {
              version: 1,
              snapshotId,
              table,
              after: schema.keys.map(field => candidates[index][field])
            }
            position(positionValue, snapshotId, table, schema.keys)
            result.push({ fields: normalize(storage, row, schema), binaries: lengths, cursor: positionValue })
          }
        }
        return {
          rows: result,
          payloadBytes,
          done: count === candidates.length && candidates.length < maxRows,
          ...(result.length === 0
            ? {}
            : { cursor: { ...result[result.length - 1].cursor, after: [...result[result.length - 1].cursor.after] } })
        }
      })
    },
    async readBinaryCell(table, cursor, column, offset, length, expectedLength) {
      const schema = definition(table),
        sourceKey = position(cursor, snapshotId, table, schema.keys)
      if (
        sourceKey === undefined ||
        !(binaryColumns[table] ?? []).includes(column) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 65536 ||
        !Number.isSafeInteger(expectedLength) ||
        expectedLength < 0 ||
        offset > expectedLength - length
      )
        throw new WERR_INVALID_PARAMETER('extent', 'an exact bounded binary cell extent in this source view')
      return await view.read(async token => {
        const k = storage.toDb(token),
          mysql = storage.dbtype === 'MySQL'
        const query = walletSnapshotSourceQuery(
          k,
          table,
          userId,
          profileIndexes,
          relationIndexes,
          certificateIndexes,
          globalIndexes
        )
        for (const [index, field] of schema.keys.entries())
          void query.where(`${schema.name}.${field}`, sourceKey[index])
        if (isBrc38NativeBinaryReadTransaction(k)) {
          // Preserve actual profile/key/relationship and length checks before
          // opening the incremental handle on this same retained native view.
          const packed = await hasBrc38NativePackedSchema(k),
            actualLength = packed
              ? brc38NativePackedLength(k, {
                  table: table as Brc38NativeBlobRead['table'],
                  field: column as Brc38NativeBlobRead['field']
                })
              : k.raw('length(??)', [`${schema.name}.${column}`])
          const rows = (await query
            .select(
              k.raw('??.rowid AS __nativeRowId', [schema.name]),
              k.raw('? AS storedLength,typeof(??) AS storedKind', [actualLength, `${schema.name}.${column}`]),
              relationGuard(k, table, userId)
            )
            .limit(2)) as Array<{
            __nativeRowId: number
            storedLength: unknown
            storedKind: string
            __snapshotOwned: unknown
          }>
          const row = rows[0]
          if (
            rows.length !== 1 ||
            row === undefined ||
            Number(row.__snapshotOwned) !== 1 ||
            (typeof row.storedLength !== 'number' && typeof row.storedLength !== 'string') ||
            Number(row.storedLength) !== expectedLength ||
            row.storedKind !== 'blob'
          )
            throw new WERR_INVALID_OPERATION('Native snapshot binary extent differs from its actual cell')
          if (length === 0) return new Uint8Array(0)
          return await readBrc38NativeBinaryExtent(k, {
            table: table as Brc38NativeBlobRead['table'],
            field: column as Brc38NativeBlobRead['field'],
            rowId: row.__nativeRowId,
            offset,
            totalBytes: expectedLength,
            length
          })
        }
        const rows: Array<{ bytes: unknown; storedLength: unknown; __snapshotOwned: unknown }> = await query
          .select(
            k.raw('substr(??,?,?) AS bytes', [`${schema.name}.${column}`, offset + 1, length]),
            k.raw(`${mysql ? 'octet_length(??)' : 'length(??)'} AS storedLength`, [`${schema.name}.${column}`]),
            relationGuard(k, table, userId)
          )
          .limit(2)
        const row = rows[0]
        if (
          rows.length !== 1 ||
          row === undefined ||
          Number(row.__snapshotOwned) !== 1 ||
          row.storedLength === null ||
          (typeof row.storedLength !== 'string' && typeof row.storedLength !== 'number') ||
          Number(row.storedLength) !== expectedLength ||
          !(row.bytes instanceof Uint8Array)
        )
          throw new WERR_INVALID_OPERATION('Snapshot binary extent differs from its actual cell')
        const bytes = detachBrc38PrivateChunk(row.bytes, length)
        if (bytes.byteLength !== length) throw new WERR_INVALID_OPERATION('Snapshot binary extent was truncated')
        return bytes
      })
    }
  }
}

/** Bind every page to one provider-owned view and immutable profile identifiers. */
export function createKnexWalletSnapshotPageReader(
  storage: StorageKnex,
  userId: number,
  snapshotId: string,
  view: RetainedReadSnapshot,
  ...[
    profileIndexes = false,
    relationIndexes = false,
    certificateIndexes = false,
    globalIndexes = false
  ]: SnapshotIndexFlags
): WalletReadSnapshot['readPage'] {
  const context: SnapshotContext = {
    storage,
    userId,
    snapshotId,
    profileIndexes,
    relationIndexes,
    certificateIndexes,
    globalIndexes
  }
  return async <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits: WalletSnapshotPageLimits = {}
  ): Promise<WalletSnapshotPage<T>> => {
    const schema = definition(table)
    const after = position(cursor, snapshotId, table, schema.keys)
    const maxRows = bound(limits.maxRows, 128, 1000, 'maxRows')
    const maxBytes = bound(limits.maxBytes, 262144, 16777216, 'maxBytes')
    return await view.read(trx => readPage(context, trx, table, after, { maxRows, maxBytes }))
  }
}

/** SQL implementation, deliberately separate from legacy OFFSET sync and public RPC. */
export async function openKnexWalletReadSnapshot(
  storage: StorageKnex,
  identityKey: string,
  options: WalletReadSnapshotOptions
): Promise<WalletReadSnapshot> {
  if (typeof identityKey !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey)) {
    throw new WERR_INVALID_PARAMETER('identityKey', 'a compressed public identity key')
  }
  const view = await storage.openReadSnapshot(options)
  try {
    const { header, profileIndexes, relationIndexes, certificateIndexes, globalIndexes, nativeFields } =
      await view.read(async trx => {
        const generation = await readGenerationIndexState(storage.toDb(trx), storage.knex.client.config.migrations)
        const sourceStorage = await storage.readSettings(trx)
        const user = await storage.findUserByIdentityKey(identityKey, trx)
        if (user === undefined) throw new WERR_INVALID_PARAMETER('identityKey', 'an existing wallet profile')
        return {
          header: { sourceStorage, user },
          // Genuine original view membership selects this additive interface;
          // each operation repeats the actual membership/schema checks.
          nativeFields: isBrc38NativeBinaryReadTransaction(storage.toDb(trx)),
          profileIndexes:
            generation ??
            (await readSnapshotProfileIndexState(storage.toDb(trx), storage.knex.client.config.migrations)),
          relationIndexes:
            generation ??
            (await readSnapshotRelationIndexState(storage.toDb(trx), storage.knex.client.config.migrations)),
          globalIndexes:
            generation ??
            (await readSnapshotGlobalIndexState(storage.toDb(trx), storage.knex.client.config.migrations)),
          certificateIndexes:
            generation ??
            (await readSnapshotCertificateIndexState(storage.toDb(trx), storage.knex.client.config.migrations))
        }
      })
    const userId = header.user.userId
    const snapshotId = Utils.toHex(Random(32))
    return {
      version: 1,
      snapshotId,
      ...header,
      expiresAt: view.expiresAt,
      get isOpen() {
        return view.isOpen
      },
      closed: view.closed,
      close: view.close,
      binaryReader: createKnexWalletSnapshotBinaryReader(
        storage,
        userId,
        snapshotId,
        view,
        profileIndexes,
        relationIndexes,
        certificateIndexes,
        globalIndexes
      ),
      ...(nativeFields
        ? {
            fieldReader: createKnexWalletSnapshotFieldReader(
              storage,
              userId,
              snapshotId,
              view,
              profileIndexes,
              relationIndexes,
              certificateIndexes,
              globalIndexes
            )
          }
        : {}),
      readPage: createKnexWalletSnapshotPageReader(
        storage,
        userId,
        snapshotId,
        view,
        profileIndexes,
        relationIndexes,
        certificateIndexes,
        globalIndexes
      )
    }
  } catch (error) {
    // Keep the opening error authoritative while still awaiting physical cleanup.
    await view.close().catch(() => undefined)
    throw error
  }
}
