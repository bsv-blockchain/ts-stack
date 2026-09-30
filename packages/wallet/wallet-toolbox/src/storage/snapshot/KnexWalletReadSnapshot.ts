import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
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

// Use existing unique keys. This additive path does not add indexes or change
// traversal order for legacy OFFSET checkpoints. Map/field order is explicitly
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
    cursor === null ||
    cursor.version !== 1 ||
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
function seek(query: Knex.QueryBuilder, keys: string[], after: Array<number | string>, inclusive = false): void {
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

function scopedQuery(k: Knex, table: WalletSnapshotTable, userId: number): Knex.QueryBuilder {
  const { name } = definitions[table]
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
  return k.raw(`(${columns.map(() => `2 * coalesce(${length}, 0) + 64`).join(' + ')}) as ??`, [
    ...columns,
    '__snapshotBytes'
  ])
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

async function readPage<T extends WalletSnapshotTable>(
  storage: StorageKnex,
  trx: TrxToken,
  userId: number,
  table: T,
  after: Array<number | string> | undefined,
  limits: { maxRows: number; maxBytes: number },
  columns: Map<WalletSnapshotTable, string[]>,
  snapshotId: string
): Promise<WalletSnapshotPage<T>> {
  const k = storage.toDb(trx)
  const schema = definitions[table]
  let fields = columns.get(table)
  if (fields === undefined) {
    fields = await columnNames(k, schema.name, storage.dbtype === 'MySQL')
    if (fields.length === 0 || fields.length > 64) throw new WERR_INVALID_OPERATION('Unsupported snapshot schema')
    columns.set(table, fields)
  }
  const base = (): Knex.QueryBuilder => {
    const q = scopedQuery(k, table, userId)
    if (after !== undefined) seek(q, schema.keys, after)
    for (const key of schema.keys) void q.orderBy(key)
    return q
  }
  const keyColumns = schema.keys.map(key => keyColumn(k, key, storage.dbtype === 'MySQL'))
  // Only bounded keys and lengths cross the driver boundary in this pass. A
  // giant blob/history must not be loaded merely to discover it exceeds budget.
  const candidates: Array<Record<string, number | string>> = await base()
    .select(...keyColumns, charge(k, fields, storage.dbtype === 'MySQL'), relationGuard(k, table, userId))
    .limit(limits.maxRows)
  let payloadBytes = 0
  let count = 0
  for (const candidate of candidates) {
    if (Number(candidate.__snapshotOwned) !== 1) {
      throw new WERR_INVALID_OPERATION('Snapshot relation does not belong to this wallet profile')
    }
    const bytes = Number(candidate.__snapshotBytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WERR_INVALID_OPERATION('Invalid snapshot row size')
    if (payloadBytes + bytes > limits.maxBytes) {
      if (count === 0)
        throw new WERR_INVALID_OPERATION('Snapshot row exceeds maxBytes; large-value streaming is required')
      break
    }
    payloadBytes += bytes
    count++
  }
  const last = candidates[count - 1]
  const cursor: WalletSnapshotCursor | undefined =
    last === undefined ? undefined : { version: 1, snapshotId, table, after: schema.keys.map(key => last[key]) }
  // Validate database keys too, including SQLite strings without enforced SQL length.
  const end = position(cursor, snapshotId, table, schema.keys)
  let rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
  if (end !== undefined) {
    const query = base().select(`${schema.name}.*`).limit(count)
    seek(query, schema.keys, end, true)
    const raw: Array<Record<string, unknown>> = await query
    rows = raw.map(row => normalize(storage, row, schema))
  }
  return { rows, payloadBytes, cursor, done: count === candidates.length && candidates.length < limits.maxRows }
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
    const header = await view.read(async trx => {
      const sourceStorage = await storage.readSettings(trx)
      const user = await storage.findUserByIdentityKey(identityKey, trx)
      if (user === undefined) throw new WERR_INVALID_PARAMETER('identityKey', 'an existing wallet profile')
      return { sourceStorage, user }
    })
    const userId = header.user.userId
    const snapshotId = Utils.toHex(Random(32))
    const columns = new Map<WalletSnapshotTable, string[]>()
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
      async readPage<T extends WalletSnapshotTable>(
        table: T,
        cursor?: WalletSnapshotCursor,
        limits: WalletSnapshotPageLimits = {}
      ): Promise<WalletSnapshotPage<T>> {
        const schema = definition(table)
        const after = position(cursor, snapshotId, table, schema.keys)
        const maxRows = bound(limits.maxRows, 128, 1000, 'maxRows')
        const maxBytes = bound(limits.maxBytes, 262144, 16777216, 'maxBytes')
        return await view.read(trx =>
          readPage(storage, trx, userId, table, after, { maxRows, maxBytes }, columns, snapshotId)
        )
      }
    }
  } catch (error) {
    // Keep the opening error authoritative while still awaiting physical cleanup.
    await view.close().catch(() => undefined)
    throw error
  }
}
