import { readSnapshotRelationIndexState } from '../schema/snapshotRelationIndexMigration'
import { readSnapshotProfileIndexState } from '../schema/snapshotProfileIndexMigration'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { RetainedReadSnapshot } from './RetainedReadSnapshot'
import type {
  PackedSnapshotRow,
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotPage,
  WalletSnapshotPageLimits,
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
  provenTxReqs: { name: 'proven_tx_reqs', keys: ['provenTxReqId'], booleans: ['notified', 'wasBroadcast'] },
  outputBaskets: { name: 'output_baskets', keys: ['basketId'], booleans: ['isDeleted'] },
  transactions: { name: 'transactions', keys: ['transactionId'], booleans: ['isOutgoing'] },
  commissions: { name: 'commissions', keys: ['commissionId'], booleans: ['isRedeemed'] },
  outputs: { name: 'outputs', keys: ['outputId'], booleans: ['spendable', 'change'] },
  outputTags: { name: 'output_tags', keys: ['outputTagId'], booleans: ['isDeleted'] },
  outputTagMaps: { name: 'output_tags_map', keys: ['outputTagId', 'outputId'], booleans: ['isDeleted'] },
  txLabels: { name: 'tx_labels', keys: ['txLabelId'], booleans: ['isDeleted'] },
  txLabelMaps: { name: 'tx_labels_map', keys: ['txLabelId', 'transactionId'], booleans: ['isDeleted'] },
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

const auxiliaryRelationTableIds: Partial<Record<WalletSnapshotTable, number>> = { txLabelMaps: 0, outputTagMaps: 1 }

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

/** Shared profile selection for local paging and archive closure checks. */
export function walletSnapshotSourceQuery(
  k: Knex,
  table: WalletSnapshotTable,
  userId: number,
  profileIndexes = false,
  relationIndexes = false
): Knex.QueryBuilder {
  const { name } = definitions[table]
  const tableId = auxiliaryTableIds[table]
  if (profileIndexes && tableId !== undefined)
    return k('snapshot_profile_keys')
      .crossJoin(name, 'snapshotRowId', `${name}.${definitions[table].keys[0]}`)
      .where({ snapshotTableId: tableId, snapshotUserId: userId })
      .where(`${name}.userId`, userId)
  const relationId = auxiliaryRelationTableIds[table]
  if (relationIndexes && relationId !== undefined) {
    const [left, right] = definitions[table].keys
    // The maintenance index begins with the same profile prefix. MySQL can
    // choose it and sort the complete profile before LIMIT; bind paging to the
    // auxiliary primary key whose suffix is the unchanged cursor order.
    const relationKeys = String(k.client.config.client).includes('mysql')
      ? k.raw('?? FORCE INDEX (??)', ['snapshot_relation_keys', 'PRIMARY'])
      : 'snapshot_relation_keys'
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

function charge(k: Knex, columns: string[], mysql: boolean): Knex.Raw {
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const cellCharge = `2 * coalesce(${length}, 0) + 64`
  return k.raw(`(${columns.map(() => cellCharge).join(' + ')}) as ??`, [...columns, '__snapshotBytes'])
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
  profileIndexes: boolean
  relationIndexes: boolean
  columns: Map<WalletSnapshotTable, string[]>
}

/** Select a complete prefix without fetching payloads or skipping oversized rows. */
function boundedPrefix(
  candidates: Array<Record<string, number | string>>,
  maxBytes: number
): { count: number; payloadBytes: number } {
  let payloadBytes = 0
  let count = 0
  for (const candidate of candidates) {
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
  const { storage, userId, columns, snapshotId, profileIndexes, relationIndexes } = context
  const k = storage.toDb(trx)
  const schema = definitions[table]
  let fields = columns.get(table)
  if (fields === undefined) {
    fields = await columnNames(k, schema.name, storage.dbtype === 'MySQL')
    if (fields.length === 0 || fields.length > 64) throw new WERR_INVALID_OPERATION('Unsupported snapshot schema')
    columns.set(table, fields)
  }
  let orderKeys = schema.keys
  if (profileIndexes && auxiliaryTableIds[table] !== undefined) orderKeys = ['snapshotRowId']
  if (relationIndexes && auxiliaryRelationTableIds[table] !== undefined)
    orderKeys = ['snapshotLeftId', 'snapshotRightId']
  const base = (): Knex.QueryBuilder => {
    const q = walletSnapshotSourceQuery(k, table, userId, profileIndexes, relationIndexes)
    if (after !== undefined) seek(q, orderKeys, after, false, storage.dbtype === 'MySQL')
    for (const key of orderKeys) void q.orderBy(key)
    return q
  }
  const keyColumns = schema.keys.map(key => keyColumn(k, key, storage.dbtype === 'MySQL'))
  // Only bounded keys and lengths cross the driver boundary in this pass. A
  // giant blob/history must not be loaded merely to discover it exceeds budget.
  const candidates: Array<Record<string, number | string>> = await base()
    .select(...keyColumns, charge(k, fields, storage.dbtype === 'MySQL'), relationGuard(k, table, userId))
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
    rows = raw.map(row => normalize(storage, row, schema))
  }
  return { rows, payloadBytes, cursor, done: count === candidates.length && candidates.length < limits.maxRows }
}

/** Bind every page to one provider-owned view and immutable profile identifiers. */
export function createKnexWalletSnapshotPageReader(
  storage: StorageKnex,
  userId: number,
  snapshotId: string,
  view: RetainedReadSnapshot,
  profileIndexes = false,
  relationIndexes = false
): WalletReadSnapshot['readPage'] {
  const context: SnapshotContext = { storage, userId, snapshotId, profileIndexes, relationIndexes, columns: new Map() }
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
    const { header, profileIndexes, relationIndexes } = await view.read(async trx => {
      const sourceStorage = await storage.readSettings(trx)
      const user = await storage.findUserByIdentityKey(identityKey, trx)
      if (user === undefined) throw new WERR_INVALID_PARAMETER('identityKey', 'an existing wallet profile')
      return {
        header: { sourceStorage, user },
        profileIndexes: await readSnapshotProfileIndexState(storage.toDb(trx), storage.knex.client.config.migrations),
        relationIndexes: await readSnapshotRelationIndexState(storage.toDb(trx), storage.knex.client.config.migrations)
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
      readPage: createKnexWalletSnapshotPageReader(storage, userId, snapshotId, view, profileIndexes, relationIndexes)
    }
  } catch (error) {
    // Keep the opening error authoritative while still awaiting physical cleanup.
    await view.close().catch(() => undefined)
    throw error
  }
}
