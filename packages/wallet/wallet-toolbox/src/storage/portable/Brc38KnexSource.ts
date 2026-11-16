import type { Knex } from 'knex'
import { Random, Utils } from '@bsv/sdk'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { StorageKnex } from '../StorageKnex'
import type { RetainedReadSnapshot } from '../snapshot/RetainedReadSnapshot'
import type {
  WalletReadSnapshotOptions,
  WalletSnapshotTable,
  WalletSnapshotBinaryColumn,
  WalletSnapshotCursor
} from '../snapshot/WalletReadSnapshot'
import { createKnexWalletSnapshotBinaryReader, walletSnapshotSourceQuery } from '../snapshot/KnexWalletReadSnapshot'
import { readKnexSnapshotArchiveHeader } from '../snapshot/archive/KnexSnapshotArchiveSource'
import { assertKnexSnapshotArchiveClosure } from '../snapshot/archive/KnexSnapshotArchiveClosure'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import type { BRC38Tables } from './index'
import type { Brc38StreamSource } from './Brc38Stream'
import type { Brc38StreamedRow, Brc38StreamedBinary } from './Brc38StreamedRow'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { closeSnapshotJournalSource } from '../snapshot/journal/closeSnapshotJournalSource'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { readBrc38NativeTextExtent, readBrc38NativeTextBytes } from './Brc38NativeTextReadNode'
import {
  brc38NativeTextCoordinate,
  brc38NativeTextProtocolSupports,
  type Brc38NativeTextRead
} from './Brc38NativeBlobProtocol'
import { brc38StreamedTextFields, type Brc38StreamedText } from './Brc38StreamedText'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { brc38NativePackedTextLength } from './Brc38NativePackedTextFieldsNode'
import {
  hydrateBrc38NativePackedTextWalletRows,
  prechargeBrc38NativePackedTextWalletRows,
  brc38NativePackedTextWalletRowCharge,
  isBrc38NativePackedTextWalletTable,
  type Brc38NativePackedTextWalletTable
} from './Brc38NativePackedTextWalletNode'
import type { Brc38StreamedStructured } from './Brc38StructuredJson'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { brc38NativePackedLength } from './Brc38NativePackedFieldsNode'
import {
  brc38NativePackedWalletRowCharge,
  hydrateBrc38NativePackedWalletRows,
  type Brc38NativePackedWalletTable
} from './Brc38NativePackedWalletNode'

type Row = BRC38Tables[WalletSnapshotTable][number]
interface SourceRow {
  row: Row
  ordinal?: bigint
  binaries?: Partial<Record<WalletSnapshotBinaryColumn, number>>
  structured?: Partial<Record<Brc38NativeTextRead['field'], number>>
  texts?: Partial<Record<Brc38NativeTextRead['field'], number>>
  nativeRowId?: number
}
interface Definition {
  name: string
  keys: readonly string[]
  booleans?: readonly string[]
  dates?: readonly string[]
}
const definitions: Record<WalletSnapshotTable, Definition> = {
  provenTxs: { name: 'proven_txs', keys: ['provenTxId'] },
  // The published getProvenTxReqsForUser/exportBRC38 path normalizes notified
  // only. Keep wasBroadcast's original SQL 0/1 spelling in the archive.
  provenTxReqs: { name: 'proven_tx_reqs', keys: ['provenTxReqId'], booleans: ['notified'] },
  outputBaskets: { name: 'output_baskets', keys: ['basketId'], booleans: ['isDeleted'] },
  transactions: { name: 'transactions', keys: ['transactionId'], booleans: ['isOutgoing'] },
  commissions: { name: 'commissions', keys: ['commissionId'], booleans: ['isRedeemed'] },
  outputs: { name: 'outputs', keys: ['outputId'], booleans: ['spendable', 'change'] },
  outputTags: { name: 'output_tags', keys: ['outputTagId'], booleans: ['isDeleted'] },
  outputTagMaps: { name: 'output_tags_map', keys: ['outputId', 'outputTagId'], booleans: ['isDeleted'] },
  txLabels: { name: 'tx_labels', keys: ['txLabelId'], booleans: ['isDeleted'] },
  txLabelMaps: { name: 'tx_labels_map', keys: ['transactionId', 'txLabelId'], booleans: ['isDeleted'] },
  certificates: { name: 'certificates', keys: ['certificateId'], booleans: ['isDeleted'] },
  certificateFields: { name: 'certificate_fields', keys: ['certificateId', 'fieldName'] },
  syncStates: { name: 'sync_states', keys: ['syncStateId'], booleans: ['init'], dates: ['when'] }
}
export interface Brc38KnexSourceOptions extends WalletReadSnapshotOptions {
  maximumPageRows: number
  maximumPageBytes: number
  maximumRowAllocationBytes: number
  /** Allocation charge of detached rows retained for one locale-sorted certificate. */
  maximumCertificateGroupBytes: number
  maximumMetadataAllocationBytes?: number
  /** Explicit native large-binary mode. Metadata/history retain the existing
   * allocation bounds. The stream encoder needs its own streamedRows policy. */
  streamedBinary?: Readonly<{ maximumBinaryBytes: number; maximumExtentBytes?: number }>
  /** Explicit genuinely owned native UTF8 TEXT producer. A fresh private
   * temporary index is charged independently of the persistent source files. */
  streamedStructured?: Readonly<{
    maximumStructuredBytes: number
    privateIndexParent: string
    maximumTemporaryIndexBytes: number
    maximumIndexMembers: number
  }>
  /** Original scalar TEXT, streamed with ordinary portable JSON string spelling. */
  streamedText?: Readonly<{ maximumTextBytes: number }>
}
const binaryFields: Partial<Record<WalletSnapshotTable, readonly WalletSnapshotBinaryColumn[]>> = {
  provenTxs: ['rawTx', 'merklePath'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  commissions: ['lockingScript'],
  outputs: ['lockingScript']
}
const structuredFields: Partial<Record<WalletSnapshotTable, readonly Brc38NativeTextRead['field'][]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
const storageKeys: Partial<Record<WalletSnapshotTable, readonly string[]>> = {
  certificateFields: ['fieldName', 'certificateId'],
  outputTagMaps: ['outputTagId', 'outputId'],
  txLabelMaps: ['txLabelId', 'transactionId']
}
function bound(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
}
function definition(table: WalletSnapshotTable): Definition {
  if (!Object.hasOwn(definitions, table)) throw new TypeError('Unknown BRC-38 source table')
  return definitions[table]
}
async function columns(k: Knex, name: string, mysql: boolean): Promise<string[]> {
  if (mysql) {
    const [rows]: Array<Array<{ name: string }>> = await k.raw(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 65',
      [name]
    )
    return rows.map(row => row.name)
  }
  const rows: Array<{ name: string }> = await k.raw('SELECT name FROM pragma_table_info(?) LIMIT 65', [name])
  return rows.map(row => row.name)
}
function size(k: Knex, schema: Definition, fields: readonly string[], mysql: boolean): Knex.Raw {
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const cell = `64 + 2 * coalesce(${length}, 0)`
  return k.raw(
    `(${fields.map(() => cell).join(' + ')})`,
    fields.map(field => `${schema.name}.${field}`)
  )
}
function seek(query: Knex.QueryBuilder, keys: readonly string[], after: readonly (number | string)[]): void {
  void query.where(function () {
    for (let index = 0; index < keys.length; index++) {
      void this.orWhere(function () {
        for (let preceding = 0; preceding < index; preceding++) void this.where(keys[preceding], after[preceding])
        void this.where(keys[index], '>', after[index])
      })
    }
  })
}
function sourceKey(value: unknown, key: string): { value: number | string } {
  if (key === 'fieldName') {
    if (typeof value !== 'string' || value.length > 200 || Array.from(value).length > 100)
      throw new TypeError('Invalid BRC-38 source field name')
    return { value }
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Invalid BRC-38 source numeric key')
  return { value }
}
function position(row: Record<string, unknown>, keys: readonly string[]): Array<number | string> {
  return keys.map(key => sourceKey(row[key], key).value)
}
function selectedPrefix(candidates: Array<Record<string, unknown>>, maximum: number): number {
  let bytes = 0,
    count = 0
  for (const row of candidates) {
    const charged = Number(row.__portableBytes)
    if (!Number.isSafeInteger(charged) || charged < 0) throw new TypeError('Invalid BRC-38 stored row charge')
    if (charged > maximum - bytes) {
      if (count === 0) throw new SnapshotResourceLimitError('BRC-38 source row exceeds its page allocation policy')
      break
    }
    bytes += charged
    count++
  }
  return count
}
function normalized(storage: StorageKnex, schema: Definition, raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (schema.booleans?.includes(key)) {
      if (value !== undefined) result[key] = value !== 0 && value !== null && value !== false
      continue
    }
    if (value == null) continue
    if (key === 'created_at' || key === 'updated_at' || schema.dates?.includes(key))
      result[key] = storage.validateDate(value as Date)
    else result[key] = value
  }
  return result
}
interface PageContext {
  storage: StorageKnex
  userId: number
  options: Readonly<Brc38KnexSourceOptions>
}
async function page(context: PageContext, k: Knex, table: WalletSnapshotTable, after?: readonly (number | string)[]) {
  const { storage, userId, options } = context,
    schema = definition(table),
    mysql = storage.dbtype === 'MySQL'
  // Column names are reread in the actual view; an earlier layout result is
  // never reused as schema admission for another page.
  const names = await columns(k, schema.name, mysql)
  if (names.length < 1 || names.length > 64) throw new TypeError('Unsupported BRC-38 source schema')
  if (names.some(name => name.toLowerCase().startsWith('__portable')))
    throw new TypeError('Unsupported BRC-38 source metadata schema')
  const binaries =
    options.streamedBinary === undefined ? [] : (binaryFields[table] ?? []).filter(field => names.includes(field))
  const structured =
    options.streamedStructured === undefined
      ? []
      : (structuredFields[table] ?? []).filter(field => names.includes(field))
  const texts =
    options.streamedText === undefined || !Object.hasOwn(brc38StreamedTextFields, table)
      ? []
      : brc38StreamedTextFields[table as keyof typeof brc38StreamedTextFields].filter(field => names.includes(field))
  if (options.streamedStructured !== undefined && structured.length !== (structuredFields[table]?.length ?? 0))
    throw new Error('BRC-38 native structured source schema lacks an original TEXT field')
  if (
    options.streamedText !== undefined &&
    Object.hasOwn(brc38StreamedTextFields, table) &&
    texts.length !== brc38StreamedTextFields[table as keyof typeof brc38StreamedTextFields].length
  )
    throw new Error('BRC-38 native source schema lacks an original scalar TEXT field')
  if (
    (options.streamedStructured !== undefined || options.streamedText !== undefined) &&
    (mysql || !isOwnedNativeSqlite(k))
  )
    throw new Error('BRC-38 structured source requires its actual retained native producer')
  if (
    structured.length + texts.length !== 0 &&
    names.some(name => ['rowid', '_rowid_', 'oid'].includes(name.toLowerCase()))
  )
    throw new Error('BRC-38 native TEXT source refuses a shadowed physical row identifier')
  const metadata = names.filter(
    field =>
      !binaries.includes(field as WalletSnapshotBinaryColumn) &&
      !structured.includes(field as Brc38NativeTextRead['field']) &&
      !texts.includes(field)
  )
  const packed = isOwnedNativeSqlite(k) && (await hasBrc38NativePackedSchema(k as Knex.Transaction)),
    packedText =
      isBrc38NativePackedTextWalletTable(schema.name) &&
      isOwnedNativeSqlite(k) &&
      (await hasBrc38NativePackedTextSchema(k as Knex.Transaction)),
    hasBinaryTable = binaryFields[table] !== undefined
  const binaryLengths = () =>
    binaries.map((field, index) =>
      packed
        ? k.raw('? AS ??', [
            brc38NativePackedLength(k as Knex.Transaction, {
              table: table as Parameters<typeof brc38NativePackedLength>[1]['table'],
              field
            }),
            `__portableBinary${index}`
          ])
        : k.raw(`${mysql ? 'octet_length(??)' : 'length(??)'} AS ??`, [
            `${schema.name}.${field}`,
            `__portableBinary${index}`
          ])
    )
  const baseMetadataCharge =
      packed && hasBinaryTable
        ? brc38NativePackedWalletRowCharge(k, schema.name as Brc38NativePackedWalletTable, metadata, 16, 64)
        : size(k, schema, metadata, mysql),
    metadataCharge = k.raw('? AS ??', [
      packedText
        ? brc38NativePackedTextWalletRowCharge(
            k as Knex.Transaction,
            schema.name as Brc38NativePackedTextWalletTable,
            metadata,
            baseMetadataCharge
          )
        : baseMetadataCharge,
      '__portableBytes'
    ])
  const textLengths = (fields: readonly string[], prefix: string) =>
    fields.map((name, index) => {
      const field = name as Brc38NativeTextRead['field']
      if (packedText)
        return k.raw('? AS ??', [
          brc38NativePackedTextLength(k as Knex.Transaction, { table: table as Brc38NativeTextRead['table'], field }),
          `${prefix}${index}`
        ])
      const coordinate = brc38NativeTextCoordinate(table as Brc38NativeTextRead['table'], field)
      // Incremental SQLite metadata, not length(cast(full text as blob)).
      return k.raw('brc38_text_extent_bytes(?,?,??) AS ??', [
        coordinate[0],
        coordinate[1],
        `${schema.name}.rowid`,
        `${prefix}${index}`
      ])
    })
  const nativeRowId = () =>
    structured.length + texts.length === 0 ? [] : [k.raw('??.rowid AS ??', [schema.name, '__portableNativeTextRowId'])]
  const keys = schema.keys.map(key => `${schema.name}.${key}`)
  const query = () => {
    const selected = walletSnapshotSourceQuery(k, table, userId)
    if (after !== undefined) seek(selected, keys, after)
    for (const key of keys) void selected.orderBy(key)
    return selected
  }
  // Field-name payloads are bounded in SQL before reaching the driver, just
  // like blob/history lengths. No whole-table row or ID map is materialized.
  const fieldLength = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const keyColumns = schema.keys.map(key =>
    key === 'fieldName'
      ? k.raw(`case when ${fieldLength} <= 400 then ?? end as ??`, [
          `${schema.name}.${key}`,
          `${schema.name}.${key}`,
          key
        ])
      : `${schema.name}.${key}`
  )
  const candidates: Array<Record<string, unknown>> = await query()
    .select(
      ...keyColumns,
      metadataCharge,
      ...binaryLengths(),
      ...textLengths(structured, '__portableStructured'),
      ...textLengths(texts, '__portableText'),
      ...nativeRowId()
    )
    .limit(options.maximumPageRows)
  for (const candidate of candidates) {
    if (candidate.__portableBytes === null) throw new TypeError('BRC-38 source has an invalid logical row charge')
    candidate.__portableBytes =
      Number(candidate.__portableBytes) + 256 * (binaries.length + structured.length + texts.length)
    if (Number(candidate.__portableBytes) > options.maximumRowAllocationBytes)
      throw new SnapshotResourceLimitError('BRC-38 source row exceeds its precharged allocation policy')
  }
  const count = selectedPrefix(candidates, options.maximumPageBytes)
  const lengths = candidates.slice(0, count).map(candidate => {
    const result: Partial<Record<WalletSnapshotBinaryColumn, number>> = {}
    for (const [index, field] of binaries.entries()) {
      const value = candidate[`__portableBinary${index}`]
      if (value === null) continue
      const length = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
      if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Invalid BRC-38 native binary length')
      if (length > options.streamedBinary!.maximumBinaryBytes)
        throw new SnapshotResourceLimitError('BRC-38 native binary exceeds its selected byte policy')
      result[field] = length
    }
    return result
  })
  const jsonLengths = candidates.slice(0, count).map(candidate => {
    const result: Partial<Record<Brc38NativeTextRead['field'], number>> = {}
    for (const [index, field] of structured.entries()) {
      const value = candidate[`__portableStructured${index}`]
      if (value === null) continue
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new TypeError('Invalid BRC-38 native structured TEXT length')
      if (value > options.streamedStructured!.maximumStructuredBytes)
        throw new SnapshotResourceLimitError('BRC-38 native structured TEXT exceeds its selected byte policy')
      result[field] = value
    }
    return result
  })
  const scalarLengths = candidates.slice(0, count).map(candidate => {
    const result: Partial<Record<Brc38NativeTextRead['field'], number>> = {}
    for (const [index, name] of texts.entries()) {
      const value = candidate[`__portableText${index}`]
      if (value === null) continue
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new TypeError('Invalid BRC-38 original scalar TEXT length')
      if (value > options.streamedText!.maximumTextBytes)
        throw new SnapshotResourceLimitError('BRC-38 original scalar TEXT exceeds its admitted field budget')
      result[name as Brc38NativeTextRead['field']] = value
    }
    return result
  })
  if (count === 0) return { rows: [] as SourceRow[], after: undefined, done: true }
  const last = position(candidates[count - 1], schema.keys)
  const payload = query()
    .select(...metadata.map(field => `${schema.name}.${field}`), ...nativeRowId())
    .limit(count)
  const sqliteOrdinal = table === 'certificateFields' && !mysql
  if (sqliteOrdinal) {
    if (names.some(name => ['_rowid_', '__portableordinal'].includes(name.toLowerCase())))
      throw new TypeError('Unsupported BRC-38 certificate source ordinal schema')
    // Keep the physical identity for resolving the original finder's locale
    // ties, as exact signed 64-bit text before it
    // crosses the driver; never place this key in portable archive bytes.
    void payload.select(k.raw('cast(?? as text) as ??', [`${schema.name}._rowid_`, '__portableOrdinal']))
  }
  const raw: Array<Record<string, unknown>> = await payload
  if (raw.length !== count) throw new Error('BRC-38 retained source prefix changed')
  if (packedText)
    await prechargeBrc38NativePackedTextWalletRows(k, schema.name as Brc38NativePackedTextWalletTable, raw)
  if (packed && hasBinaryTable && options.streamedBinary === undefined)
    await hydrateBrc38NativePackedWalletRows(k, schema.name as Brc38NativePackedWalletTable, raw)
  // Hydrate every selected metadata TEXT cell, including the seventeen raw
  // string cells in the other five tables. Streamed JSON cells are absent from
  // metadata; the hydrator cannot materialize them or substitute their markers.
  if (packedText) await hydrateBrc38NativePackedTextWalletRows(k, schema.name as Brc38NativePackedTextWalletTable, raw)
  const rows = raw.map((value, index) => {
    if (schema.keys.some(key => value[key] !== candidates[index][key]))
      throw new Error('BRC-38 retained source keys changed')
    let actualRowId: number | undefined
    if (structured.length + texts.length !== 0) {
      const id = value.__portableNativeTextRowId
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id !== candidates[index].__portableNativeTextRowId)
        throw new Error('BRC-38 actual native TEXT row identifier differs')
      actualRowId = id
      delete value.__portableNativeTextRowId
    }
    let ordinal: bigint | undefined
    if (sqliteOrdinal) {
      const text = value.__portableOrdinal
      if (typeof text !== 'string' || !/^-?\d{1,19}$/.test(text))
        throw new TypeError('Invalid BRC-38 certificate source ordinal')
      ordinal = BigInt(text)
      delete value.__portableOrdinal
    }
    const row = projectBrc38PackedRow(table, normalized(storage, schema, value), {
      maximumAllocationBytes: options.maximumRowAllocationBytes,
      signal: options.signal
    })
    return {
      row,
      ordinal,
      ...(options.streamedBinary === undefined ? {} : { binaries: lengths[index] }),
      ...(options.streamedStructured === undefined ? {} : { structured: jsonLengths[index] }),
      ...(options.streamedText === undefined ? {} : { texts: scalarLengths[index] }),
      ...(actualRowId === undefined ? {} : { nativeRowId: actualRowId })
    }
  })
  return { rows, after: last, done: count === candidates.length && candidates.length < options.maximumPageRows }
}
function rowCharge(value: Row): number {
  // Certificate-field rows contain only scalars in the native table. Refuse a
  // schema extension here until its bounded grouping contract is reviewed.
  let bytes = 64
  for (const [key, child] of Object.entries(value)) {
    bytes += 64 + 2 * key.length
    if (typeof child === 'string') bytes += 64 + 2 * child.length
    else if (typeof child === 'number' || typeof child === 'boolean') bytes += 64
    else throw new TypeError('Unsupported BRC-38 certificate-field grouping value')
  }
  return bytes
}
function certificateNamesOrder(first: SourceRow, second: SourceRow): number {
  if (typeof first.row.fieldName !== 'string' || typeof second.row.fieldName !== 'string')
    throw new TypeError('Invalid certificate field name')
  return first.row.fieldName.localeCompare(second.row.fieldName)
}
function certificateOrder(first: SourceRow, second: SourceRow): number {
  const compared = certificateNamesOrder(first, second)
  if (compared !== 0 || first.ordinal === undefined || second.ordinal === undefined) return compared
  if (first.ordinal < second.ordinal) return -1
  if (first.ordinal > second.ordinal) return 1
  return 0
}
async function* groupedEntries(
  rows: AsyncIterable<SourceRow>,
  maximum: number,
  resolveTies: (group: SourceRow[]) => Promise<void>
): AsyncGenerator<SourceRow> {
  let id: unknown,
    bytes = 0,
    group: SourceRow[] = []
  async function* ordered() {
    group.sort(certificateOrder)
    if (group.some((value, index) => index > 0 && certificateNamesOrder(value, group[index - 1]) === 0)) {
      await resolveTies(group)
      group.sort(certificateOrder)
    }
    yield* group
  }
  for await (const source of rows) {
    const row = source.row
    if (group.length > 0 && row.certificateId !== id) {
      yield* ordered()
      group = []
      bytes = 0
    }
    id = row.certificateId
    const charge =
      // Reserve the bounded ordinal query, detached text and rank map too.
      1024 +
      rowCharge(row) +
      256 * (Object.keys(source.texts ?? {}).length + Object.keys(source.structured ?? {}).length)
    if (charge > maximum - bytes)
      throw new SnapshotResourceLimitError('BRC-38 certificate group exceeds its allocation policy')
    bytes += charge
    group.push(source)
  }
  yield* ordered()
}
async function* grouped(
  rows: AsyncIterable<SourceRow>,
  maximum: number,
  resolveTies: (group: SourceRow[]) => Promise<void>
): AsyncGenerator<Row> {
  for await (const source of groupedEntries(rows, maximum, resolveTies)) yield source.row
}
function ownSourceOptions(storage: StorageKnex, identityKey: string, selected: Brc38KnexSourceOptions) {
  const options = Object.freeze({
    ...selected,
    ...(selected.streamedBinary === undefined ? {} : { streamedBinary: Object.freeze({ ...selected.streamedBinary }) }),
    ...(selected.streamedStructured === undefined
      ? {}
      : { streamedStructured: Object.freeze({ ...selected.streamedStructured }) }),
    ...(selected.streamedText === undefined ? {} : { streamedText: Object.freeze({ ...selected.streamedText }) })
  })
  bound(options.maximumPageRows, 1000, 'maximumPageRows')
  bound(options.maximumPageBytes, 16777216, 'maximumPageBytes')
  bound(options.maximumRowAllocationBytes, 16777216, 'maximumRowAllocationBytes')
  bound(options.maximumCertificateGroupBytes, 16777216, 'maximumCertificateGroupBytes')
  bound(options.maximumMetadataAllocationBytes ?? 65536, 65536, 'maximumMetadataAllocationBytes')
  if (options.streamedBinary !== undefined) {
    bound(options.streamedBinary.maximumBinaryBytes, Number.MAX_SAFE_INTEGER, 'maximumBinaryBytes')
    bound(options.streamedBinary.maximumExtentBytes ?? 65536, 65536, 'maximumExtentBytes')
  }
  if (options.streamedStructured !== undefined) {
    bound(options.streamedStructured.maximumStructuredBytes, 1000000000, 'maximumStructuredBytes')
    bound(options.streamedStructured.maximumTemporaryIndexBytes, 17179869184, 'maximumTemporaryIndexBytes')
    if (options.streamedStructured.maximumTemporaryIndexBytes < 1048576)
      throw new RangeError('maximumTemporaryIndexBytes must be at least 1048576')
    bound(options.streamedStructured.maximumIndexMembers, 2000000000, 'maximumIndexMembers')
    if (storage.dbtype !== 'SQLite' || !isOwnedNativeSqlite(storage.knex))
      throw new Error('BRC-38 structured source requires a genuinely owned native SQLite provider')
  }
  if (options.streamedText !== undefined) {
    bound(options.streamedText.maximumTextBytes, 1000000000, 'maximumTextBytes')
    if (storage.dbtype !== 'SQLite' || !isOwnedNativeSqlite(storage.knex))
      throw new Error('BRC-38 scalar TEXT requires its genuinely owned native source')
  }
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey)) throw new TypeError('Compressed profile identity required')
  options.signal?.throwIfAborted()
  return options
}

async function resolveCertificateFinderTies(
  storage: StorageKnex,
  view: RetainedReadSnapshot,
  userId: number,
  active: () => void,
  group: SourceRow[]
): Promise<void> {
  if (storage.dbtype !== 'SQLite') return
  active()
  await view.read(async trx => {
    const k = storage.toDb(trx),
      original = storage.findCertificateFieldsQuery({ partial: { userId } }).toSQL(),
      plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + original.sql, original.bindings)
    // The unpaged finder is one table scan. Its chosen index (including
    // custom index direction/collation), or its rowid scan, determines the
    // stable order before the legacy locale sort. Do not fetch its payload.
    if (plan.length !== 1 || typeof plan[0].detail !== 'string' || plan[0].detail.length > 1024)
      throw new Error('Unsupported BRC-38 certificate finder plan')
    const indexed = /^(SCAN|SEARCH) certificate_fields USING (?:COVERING )?INDEX (.+)$/.exec(plan[0].detail)
    if (indexed === null && plan[0].detail !== 'SCAN certificate_fields')
      throw new Error('Unsupported BRC-38 certificate finder order')
    let indexName: string | undefined
    if (indexed !== null) {
      indexName = indexed[2]
      if (indexed[1] === 'SEARCH') {
        // Conditions follow the final " ("; an index name itself may
        // contain spaces, parentheses and quotes. Knex quotes it below.
        const suffix = indexName.lastIndexOf(' (')
        if (suffix < 1 || !indexName.endsWith(')')) throw new Error('Unsupported BRC-38 certificate finder index')
        indexName = indexName.slice(0, suffix)
      }
    }
    const table =
      indexName === undefined
        ? k.raw('?? NOT INDEXED', ['certificate_fields'])
        : k.raw('?? INDEXED BY ??', ['certificate_fields', indexName])
    const ordinals: Array<{ ordinal: string }> = await k
      .select(k.raw('cast(?? as text) as ??', ['certificate_fields._rowid_', 'ordinal']))
      .from(table)
      .where({ userId, certificateId: group[0].row.certificateId })
      .limit(group.length + 1)
    if (ordinals.length !== group.length) throw new Error('BRC-38 certificate finder membership changed')
    const ranks = new Map<bigint, bigint>()
    for (const [index, item] of ordinals.entries()) {
      if (typeof item.ordinal !== 'string' || !/^-?\d{1,19}$/.test(item.ordinal))
        throw new Error('Invalid BRC-38 certificate finder identity')
      const id = BigInt(item.ordinal)
      if (ranks.has(id)) throw new Error('Duplicate BRC-38 certificate finder identity')
      ranks.set(id, BigInt(index))
    }
    for (const source of group) {
      const rank = source.ordinal === undefined ? undefined : ranks.get(source.ordinal)
      if (rank === undefined) throw new Error('BRC-38 certificate finder identity changed')
      source.ordinal = rank
    }
    active()
  })
}

async function verifySourceNativeContext(
  storage: StorageKnex,
  identityKey: string,
  options: Readonly<Brc38KnexSourceOptions>,
  header: Awaited<ReturnType<typeof readKnexSnapshotArchiveHeader>>,
  userId: number,
  active: () => void,
  k: Knex,
  table?: WalletSnapshotTable
): Promise<void> {
  active()
  if (!isOwnedNativeSqlite(k)) throw new Error('BRC-38 source native owner changed')
  const protocol: Array<{ abi: number }> = await k.raw('SELECT brc38_text_read_protocol() AS abi')
  if (
    protocol.length !== 1 ||
    !brc38NativeTextProtocolSupports('provenTxReqs', protocol[0].abi) ||
    !brc38NativeTextProtocolSupports('syncStates', protocol[0].abi) ||
    (options.streamedText !== undefined &&
      table !== undefined &&
      Object.hasOwn(brc38StreamedTextFields, table) &&
      !brc38NativeTextProtocolSupports(table as Brc38NativeTextRead['table'], protocol[0].abi))
  )
    throw new Error('BRC-38 native TEXT producer protocol differs')
  const now = await readKnexSnapshotArchiveHeader(storage, identityKey, k)
  if (
    now.header.sourceSchema !== header.header.sourceSchema ||
    now.header.user.userId !== userId ||
    now.header.user.identityKey !== identityKey ||
    now.header.user.activeStorage !== header.header.user.activeStorage ||
    now.header.sourceStorage.storageIdentityKey !== header.header.sourceStorage.storageIdentityKey ||
    now.header.sourceStorage.chain !== storage.chain ||
    now.header.sourceStorage.dbtype !== 'SQLite'
  )
    throw new Error('BRC-38 actual retained profile/schema/primary/network differs')
  active()
}

/** Coherent SQL source. Supply a dedicated reader provider so an idle
 * file consumer does not occupy the foreground/writer pool. All metadata,
 * closure checks and thirteen keyset streams own the same retained transaction.
 * Portable order may need different SQL indexes; no performance or capability
 * claim is made by constructing this source. SQLite locale ties retain the
 * original finder scan order; other provider collation still requires qualification. */
export async function openBrc38KnexSource(
  storage: StorageKnex,
  identityKey: string,
  selected: Brc38KnexSourceOptions
): Promise<Brc38StreamSource> {
  const options = ownSourceOptions(storage, identityKey, selected)
  const view: RetainedReadSnapshot = await storage.openReadSnapshot(options)
  let closed: Promise<void> | undefined,
    revoked = false,
    reading = false,
    currentRow: object | undefined
  const sourceOperations = new Set<Promise<unknown>>(),
    indexes = new Set<Brc38NodeJsonIndex>()
  const retainedIndexCleanup = new Set<Brc38StagingCleanupError>()
  const active = () => {
    options.signal?.throwIfAborted()
    if (revoked || !view.isOpen) throw new Error('BRC-38 source is closed or expired')
  }
  const sourceOperation = async <T>(run: () => Promise<T>): Promise<T> => {
    active()
    if (sourceOperations.size !== 0) throw new Error('BRC-38 source extent/index operation already owns admission')
    const operation = run()
    sourceOperations.add(operation)
    try {
      return await operation
    } finally {
      sourceOperations.delete(operation)
    }
  }
  const release = (): Promise<void> => {
    revoked = true
    currentRow = undefined
    closed ??= (async () => {
      await Promise.allSettled(sourceOperations)
      const failures: unknown[] = []
      // Snapshot the admitted cleanup cohort before awaiting its mutable owners.
      for (const cleanup of Array.from(retainedIndexCleanup)) {
        try {
          await cleanup.retryCleanup()
          retainedIndexCleanup.delete(cleanup)
        } catch (error) {
          failures.push(error)
        }
      }
      for (const index of Array.from(indexes)) {
        try {
          await index.close()
          indexes.delete(index)
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await closeSnapshotJournalSource(view, options.signal)
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'BRC-38 source physical cleanup failed')
    })()
    void closed.catch(() => {
      closed = undefined
    })
    return closed
  }
  try {
    const header = await view.read(trx => readKnexSnapshotArchiveHeader(storage, identityKey, storage.toDb(trx)))
    const userId = header.header.user.userId
    // Closure uses the exact same direct profile predicates as the portable
    // reader; auxiliary-index membership cannot conceal an exported orphan.
    const closure = () => view.read(trx => assertKnexSnapshotArchiveClosure(storage.toDb(trx), userId))
    await closure()
    const metadataPolicy = {
      maximumAllocationBytes: options.maximumMetadataAllocationBytes ?? 65536,
      signal: options.signal
    }
    const sourceStorage = projectBrc38PackedRow('sourceStorage', header.header.sourceStorage, metadataPolicy)
    const user = projectBrc38PackedRow('user', header.header.user, metadataPolicy)
    if (user.identityKey !== identityKey || sourceStorage.chain !== storage.chain)
      throw new Error('BRC-38 source profile or network changed')
    const context: PageContext = { storage, userId, options }
    const resolveCertificateTies = (group: SourceRow[]) =>
      resolveCertificateFinderTies(storage, view, userId, active, group)
    const completed = new Set<WalletSnapshotTable>()
    const snapshotId = Utils.toHex(Random(32))
    const binaryReader = createKnexWalletSnapshotBinaryReader(storage, userId, snapshotId, view)
    const nativeContext = (k: Knex, table?: WalletSnapshotTable) =>
      verifySourceNativeContext(storage, identityKey, options, header, userId, active, k, table)
    async function* rawRows(table: WalletSnapshotTable) {
      let after: readonly (number | string)[] | undefined,
        done = false
      const pages = {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          if (done) return { done: true as const, value: undefined }
          active()
          const result = await view.read(async trx => {
            const k = storage.toDb(trx)
            if (options.streamedStructured !== undefined || options.streamedText !== undefined)
              await nativeContext(k, table)
            const result = await page(context, k, table, after)
            if (options.streamedStructured !== undefined || options.streamedText !== undefined)
              await nativeContext(k, table)
            return result
          })
          done = result.done
          if (!done && result.after === undefined) throw new Error('BRC-38 source failed to advance')
          after = result.after
          return { done: false as const, value: result }
        }
      }
      for await (const result of pages) yield* result.rows
    }
    return Object.freeze({
      sourceStorage,
      user,
      ...(options.streamedBinary === undefined &&
      options.streamedStructured === undefined &&
      options.streamedText === undefined
        ? {}
        : {
            async *streamedRows(table: WalletSnapshotTable): AsyncGenerator<Brc38StreamedRow> {
              const schema = definition(table)
              active()
              if (reading || completed.has(table))
                throw new Error('BRC-38 source requires one complete read of each table')
              reading = true
              try {
                // Only scalar certificate fields need the original locale/tie order.
                // The same grouping bound and stable SQLite ordinal stay intact.
                const entries =
                  table === 'certificateFields'
                    ? groupedEntries(rawRows(table), options.maximumCertificateGroupBytes, resolveCertificateTies)
                    : rawRows(table)
                for await (const source of entries) {
                  const token = {}
                  currentRow = token
                  const cursor: WalletSnapshotCursor = {
                    version: 1,
                    snapshotId,
                    table,
                    after: position(source.row, storageKeys[table] ?? schema.keys)
                  }
                  const read = async (
                    column: WalletSnapshotBinaryColumn,
                    total: number,
                    offset: number,
                    length: number
                  ) => {
                    active()
                    if (!reading || currentRow !== token || !view.isOpen)
                      throw new Error('BRC-38 binary reference is outside its owned row lifetime')
                    if (length > (options.streamedBinary!.maximumExtentBytes ?? 65536))
                      throw new SnapshotResourceLimitError('BRC-38 binary extent exceeds its source policy')
                    const bytes = await binaryReader.readBinaryCell(table, cursor, column, offset, length, total)
                    options.signal?.throwIfAborted()
                    if (!reading || currentRow !== token) throw new Error('BRC-38 binary row lifetime changed')
                    return bytes
                  }
                  const descriptors: Record<string, Brc38StreamedBinary> = Object.create(null)
                  for (const [field, length] of Object.entries(source.binaries ?? {})) {
                    const column = field as WalletSnapshotBinaryColumn,
                      hash = new SHA256()
                    const extent = options.streamedBinary!.maximumExtentBytes ?? 65536
                    let work = 0
                    for (let offset = 0; offset < length; offset += extent) {
                      const count = Math.min(extent, length - offset)
                      const bytes = detachBrc38PrivateChunk(await read(column, length, offset, count), count)
                      if (bytes.byteLength !== count) throw new Error('BRC-38 binary digest pass was truncated')
                      hash.update(Array.from(bytes)) // One bounded extent, not a whole-field expansion.
                      work += count
                      if (work >= 65536) {
                        work = 0
                        await new Promise<void>(resolve => setTimeout(resolve, 0))
                      }
                    }
                    descriptors[field] = Object.freeze({
                      length,
                      sha256: toHex(hash.digest()),
                      read: (offset: number, size: number) => sourceOperation(() => read(column, length, offset, size))
                    })
                  }
                  const json: Record<string, Brc38StreamedStructured> = Object.create(null),
                    rowIndexes = new Set<Brc38NodeJsonIndex>()
                  for (const [name, length] of Object.entries(source.structured ?? {})) {
                    const field = name as Brc38NativeTextRead['field'],
                      nativeTable = table as Brc38NativeTextRead['table'],
                      rowId = source.nativeRowId
                    if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId))
                      throw new Error('BRC-38 structured source lost its actual physical row identifier')
                    let indexOpened = false
                    const checkRow = () => {
                      active()
                      if (!reading || currentRow !== token)
                        throw new Error('BRC-38 structured reference is outside its owned row lifetime')
                    }
                    const readText = (offset: number, size: number) =>
                      sourceOperation(async () => {
                        checkRow()
                        const bytes = await view.read(async trx => {
                          const k = storage.toDb(trx)
                          await nativeContext(k)
                          const bytes = await readBrc38NativeTextExtent(
                            k as Knex.Transaction,
                            { table: nativeTable, field, rowId, totalBytes: length, offset, length: size },
                            options.signal
                          )
                          await nativeContext(k)
                          return bytes
                        })
                        checkRow()
                        return bytes
                      })
                    const hash = new SHA256()
                    for (let offset = 0; offset < length; offset += 65536) {
                      const count = Math.min(65536, length - offset),
                        bytes = await readText(offset, count)
                      hash.update(bytes)
                      await new Promise<void>(resolve => setTimeout(resolve, 0))
                    }
                    json[field] = Object.freeze({
                      encoding: 'utf8' as const,
                      length,
                      sha256: hash.digestHex(),
                      read: readText,
                      openIndex: () =>
                        sourceOperation(async () => {
                          checkRow()
                          if (indexOpened)
                            throw new Error('BRC-38 structured descriptor already issued its temporary index')
                          indexOpened = true
                          await view.read(trx => nativeContext(storage.toDb(trx)))
                          // Filesystem I/O occurs outside the SQL read callback.
                          let index: Brc38NodeJsonIndex
                          try {
                            index = await Brc38NodeJsonIndex.open({
                              privateParent: options.streamedStructured!.privateIndexParent,
                              sourceBytes: length,
                              maximumTemporaryFileBytes: options.streamedStructured!.maximumTemporaryIndexBytes,
                              maximumTemporaryPhysicalBytes: options.streamedStructured!.maximumTemporaryIndexBytes,
                              maximumMembers: options.streamedStructured!.maximumIndexMembers,
                              expiresAt: view.expiresAt,
                              signal: options.signal
                            })
                          } catch (error) {
                            if (error instanceof Brc38StagingCleanupError) retainedIndexCleanup.add(error)
                            throw error
                          }
                          indexes.add(index)
                          rowIndexes.add(index)
                          try {
                            checkRow()
                            await view.read(trx => nativeContext(storage.toDb(trx)))
                            checkRow()
                            return index
                          } catch (error) {
                            try {
                              await index.close()
                              indexes.delete(index)
                              rowIndexes.delete(index)
                            } catch (error_) {
                              throw new AggregateError(
                                [error, error_],
                                'BRC-38 structured index opening and cleanup failed',
                                { cause: error }
                              )
                            }
                            throw error
                          }
                        })
                    })
                  }
                  const texts: Record<string, Brc38StreamedText> = Object.create(null)
                  for (const [name, length] of Object.entries(source.texts ?? {})) {
                    const field = name as Brc38NativeTextRead['field'],
                      rowId = source.nativeRowId
                    if (!Number.isSafeInteger(rowId))
                      throw new Error('Native scalar TEXT lost its original physical row')
                    const readText = (offset: number, count: number): Promise<Uint8Array> =>
                        sourceOperation(async () => {
                          active()
                          if (
                            !reading ||
                            currentRow !== token ||
                            !Number.isSafeInteger(offset) ||
                            !Number.isSafeInteger(count) ||
                            offset < 0 ||
                            count < 0 ||
                            count > 16384 ||
                            offset > length - count
                          )
                            throw new Error('Original scalar TEXT read differs from its active row/window')
                          return await view.read(async trx => {
                            const k = storage.toDb(trx)
                            await nativeContext(k, table)
                            const input = { table: table as Brc38NativeTextRead['table'], field, rowId: rowId! }
                            if ((await readBrc38NativeTextBytes(k as Knex.Transaction, input)) !== length)
                              throw new Error('Original native scalar TEXT length changed')
                            const bytes =
                              count === 0
                                ? new Uint8Array(0)
                                : await readBrc38NativeTextExtent(
                                    k as Knex.Transaction,
                                    { ...input, totalBytes: length, offset, length: count },
                                    options.signal
                                  )
                            try {
                              await nativeContext(k, table)
                              active()
                              return bytes
                            } catch (cause) {
                              bytes.fill(0)
                              throw cause
                            }
                          })
                        }),
                      hash = new SHA256()
                    if (length === 0) await readText(0, 0)
                    for (let offset = 0; offset < length; offset += 16384) {
                      const bytes = await readText(offset, Math.min(16384, length - offset))
                      try {
                        hash.update(bytes)
                      } finally {
                        bytes.fill(0)
                      }
                      await new Promise<void>(resolve => setTimeout(resolve, 0))
                    }
                    texts[field] = Object.freeze({ encoding: 'utf8', length, sha256: hash.digestHex(), read: readText })
                  }
                  let rowFailure: { cause: unknown } | undefined
                  const rowCleanup = new Brc38CleanupScope(async () => {
                    currentRow = undefined
                    const failures: unknown[] = []
                    for (const index of rowIndexes) {
                      try {
                        await index.close()
                        indexes.delete(index)
                      } catch (error) {
                        failures.push(error)
                      }
                    }
                    if (failures.length !== 0)
                      throw new AggregateError(
                        [...(rowFailure === undefined ? [] : [rowFailure.cause]), ...failures],
                        'BRC-38 structured row index cleanup failed'
                      )
                  })
                  try {
                    yield {
                      fields: source.row,
                      binaries: descriptors,
                      ...(Object.keys(json).length === 0 ? {} : { structured: json }),
                      ...(Object.keys(texts).length === 0 ? {} : { texts })
                    }
                  } catch (cause) {
                    rowFailure = { cause }
                    await rowCleanup.close()
                    throw cause
                  } finally {
                    await rowCleanup.close()
                  }
                }
                completed.add(table)
              } finally {
                currentRow = undefined
                reading = false
              }
            }
          }),
      async *rows(table: WalletSnapshotTable) {
        definition(table)
        active()
        if (
          options.streamedBinary !== undefined ||
          options.streamedStructured !== undefined ||
          options.streamedText !== undefined
        )
          throw new Error('BRC-38 extent source requires streamedRows')
        if (reading || completed.has(table)) throw new Error('BRC-38 source requires one complete read of each table')
        reading = true
        try {
          const rows = rawRows(table)
          if (table === 'certificateFields')
            yield* grouped(rows, options.maximumCertificateGroupBytes, resolveCertificateTies)
          else for await (const source of rows) yield source.row
          completed.add(table)
        } finally {
          reading = false
        }
      },
      async validateCompleted() {
        if (reading || completed.size !== 13) throw new Error('BRC-38 source tables did not complete')
        active()
        await closure()
      },
      release
    })
  } catch (error) {
    try {
      await release()
    } catch (error_) {
      if (error_ === error) throw error
      throw new AggregateError([error, error_], 'BRC-38 source opening and physical cleanup failed', { cause: error })
    }
    throw error
  }
}
