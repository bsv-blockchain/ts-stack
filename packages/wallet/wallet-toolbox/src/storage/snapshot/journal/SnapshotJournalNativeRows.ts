import {
  hydrateBrc38NativePackedWalletRows,
  brc38NativePackedWalletRowCharge,
  type Brc38NativePackedWalletTable
} from '../../portable/Brc38NativePackedWalletNode'
import { hasBrc38NativePackedSchema } from '../../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from '../../portable/Brc38NativePackedTextSchemaNode'
import {
  hydrateBrc38NativePackedTextWalletRows,
  prechargeBrc38NativePackedTextWalletRows,
  brc38NativePackedTextWalletRowCharge,
  isBrc38NativePackedTextWalletTable
} from '../../portable/Brc38NativePackedTextWalletNode'
import { brc38NativePackedLength } from '../../portable/Brc38NativePackedFieldsNode'
import {
  isBrc38NativeBinaryReadTransaction,
  readBrc38NativeBinaryRange
} from '../../portable/Brc38NativeBinaryReadNode'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import type { StorageKnex } from '../../StorageKnex'
import type { EntityTimeStamp } from '../../../sdk/types'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  brc38ImportTargetIndexes,
  brc38ImportTargetIndexName,
  verifyBrc38ImportTargetIndexes,
  type Brc38ImportTargetIndex
} from '../../portable/Brc38ImportTargetIndexes'

export type SnapshotJournalEntityTable = Exclude<WalletSnapshotTable, 'syncStates'>
export interface SnapshotJournalAllocationBudget {
  remaining: number
}

export const snapshotJournalNativeEntityKeys = Object.freeze([
  ['transactions', ['transactionId']],
  ['outputs', ['outputId']],
  ['certificates', ['certificateId']],
  ['txLabels', ['txLabelId']],
  ['outputBaskets', ['basketId']],
  ['outputTags', ['outputTagId']],
  ['commissions', ['commissionId']],
  ['syncStates', ['syncStateId']],
  ['provenTxs', ['provenTxId']],
  ['provenTxReqs', ['provenTxReqId']],
  ['txLabelMaps', ['txLabelId', 'transactionId']],
  ['outputTagMaps', ['outputTagId', 'outputId']],
  ['certificateFields', ['certificateId', 'fieldName']]
] as const)

const methods: Readonly<Record<string, SnapshotJournalEntityTable>> = {
  findProvenTxs: 'provenTxs',
  findOutputBaskets: 'outputBaskets',
  findOutputTags: 'outputTags',
  findTxLabels: 'txLabels',
  findTransactions: 'transactions',
  findOutputs: 'outputs',
  findTxLabelMaps: 'txLabelMaps',
  findOutputTagMaps: 'outputTagMaps',
  findCertificates: 'certificates',
  findCertificateFields: 'certificateFields',
  findCommissions: 'commissions',
  findProvenTxReqs: 'provenTxReqs'
}
export function snapshotJournalNativeFindTable(method: string): SnapshotJournalEntityTable | undefined {
  return Object.hasOwn(methods, method) ? methods[method] : undefined
}
const booleans: Partial<Record<SnapshotJournalEntityTable, string[]>> = {
  outputBaskets: ['isDeleted'],
  outputTags: ['isDeleted'],
  txLabels: ['isDeleted'],
  transactions: ['isOutgoing'],
  outputs: ['spendable', 'change'],
  txLabelMaps: ['isDeleted'],
  outputTagMaps: ['isDeleted'],
  certificates: ['isDeleted'],
  commissions: ['isRedeemed'],
  provenTxReqs: ['notified', 'wasBroadcast']
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unsupported bounded journal entity read')
}
export function chargeSnapshotJournalAllocation(budget: SnapshotJournalAllocationBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining)
    throw new SnapshotResourceLimitError('Journal entity exceeds negotiated allocation capacity')
  budget.remaining -= bytes
}

/** Clone only the already decoded raw SQL cell types, charging before copies. */
export function normalizeSnapshotJournalNativeRow(
  storage: StorageKnex,
  table: SnapshotJournalEntityTable,
  input: Record<string, unknown>,
  budget: SnapshotJournalAllocationBudget
): Record<string, unknown> & EntityTimeStamp {
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).length > 64 ||
    Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))
  )
    invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const value: unknown = descriptor.value
    chargeSnapshotJournalAllocation(budget, 512 + 8 * name.length)
    if (value instanceof Uint8Array) {
      chargeSnapshotJournalAllocation(budget, 16 * value.byteLength + 256)
      result[name] = new Uint8Array(value)
    } else if (value instanceof Date) {
      const time = Date.prototype.getTime.call(value)
      if (!Number.isFinite(time)) invalid()
      result[name] = new Date(time)
    } else if (value === null || value === undefined || typeof value === 'boolean') result[name] = value
    else if (typeof value === 'string') {
      chargeSnapshotJournalAllocation(budget, 8 * value.length)
      result[name] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) result[name] = value
    else if (
      typeof value === 'bigint' &&
      value >= BigInt(-Number.MAX_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    )
      result[name] = Number(value)
    else invalid()
  }
  // This is the same normalization used by ordinary native table reads.
  return storage.validateEntity(
    result as unknown as Record<string, unknown> & EntityTimeStamp,
    undefined,
    booleans[table]
  )
}

export async function verifySnapshotJournalEntityIndexes(k: Knex): Promise<void> {
  if (!k.isTransaction) invalid()
  if (k.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(k)) {
    await verifyBrc38ImportTargetIndexes(k as Knex.Transaction)
    return
  }
  if (!['mysql', 'mysql2'].includes(String(k.client.config.client))) invalid()
  const keys = Object.keys(brc38ImportTargetIndexes) as Brc38ImportTargetIndex[]
  const rows: Array<Record<string, unknown>> = await k('information_schema.STATISTICS')
    .select(
      'TABLE_NAME',
      'INDEX_NAME',
      'COLUMN_NAME',
      'SEQ_IN_INDEX',
      'NON_UNIQUE',
      'COLLATION',
      'SUB_PART',
      'INDEX_TYPE',
      'IS_VISIBLE',
      'EXPRESSION'
    )
    .whereRaw('TABLE_SCHEMA=DATABASE()')
    .whereIn(
      'INDEX_NAME',
      keys.map(key => brc38ImportTargetIndexName(key))
    )
    .orderBy(['INDEX_NAME', 'SEQ_IN_INDEX'])
    .limit(65)
  const expected = keys.flatMap(key =>
    brc38ImportTargetIndexes[key][1].map((column, index) => ({
      table: brc38ImportTargetIndexes[key][0],
      name: brc38ImportTargetIndexName(key),
      column,
      position: index + 1
    }))
  )
  if (rows.length !== expected.length || rows.length > 64) invalid()
  for (const value of expected) {
    const actual = rows.filter(row => row.INDEX_NAME === value.name && Number(row.SEQ_IN_INDEX) === value.position)
    if (
      actual.length !== 1 ||
      actual[0].TABLE_NAME !== value.table ||
      actual[0].COLUMN_NAME !== value.column ||
      Number(actual[0].NON_UNIQUE) !== 1 ||
      actual[0].COLLATION !== 'A' ||
      actual[0].SUB_PART !== null ||
      actual[0].INDEX_TYPE !== 'BTREE' ||
      actual[0].IS_VISIBLE !== 'YES' ||
      actual[0].EXPRESSION !== null
    )
      invalid()
  }
}

export function snapshotJournalIndexedEntityQuery(
  k: Knex,
  index: Brc38ImportTargetIndex,
  key: Readonly<Record<string, string | number>>
): Knex.QueryBuilder {
  if (!k.isTransaction) invalid()
  const [table, fields] = brc38ImportTargetIndexes[index]
  if (Object.keys(key).length !== fields.length || fields.some(field => !Object.hasOwn(key, field))) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return k
    .from(k.raw(mysql ? '?? FORCE INDEX (??)' : '?? INDEXED BY ??', [table, brc38ImportTargetIndexName(index, k)]))
    .where(key)
    .limit(2)
}

function findIndex(
  table: SnapshotJournalEntityTable,
  partial: Readonly<Record<string, string | number>>
): Brc38ImportTargetIndex {
  const keys = Object.keys(brc38ImportTargetIndexes) as Brc38ImportTargetIndex[]
  const matches = keys.filter(
    index =>
      brc38ImportTargetIndexes[index][0] === brc38ImportTargetIndexes[table][0] &&
      Object.keys(partial).length === brc38ImportTargetIndexes[index][1].length &&
      brc38ImportTargetIndexes[index][1].every(field => Object.hasOwn(partial, field))
  )
  if (matches.length !== 1) invalid()
  return matches[0]
}

async function columns(k: Knex, table: string, mysql: boolean): Promise<string[]> {
  const rows: Array<{ name: unknown }> = mysql
    ? await k('information_schema.COLUMNS')
        .select({ name: 'COLUMN_NAME' })
        .whereRaw('TABLE_SCHEMA=DATABASE()')
        .where('TABLE_NAME', table)
        .orderBy('ORDINAL_POSITION')
        .limit(65)
    : await k.raw('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 65', [table])
  if (
    rows.length < 1 ||
    rows.length > 64 ||
    rows.some(row => typeof row.name !== 'string' || Buffer.byteLength(row.name, 'utf8') > 128)
  )
    invalid()
  return rows.map(row => row.name as string)
}

/** Actual primary-key metadata is checked before each point read. No observed
 * schema or backend verdict survives this transaction. */
async function verifyPrimaryKey(k: Knex, table: string, expected: readonly string[], remote: boolean): Promise<void> {
  const rows: Array<{ name: unknown; position: unknown }> = remote
    ? await k('information_schema.KEY_COLUMN_USAGE')
        .whereRaw('TABLE_SCHEMA=DATABASE()')
        .where({ TABLE_NAME: table, CONSTRAINT_NAME: 'PRIMARY' })
        .select({ name: 'COLUMN_NAME', position: 'ORDINAL_POSITION' })
        .orderBy('ORDINAL_POSITION')
        .limit(4)
    : await k.raw('SELECT name,pk AS position FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk LIMIT 4', [table])
  if (
    rows.length !== expected.length ||
    rows.some((row, index) => row.name !== expected[index] || Number(row.position) !== index + 1)
  )
    invalid()
}

async function verifyCompositeKey(k: Knex, table: string, expected: readonly string[], remote: boolean): Promise<void> {
  const rows: Array<{ name: unknown; column: unknown; position: unknown }> = remote
    ? await k('information_schema.STATISTICS')
        .whereRaw('TABLE_SCHEMA=DATABASE()')
        .where({ TABLE_NAME: table, NON_UNIQUE: 0 })
        .whereNull('SUB_PART')
        .whereNull('EXPRESSION')
        .select({ name: 'INDEX_NAME', column: 'COLUMN_NAME', position: 'SEQ_IN_INDEX' })
        .orderBy(['INDEX_NAME', 'SEQ_IN_INDEX'])
        .limit(65)
    : await k.raw(
        'SELECT il.name,ii.name AS "column",ii.seqno+1 AS position FROM pragma_index_list(?) il JOIN pragma_index_info(il.name) ii WHERE il."unique"=1 AND il.partial=0 ORDER BY il.name,ii.seqno LIMIT 65',
        [table]
      )
  if (rows.length > 64) invalid()
  const indexes = new Map<string, string[]>()
  for (const row of rows) {
    if (
      typeof row.name !== 'string' ||
      row.name.length > 128 ||
      typeof row.column !== 'string' ||
      row.column.length > 128
    )
      invalid()
    const fields = indexes.get(row.name) ?? []
    if (Number(row.position) !== fields.length + 1) invalid()
    fields.push(row.column)
    indexes.set(row.name, fields)
  }
  if (
    ![...indexes.values()].some(
      fields => fields.length === expected.length && expected.every(field => fields.includes(field))
    )
  )
    invalid()
}

/** Bounded raw native postimage for ownership/withdrawal checks. The fingerprint
 * covers every cell and the real destination key; updated_at alone does not
 * establish that a local row was left unchanged. Global proof/request rows are
 * observable here but are never deletion-authorized by this result. */
export async function readSnapshotJournalNativeOwnedRow(
  k: Knex,
  tableId: number,
  userId: number,
  input: { id1: number; id2: number; exactText: string },
  budget: SnapshotJournalAllocationBudget
): Promise<
  | { fingerprint: string; key: Readonly<Record<string, string | number>>; row: Readonly<Record<string, unknown>> }
  | undefined
> {
  if (!k.isTransaction || !Number.isSafeInteger(tableId) || tableId < 0 || tableId > 12 || tableId === 7) invalid()
  // Callers may supply a complete metadata record. Only these original key
  // coordinates belong in the position; present/generation are not cursor fields.
  const local = { id1: input.id1, id2: input.id2, exactText: input.exactText }
  const [table, fields] = snapshotJournalNativeEntityKeys[tableId]
  if (
    !Number.isSafeInteger(local.id1) ||
    local.id1 < 1 ||
    !Number.isSafeInteger(local.id2) ||
    local.id2 < 0 ||
    typeof local.exactText !== 'string' ||
    Buffer.byteLength(local.exactText, 'utf8') > 400 ||
    (tableId === 12 ? local.id2 !== 0 : local.exactText !== '' || (tableId >= 10 ? local.id2 < 1 : local.id2 !== 0))
  )
    invalid()
  const remote = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (!remote && !['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
    invalid()
  const name = brc38ImportTargetIndexes[table as SnapshotJournalEntityTable][0]
  if (fields.length === 1) await verifyPrimaryKey(k, name, fields, remote)
  else await verifyCompositeKey(k, name, fields, remote)
  const key: Record<string, string | number> = { [fields[0]]: local.id1 }
  if (fields.length === 2) key[fields[1]] = tableId === 12 ? local.exactText : local.id2
  if (![8, 9, 10, 11].includes(tableId)) key.userId = userId
  const names = await columns(k, name, remote)
  const query = () => {
    const value =
      fields.length === 1
        ? k(name).where(key).limit(2)
        : snapshotJournalIndexedEntityQuery(k, table as Brc38ImportTargetIndex, key)
    if (remote) value.forUpdate().noWait()
    return value
  }
  const packed =
      isBrc38NativeBinaryReadTransaction(k) &&
      (await hasBrc38NativePackedSchema(k)) &&
      ['transactions', 'outputs', 'proven_txs', 'proven_tx_reqs', 'commissions'].includes(name),
    textTable = isBrc38NativePackedTextWalletTable(name) ? name : undefined,
    text =
      textTable !== undefined &&
      isBrc38NativeBinaryReadTransaction(k) &&
      (await hasBrc38NativePackedTextSchema(k as Knex.Transaction))
  const length = remote ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const baseCharge = packed
      ? brc38NativePackedWalletRowCharge(k, name as Brc38NativePackedWalletTable, names, 16, 512)
      : k.raw('(' + names.map(() => '16*coalesce(' + length + ',0)+512').join('+') + ')', names),
    rowCharge = text
      ? brc38NativePackedTextWalletRowCharge(k as Knex.Transaction, textTable!, names, baseCharge)
      : baseCharge
  const sizes: Array<{ bytes: unknown }> = await query().select(k.raw('? AS bytes', [rowCharge]))
  if (sizes.length > 1) invalid()
  if (sizes.length === 0) return undefined
  if (sizes[0].bytes === null) invalid()
  chargeSnapshotJournalAllocation(budget, Number(sizes[0].bytes))
  const rows: Array<Record<string, unknown>> = await query().select(names)
  if (rows.length !== 1) invalid()
  if (text) await prechargeBrc38NativePackedTextWalletRows(k, textTable!, rows)
  if (packed) await hydrateBrc38NativePackedWalletRows(k, name as Brc38NativePackedWalletTable, rows)
  if (text) await hydrateBrc38NativePackedTextWalletRows(k, textTable!, rows)
  const raw = rows[0]
  if (Reflect.ownKeys(raw).length !== names.length) invalid()
  const row = Object.fromEntries(
    names.map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, name)
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      return [name, descriptor.value]
    })
  )
  const revision = snapshotJournalRevision('1')
  const frame = encodeSnapshotJournalDeltaFrame(
    {
      table,
      changes: [{ present: true, metadata: { ...local, revision, present: true }, row }],
      examined: 1,
      payloadBytes: 0,
      complete: false,
      after: { ...local, revision }
    },
    { tableId, stream: 'scope' }
  )
  return {
    fingerprint: createHash('sha256').update(frame).digest('hex'),
    key: Object.freeze(key),
    row: Object.freeze(row)
  }
}

async function rawSlice(
  k: Knex,
  txid: string,
  budget: SnapshotJournalAllocationBudget,
  offset?: number,
  length?: number
): Promise<Uint8Array | undefined> {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (
    offset !== undefined &&
    (!Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      !Number.isSafeInteger(offset + (length as number)))
  )
    invalid()
  for (const index of ['provenTxs', 'provenTxReqs'] as const) {
    const query = () => {
      const value = snapshotJournalIndexedEntityQuery(k, index, { txid })
      if (index === 'provenTxReqs')
        value.whereIn(
          'status',
          offset === undefined
            ? ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed']
            : ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail']
        )
      if (mysql) value.forUpdate().noWait()
      return value
    }
    const packed = isBrc38NativeBinaryReadTransaction(k) && (await hasBrc38NativePackedSchema(k)),
      size = packed
        ? brc38NativePackedLength(k as Knex.Transaction, { table: index, field: 'rawTx' })
        : k.raw(mysql ? 'octet_length(rawTx)' : 'length(rawTx)'),
      extent =
        offset === undefined
          ? size
          : k.raw(mysql ? 'LEAST(GREATEST(?-?,0),?)' : 'MIN(MAX(?-?,0),?)', [size, offset, length!])
    const rows: Array<{ bytes: unknown; valid: unknown }> = await query().select(
      k.raw('16*?+256 AS bytes', [extent]),
      k.raw(mysql ? '1 AS valid' : "CASE WHEN rawTx IS NULL OR typeof(rawTx)='blob' THEN 1 ELSE 0 END AS valid")
    )
    if (rows.length > 1) invalid()
    if (rows.length === 0) continue
    if (Number(rows[0].valid) !== 1) invalid()
    if (rows[0].bytes === null) {
      if (index === 'provenTxs' && offset === undefined) return undefined
      continue
    }
    const bytes = Number(rows[0].bytes)
    chargeSnapshotJournalAllocation(budget, bytes)
    if (isBrc38NativeBinaryReadTransaction(k)) {
      const actual = (await query().select(k.raw('rowid AS rowId,? AS totalBytes', [size]))) as Array<{
          rowId: number
          totalBytes: number
        }>,
        amount = (bytes - 256) / 16
      if (
        actual.length !== 1 ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        !Number.isSafeInteger(actual[0].totalBytes) ||
        actual[0].totalBytes < 0
      )
        invalid()
      // SQL slicing past EOF historically returns an empty byte array. No
      // native handle is opened for that bounded, independently observed case.
      if (amount === 0) return new Uint8Array(0)
      return await readBrc38NativeBinaryRange(
        k,
        {
          table: index,
          field: 'rawTx',
          rowId: actual[0].rowId,
          offset: offset ?? 0,
          totalBytes: actual[0].totalBytes,
          length: amount
        },
        amount
      )
    }
    const payloads: Array<{ rawTx: unknown }> = await query().select({
      rawTx: offset === undefined ? 'rawTx' : k.raw('substr(rawTx,?,?)', [offset + 1, length!])
    })
    if (
      payloads.length !== 1 ||
      !(payloads[0].rawTx instanceof Uint8Array) ||
      16 * payloads[0].rawTx.byteLength + 256 !== bytes
    )
      invalid()
    return new Uint8Array(payloads[0].rawTx)
  }
  return undefined
}

export async function readSnapshotJournalNativeEntityRows(
  k: Knex,
  storage: StorageKnex,
  method: string,
  args: { partial: Readonly<Record<string, string | number>>; trx?: unknown },
  budget: SnapshotJournalAllocationBudget
): Promise<Array<Record<string, unknown>>> {
  const table = methods[method]
  if (table === undefined || args.trx !== k || !k.isTransaction) invalid()
  const index = findIndex(table, args.partial)
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  const fields = await columns(k, brc38ImportTargetIndexes[index][0], mysql)
  const query = () => {
    const result = snapshotJournalIndexedEntityQuery(k, index, args.partial)
    if (mysql) result.forUpdate().noWait()
    return result
  }
  const physicalTable = brc38ImportTargetIndexes[index][0],
    packed =
      isBrc38NativeBinaryReadTransaction(k) &&
      (await hasBrc38NativePackedSchema(k)) &&
      ['transactions', 'outputs', 'proven_txs', 'proven_tx_reqs', 'commissions'].includes(physicalTable),
    textTable = isBrc38NativePackedTextWalletTable(physicalTable) ? physicalTable : undefined,
    text =
      textTable !== undefined &&
      isBrc38NativeBinaryReadTransaction(k) &&
      (await hasBrc38NativePackedTextSchema(k as Knex.Transaction))
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const baseCharge = packed
      ? brc38NativePackedWalletRowCharge(k, physicalTable as Brc38NativePackedWalletTable, fields, 16, 256)
      : k.raw('(' + fields.map(() => '16*coalesce(' + length + ',0)+256').join('+') + ')', fields),
    rowCharge = text
      ? brc38NativePackedTextWalletRowCharge(k as Knex.Transaction, textTable!, fields, baseCharge)
      : baseCharge
  const sizes: Array<{ bytes: unknown }> = await query().select(k.raw('? AS bytes', [rowCharge]))
  if (sizes.length > 1) invalid()
  if (sizes.length === 0) return []
  if (sizes[0].bytes === null) invalid()
  chargeSnapshotJournalAllocation(budget, Number(sizes[0].bytes))
  const rows: Array<Record<string, unknown>> = await query().select(brc38ImportTargetIndexes[index][0] + '.*')
  if (rows.length !== 1) invalid()
  if (text) await prechargeBrc38NativePackedTextWalletRows(k, textTable!, rows)
  if (packed) await hydrateBrc38NativePackedWalletRows(k, physicalTable as Brc38NativePackedWalletTable, rows)
  if (text) await hydrateBrc38NativePackedTextWalletRows(k, textTable!, rows)
  const row = normalizeSnapshotJournalNativeRow(storage, table, rows[0], budget)
  if (typeof row.txid === 'string' && row.txid !== '') {
    if (table === 'transactions' && row.rawTx === undefined) row.rawTx = await rawSlice(k, row.txid, budget)
    else if (
      table === 'outputs' &&
      typeof row.scriptOffset === 'number' &&
      typeof row.scriptLength === 'number' &&
      row.scriptOffset !== 0 &&
      row.scriptLength !== 0 &&
      ((!(row.lockingScript instanceof Uint8Array) && !Array.isArray(row.lockingScript)) ||
        (row.lockingScript as ArrayLike<unknown>).length !== row.scriptLength)
    )
      row.lockingScript = await rawSlice(k, row.txid, budget, row.scriptOffset, row.scriptLength)
  }
  return [row]
}
