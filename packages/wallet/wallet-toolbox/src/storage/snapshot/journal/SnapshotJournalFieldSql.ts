import type { Knex } from 'knex'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotJournalFieldDescriptor } from './SnapshotJournalFieldTypes'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { readBrc38NativeTextExtent } from '../../portable/Brc38NativeTextReadNode'
import { nativePackedTextSource } from '../../portable/Brc38NativePackedTextSources'
import { brc38NativePackedLength, readBrc38NativePackedDescriptor } from '../../portable/Brc38NativePackedFieldsNode'
import {
  brc38NativePackedTextLength,
  readBrc38NativePackedTextDescriptor
} from '../../portable/Brc38NativePackedTextFieldsNode'
import {
  brc38NativeTextCoordinate,
  brc38NativeTextProtocolSupports,
  type Brc38NativeBlobRead,
  type Brc38NativeTextRead
} from '../../portable/Brc38NativeBlobProtocol'
import {
  readBrc38NativeBinaryExtent,
  isBrc38NativeBinaryReadTransaction
} from '../../portable/Brc38NativeBinaryReadNode'
import { hasBrc38NativePackedSchema } from '../../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from '../../portable/Brc38NativePackedTextSchemaNode'
import {
  brc38NativePackedWalletFields,
  isBrc38NativePackedWalletTable
} from '../../portable/Brc38NativePackedWalletNode'
import { isBrc38NativePackedTextWalletTable } from '../../portable/Brc38NativePackedTextWalletNode'

/** Shared bounded SQL field primitives only; no snapshot/source orchestrator
 * imports, SQL authority factory, stored schema verdict or financial ACK. */
export interface SnapshotJournalSqlSource {
  table: WalletSnapshotTable
  name: string
  keys: readonly string[]
}

// Journal IDs follow observer order, not portable archive or sync dependency order.
const sourceDefinitions: readonly SnapshotJournalSqlSource[] = [
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

export const snapshotJournalDeltaSources = Object.freeze(
  sourceDefinitions.map(source => Object.freeze({ ...source, keys: Object.freeze([...source.keys]) }))
)

type Source = SnapshotJournalSqlSource
const sources = snapshotJournalDeltaSources
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or inconsistent snapshot journal delta source')
}
export function driver(k: Knex): boolean {
  const client = k.client.config.client
  if (!k.isTransaction) return invalid()
  if (client === 'better-sqlite3' || client === 'sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

export async function columns(k: Knex, source: Source, mysql: boolean): Promise<string[]> {
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

export async function materialization(k: Knex, source: Source) {
  const native = isBrc38NativeBinaryReadTransaction(k)
  const text =
    native &&
    isBrc38NativePackedTextWalletTable(source.name) &&
    (await hasBrc38NativePackedTextSchema(k as Knex.Transaction))
  if (native && isBrc38NativePackedTextWalletTable(source.name) && !text) {
    const protocol: Array<{ abi: number }> = await k.raw('SELECT brc38_text_read_protocol() AS abi')
    if (
      protocol.length !== 1 ||
      !brc38NativeTextProtocolSupports(source.table as Brc38NativeTextRead['table'], protocol[0].abi)
    )
      invalid()
  }
  return {
    native,
    // The complete fresh TEXT check above also validates the complete binary
    // family. Reuse that composition only within this actual operation; legacy
    // layouts still perform their original independent binary check.
    packed: native && isBrc38NativePackedWalletTable(source.name) && (text || (await hasBrc38NativePackedSchema(k))),
    text
  }
}
export function fieldColumns(source: Source, fields: readonly string[]) {
  const binaries = isBrc38NativePackedWalletTable(source.name) ? brc38NativePackedWalletFields(source.name) : []
  const texts = isBrc38NativePackedTextWalletTable(source.name) ? nativePackedTextSource(source.name).fields : []
  const deferred = fields.filter(field => binaries.includes(field) || (texts as readonly string[]).includes(field))
  return { deferred, binary: (field: string) => binaries.includes(field) }
}
export function fieldLength(
  k: Knex,
  source: Source,
  field: string,
  binary: boolean,
  mode: Awaited<ReturnType<typeof materialization>>,
  mysql: boolean
): Knex.Raw {
  if (binary && mode.packed)
    return brc38NativePackedLength(k as Knex.Transaction, {
      table: source.table as Brc38NativeBlobRead['table'],
      field: field as Brc38NativeBlobRead['field']
    })
  if (!binary && mode.text)
    return brc38NativePackedTextLength(k as Knex.Transaction, {
      table: source.table as Brc38NativeTextRead['table'],
      field: field as Brc38NativeTextRead['field']
    })
  if (!binary && mode.native) {
    const coordinate = brc38NativeTextCoordinate(
      source.table as Brc38NativeTextRead['table'],
      field as Brc38NativeTextRead['field']
    )
    return k.raw('brc38_text_extent_bytes(?,?,??.rowid)', [coordinate[0], coordinate[1], source.name])
  }
  const name = source.name + '.' + field
  if (mysql)
    return binary ? k.raw('octet_length(??)', [name]) : k.raw('octet_length(CONVERT(?? USING utf8mb4))', [name])
  return k.raw('CASE WHEN ?? IS NULL THEN NULL WHEN typeof(??)=? THEN length(CAST(?? AS BLOB)) ELSE -1 END', [
    name,
    name,
    binary ? 'blob' : 'text',
    name
  ])
}
export function scalarCharge(k: Knex, source: Source, fields: readonly string[], mysql: boolean): Knex.Raw {
  if (fields.length === 0) return k.raw('0')
  const cell = mysql ? 'octet_length(??)' : 'length(CAST(?? AS BLOB))'
  return k.raw(
    '(' + fields.map(() => '2*coalesce(' + cell + ',0)+64').join('+') + ')',
    fields.map(field => source.name + '.' + field)
  )
}
export function ownCells(raw: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map(field => {
      const d = Object.getOwnPropertyDescriptor(raw, field)
      if (d === undefined || !d.enumerable || !Object.hasOwn(d, 'value')) invalid()
      return [field, d.value]
    })
  )
}
export async function packedFieldDigest(
  k: Knex,
  source: Source,
  field: string,
  binary: boolean,
  mode: Awaited<ReturnType<typeof materialization>>,
  row: Readonly<Record<string, unknown>>,
  bytes: number
): Promise<string | undefined> {
  if (binary ? !mode.packed : !mode.text) return undefined
  const rowId = binary || source.name === 'certificate_fields' ? row.__journalFieldRowId : row[source.keys[0]]
  if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
  const value = binary
    ? await readBrc38NativePackedDescriptor(k as Knex.Transaction, {
        table: source.table as Brc38NativeBlobRead['table'],
        field: field as Brc38NativeBlobRead['field'],
        rowId
      })
    : await readBrc38NativePackedTextDescriptor(k as Knex.Transaction, {
        table: source.table as Brc38NativeTextRead['table'],
        field: field as Brc38NativeTextRead['field'],
        rowId
      })
  if (value === undefined || value.bytes !== bytes || !/^[0-9a-f]{64}$/.test(value.sha256)) invalid()
  return value.sha256
}

/** Bounded actual point-row DATA for destination custody hashing. The caller
 * supplies its own freshly indexed current key in this same SQL transaction;
 * this function confers no source/profile/window or financial authority.
 * Deferred fields are explicit extents, never empty complete-row markers. */
export async function readSnapshotJournalPointFields(
  k: Knex,
  tableId: number,
  selectedKey: Readonly<Record<string, string | number>>,
  maximumMetadataAllocation: number
): Promise<
  | {
      names: readonly string[]
      smallRow: Readonly<Record<string, unknown>>
      fields: Readonly<Record<string, Readonly<SnapshotJournalFieldDescriptor>>>
      allocationBytes: number
      readExtent: (field: string, offset: number, length: number) => Promise<Uint8Array>
    }
  | undefined
> {
  const mysql = driver(k),
    source = sources[tableId],
    key = { ...selectedKey }
  if (
    source === undefined ||
    tableId === 7 ||
    !Number.isSafeInteger(maximumMetadataAllocation) ||
    maximumMetadataAllocation < 1 ||
    maximumMetadataAllocation > 16777216
  )
    invalid()
  const expectedKeys = [...source.keys, ...([8, 9, 10, 11].includes(tableId) ? [] : ['userId'])]
  if (
    Object.keys(key).length !== expectedKeys.length ||
    expectedKeys.some(name => !Object.hasOwn(key, name)) ||
    Object.values(key).some(value =>
      typeof value === 'number'
        ? !Number.isSafeInteger(value) || value < 1
        : typeof value !== 'string' || Buffer.byteLength(value) > 400
    )
  )
    invalid()
  const names = Object.keys(Object.fromEntries((await columns(k, source, mysql)).map(name => [name, 0]))),
    mode = await materialization(k, source),
    selection = fieldColumns(source, names),
    small = names.filter(name => !selection.deferred.includes(name)),
    query = () => {
      if ((k as Knex.Transaction).isCompleted()) invalid()
      const q = k(source.name).where(key).limit(2)
      for (const [name, value] of Object.entries(key))
        if (typeof value === 'string')
          q.whereRaw(mysql ? 'CAST(?? AS BINARY)=CAST(? AS BINARY)' : 'CAST(?? AS BLOB)=CAST(? AS BLOB)', [name, value])
      if (mysql) q.forUpdate().noWait()
      return q
    }
  const sizes: Array<{ allocation: unknown }> = await query().select(
    k.raw('? AS allocation', [k.raw('8*?+?', [scalarCharge(k, source, small, mysql), 512 * selection.deferred.length])])
  )
  if (sizes.length > 1) invalid()
  if (sizes.length === 0) return undefined
  const allocationBytes = Number(sizes[0].allocation)
  if (sizes[0].allocation === null || !Number.isSafeInteger(allocationBytes) || allocationBytes < 0) invalid()
  if (allocationBytes > maximumMetadataAllocation)
    throw new SnapshotResourceLimitError('Journal point metadata exceeds its allocation')
  const rows: Array<Record<string, unknown>> = await query().select(
    ...small,
    ...selection.deferred.map((field, index) =>
      k.raw('? AS ??', [
        fieldLength(k, source, field, selection.binary(field), mode, mysql),
        '__journalFieldLength_' + index
      ])
    ),
    ...(mode.native ? [k.raw('rowid AS __journalFieldRowId')] : [])
  )
  if (rows.length !== 1) invalid()
  const raw = rows[0],
    smallRow = ownCells(raw, small),
    fields: Record<string, SnapshotJournalFieldDescriptor> = Object.create(null)
  for (const [index, field] of selection.deferred.entries()) {
    const value = raw['__journalFieldLength_' + index]
    if (value === null) {
      smallRow[field] = null
      continue
    }
    const bytes = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1000000000) invalid()
    const binary = selection.binary(field),
      sha256 = await packedFieldDigest(k, source, field, binary, mode, raw, bytes)
    fields[field] = Object.freeze({
      kind: binary ? 'binary' : 'utf8',
      bytes,
      ...(sha256 === undefined ? {} : { sha256 })
    })
  }
  const ownKey = (): void => {
    for (const name of expectedKeys) if (smallRow[name] !== key[name]) invalid()
  }
  ownKey()
  const readExtent = async (field: string, offset: number, length: number): Promise<Uint8Array> => {
    const descriptor = fields[field]
    if (
      descriptor === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 65536 ||
      offset > descriptor.bytes - length
    )
      invalid()
    const binary = selection.binary(field)
    const observed: Array<Record<string, unknown>> = await query().select(
      ...expectedKeys,
      k.raw('? AS __length', [fieldLength(k, source, field, binary, mode, mysql)]),
      ...(mode.native ? [k.raw('rowid AS __journalFieldRowId')] : [])
    )
    if (
      observed.length !== 1 ||
      expectedKeys.some(name => observed[0][name] !== key[name]) ||
      observed[0].__length === null ||
      Number(observed[0].__length) !== descriptor.bytes ||
      (await packedFieldDigest(k, source, field, binary, mode, observed[0], descriptor.bytes)) !== descriptor.sha256
    )
      invalid()
    if (length === 0) return new Uint8Array(0)
    if (mode.native) {
      const rowId = observed[0].__journalFieldRowId
      if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || rowId !== raw.__journalFieldRowId) invalid()
      const data = { table: source.table, field, rowId, offset, totalBytes: descriptor.bytes, length }
      const bytes = binary
        ? await readBrc38NativeBinaryExtent(k as Knex.Transaction, data as Brc38NativeBlobRead)
        : await readBrc38NativeTextExtent(k as Knex.Transaction, data as Brc38NativeTextRead)
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
      return bytes
    }
    const expression = mysql
        ? binary
          ? 'CAST(?? AS BINARY)'
          : 'CAST(CONVERT(?? USING utf8mb4) AS BINARY)'
        : 'CAST(?? AS BLOB)',
      result: Array<{ bytes: unknown }> = await query().select(
        k.raw('substr(' + expression + ',?,?) AS bytes', [field, offset + 1, length])
      )
    if (result.length !== 1 || !(result[0].bytes instanceof Uint8Array) || result[0].bytes.byteLength !== length)
      invalid()
    return new Uint8Array(result[0].bytes)
  }
  return {
    names: Object.freeze(names),
    smallRow: Object.freeze(smallRow),
    fields: Object.freeze(fields),
    allocationBytes,
    readExtent
  }
}
