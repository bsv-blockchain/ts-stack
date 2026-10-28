import {
  snapshotJournalDeltaSources as sources,
  type SnapshotJournalSqlSource as Source,
  driver,
  columns,
  materialization,
  fieldColumns,
  fieldLength,
  scalarCharge,
  ownCells,
  packedFieldDigest
} from './SnapshotJournalFieldSql'
import { readBrc38NativeTextExtent } from '../../portable/Brc38NativeTextReadNode'
import { type Brc38NativeBlobRead, type Brc38NativeTextRead } from '../../portable/Brc38NativeBlobProtocol'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalRevisionOperand } from './SnapshotJournalRevisionSql'
import type {
  SnapshotJournalFieldDescriptor,
  SnapshotJournalFieldPage,
  SnapshotJournalFieldDelta
} from './SnapshotJournalFieldTypes'
import {
  readBrc38NativeBinaryExtent,
  isBrc38NativeBinaryReadTransaction
} from '../../portable/Brc38NativeBinaryReadNode'
import {
  isBrc38NativePackedWalletTable,
  brc38NativePackedWalletRowCharge,
  hydrateBrc38NativePackedWalletRows
} from '../../portable/Brc38NativePackedWalletNode'
import {
  isBrc38NativePackedTextWalletTable,
  brc38NativePackedTextWalletRowCharge,
  prechargeBrc38NativePackedTextWalletRows,
  hydrateBrc38NativePackedTextWalletRows
} from '../../portable/Brc38NativePackedTextWalletNode'
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

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or inconsistent snapshot journal delta source')
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

function logicalCharge(
  k: Knex,
  source: Source,
  fields: string[],
  mysql: boolean,
  mode: Awaited<ReturnType<typeof materialization>>
) {
  const base =
    mode.packed && isBrc38NativePackedWalletTable(source.name)
      ? brc38NativePackedWalletRowCharge(k, source.name, fields, 2, 64)
      : k.raw(
          '(' +
            fields
              .map(() => '2*coalesce(' + (mysql ? 'octet_length(??)' : 'length(cast(?? as blob))') + ',0)+64')
              .join('+') +
            ')',
          fields.map(field => source.name + '.' + field)
        )
  return k.raw('? AS __deltaBytes', [
    mode.text && isBrc38NativePackedTextWalletTable(source.name)
      ? brc38NativePackedTextWalletRowCharge(k as Knex.Transaction, source.name, fields, base)
      : base
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
    mode: Awaited<ReturnType<typeof materialization>> | undefined,
    payloadBytes = 0,
    examined = 0,
    after = interval.after
  for (const entry of metadata.rows) {
    const key = values(source, entry)
    const member = interval.stream === 'scope' || (await snapshotJournalPhysicalMember(k, interval, entry, mysql))
    let rowBytes = 0
    if (member && entry.present) {
      fields ??= await columns(k, source, mysql)
      mode ??= await materialization(k, source)
      const sizes: Array<{ __deltaBytes: unknown }> = await pointQuery(k, source, interval.userId, key, mysql, indexes)
        .select(logicalCharge(k, source, fields, mysql, mode))
        .limit(2)
      if (sizes.length !== 1 || sizes[0].__deltaBytes === null) return invalid()
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
        if (mode === undefined) invalid()
        if (mode.text && isBrc38NativePackedTextWalletTable(source.name))
          await prechargeBrc38NativePackedTextWalletRows(k, source.name, rows)
        if (mode.packed && isBrc38NativePackedWalletTable(source.name))
          await hydrateBrc38NativePackedWalletRows(k, source.name, rows)
        if (mode.text && isBrc38NativePackedTextWalletTable(source.name))
          await hydrateBrc38NativePackedTextWalletRows(k, source.name, rows)
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

/** Bounded metadata from the SAME actual pinned source as its journal prefix.
 * Deferred binary/TEXT never crosses the driver in this call. Native logical
 * lengths and stored digest DATA refer to packed content, not empty SQL markers.
 * This page is explicitly NOT a complete financial delta frame or an ACK. */
export async function readSnapshotJournalFieldPage(
  k: Knex,
  input: SnapshotJournalInterval,
  maximumMetadataBytes = 262144,
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<SnapshotJournalFieldPage> {
  const mysql = driver(k),
    indexes = snapshotJournalSourceIndexes(k, inputIndexes)
  if (!Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 1 || maximumMetadataBytes > 16777216)
    invalid()
  const interval = { ...input, ...(input.after === undefined ? {} : { after: { ...input.after } }) }
  snapshotJournalMetadataQuery(k, interval)
  const source = sources[interval.tableId]
  if (source === undefined) invalid()
  const metadata = await readSnapshotJournalMetadataPage(k, interval),
    changes: SnapshotJournalFieldDelta[] = []
  let names: string[] | undefined,
    mode: Awaited<ReturnType<typeof materialization>> | undefined,
    metadataBytes = 0,
    fieldBytes = 0,
    examined = 0,
    after = interval.after
  for (const entry of metadata.rows) {
    const member = interval.stream === 'scope' || (await snapshotJournalPhysicalMember(k, interval, entry, mysql))
    let bytes = 256 + 2 * Buffer.byteLength(entry.exactText, 'utf8'),
      selection: ReturnType<typeof fieldColumns> | undefined
    if (member && entry.present) {
      names ??= await columns(k, source, mysql)
      mode ??= await materialization(k, source)
      selection = fieldColumns(source, names)
      const small = names.filter(name => !selection!.deferred.includes(name))
      const sizes: Array<{ bytes: unknown }> = await pointQuery(
        k,
        source,
        interval.userId,
        values(source, entry),
        mysql,
        indexes
      )
        .select(k.raw('? AS bytes', [scalarCharge(k, source, small, mysql)]))
        .limit(2)
      if (sizes.length !== 1 || sizes[0].bytes === null) invalid()
      const amount = Number(sizes[0].bytes)
      if (!Number.isSafeInteger(amount) || amount < 0) invalid()
      bytes += amount + 256 * selection.deferred.length
    }
    if (!Number.isSafeInteger(bytes) || metadataBytes + bytes > maximumMetadataBytes) {
      if (examined === 0) throw new SnapshotResourceLimitError('Journal field metadata exceeds maxBytes')
      break
    }
    if (member) {
      if (!entry.present) changes.push({ metadata: { ...entry }, present: false })
      else {
        if (names === undefined || mode === undefined || selection === undefined) invalid()
        const small = names.filter(name => !selection!.deferred.includes(name))
        const rows: Array<Record<string, unknown>> = await pointQuery(
          k,
          source,
          interval.userId,
          values(source, entry),
          mysql,
          indexes
        )
          .select(
            ...small.map(name => source.name + '.' + name),
            ...selection.deferred.map((field, index) =>
              k.raw('? AS ??', [
                fieldLength(k, source, field, selection!.binary(field), mode!, mysql),
                '__journalFieldLength_' + index
              ])
            ),
            ...(isBrc38NativeBinaryReadTransaction(k) ? [k.raw('??.rowid AS __journalFieldRowId', [source.name])] : [])
          )
          .limit(2)
        if (rows.length !== 1) invalid()
        const raw = rows[0],
          row = ownCells(raw, small),
          fields: Record<string, SnapshotJournalFieldDescriptor> = Object.create(null)
        if (source.keys.some((key, index) => row[key] !== values(source, entry)[index])) invalid()
        for (const [index, field] of selection.deferred.entries()) {
          const value = raw['__journalFieldLength_' + index]
          if (value === null) {
            row[field] = null
            continue
          }
          const length = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
          if (!Number.isSafeInteger(length) || length < 0 || length > 1000000000) invalid()
          const binary = selection.binary(field),
            sha256 = await packedFieldDigest(k, source, field, binary, mode, raw, length)
          fields[field] = Object.freeze({
            kind: binary ? 'binary' : 'utf8',
            bytes: length,
            ...(sha256 === undefined ? {} : { sha256 })
          })
          fieldBytes += length
          if (!Number.isSafeInteger(fieldBytes)) invalid()
        }
        changes.push({ metadata: { ...entry }, present: true, row: Object.freeze(row), fields: Object.freeze(fields) })
      }
    }
    metadataBytes += bytes
    examined++
    after = position(entry)
  }
  return {
    table: source.table,
    changes,
    examined,
    metadataBytes,
    fieldBytes,
    complete: examined === metadata.rows.length && metadata.complete,
    ...(after === undefined ? {} : { after: { ...after } })
  }
}

/** A coordinate/digest is DATA. This helper still needs the caller's genuine
 * retained transaction, actual interval/generation/index validation and profile.
 * Exact current journal membership and logical field length precede allocation. */
export async function readSnapshotJournalFieldExtent(
  k: Knex,
  input: SnapshotJournalInterval,
  selected: SnapshotJournalMetadata,
  field: string,
  offset: number,
  length: number,
  descriptor: Readonly<SnapshotJournalFieldDescriptor>,
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<Uint8Array> {
  const mysql = driver(k),
    indexes = snapshotJournalSourceIndexes(k, inputIndexes),
    interval = { ...input, after: undefined, limit: 2 },
    source = sources[interval.tableId]
  snapshotJournalMetadataQuery(k, interval)
  if (
    source === undefined ||
    typeof field !== 'string' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 65536 ||
    !Number.isSafeInteger(descriptor.bytes) ||
    descriptor.bytes < 0 ||
    descriptor.bytes > 1000000000 ||
    offset > descriptor.bytes - length ||
    selected.present !== true ||
    !Number.isSafeInteger(selected.id1) ||
    selected.id1 < (interval.tableId === 7 ? -Number.MAX_SAFE_INTEGER : 1) ||
    !Number.isSafeInteger(selected.id2) ||
    selected.id2 < 0 ||
    typeof selected.exactText !== 'string' ||
    Buffer.byteLength(selected.exactText) > 400 ||
    (descriptor.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(descriptor.sha256))
  )
    invalid()
  const revision = snapshotJournalRevision(selected.revision)
  const records: Array<Record<string, unknown>> = await snapshotJournalMetadataQuery(k, interval)
    .where({
      'j.id1': selected.id1,
      'j.id2': selected.id2,
      'j.exactText': mysql ? Buffer.from(selected.exactText) : selected.exactText
    })
    .where('j.revision', snapshotJournalRevisionOperand(k, revision))
    .limit(2)
  const actual = records[0]
  if (
    records.length !== 1 ||
    ![1, true].includes(actual.present as number | boolean) ||
    snapshotJournalRevision(actual.revisionText) !== revision ||
    (interval.stream === 'physical'
      ? snapshotJournalRevision(actual.generationText) !== selected.generation ||
        !(await snapshotJournalPhysicalMember(k, interval, selected, mysql))
      : selected.generation !== undefined)
  )
    invalid()
  const names = await columns(k, source, mysql),
    selection = fieldColumns(source, names),
    mode = await materialization(k, source)
  if (!selection.deferred.includes(field) || descriptor.kind !== (selection.binary(field) ? 'binary' : 'utf8'))
    invalid()
  const binary = selection.binary(field),
    native = isBrc38NativeBinaryReadTransaction(k)
  const query = () => pointQuery(k, source, interval.userId, values(source, selected), mysql, indexes)
  const rows: Array<Record<string, unknown>> = await query()
    .select(
      ...source.keys.map(name => source.name + '.' + name),
      k.raw('? AS __length', [fieldLength(k, source, field, binary, mode, mysql)]),
      ...(native ? [k.raw('??.rowid AS __journalFieldRowId', [source.name])] : [])
    )
    .limit(2)
  if (rows.length !== 1 || rows[0].__length === null || Number(rows[0].__length) !== descriptor.bytes) invalid()
  const digest = await packedFieldDigest(k, source, field, binary, mode, rows[0], descriptor.bytes)
  if (descriptor.sha256 !== undefined && descriptor.sha256 !== digest) invalid()
  // SQLite substr(empty BLOB,1,0) returns SQL NULL. An exact zero window
  // still rechecks actual membership, type, logical length and digest above.
  if (length === 0) return new Uint8Array(0)
  if (native) {
    const rowId = rows[0].__journalFieldRowId
    if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
    const data = { table: source.table, field, rowId, offset, totalBytes: descriptor.bytes, length }
    const bytes = binary
      ? await readBrc38NativeBinaryExtent(k, data as Brc38NativeBlobRead)
      : await readBrc38NativeTextExtent(k as Knex.Transaction, data as Brc38NativeTextRead)
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
    return bytes
  }
  const expression = mysql
    ? binary
      ? 'CAST(?? AS BINARY)'
      : 'CAST(CONVERT(?? USING utf8mb4) AS BINARY)'
    : 'CAST(?? AS BLOB)'
  const values_: Array<{ bytes: unknown }> = await query()
    .select(k.raw('substr(' + expression + ',?,?) AS bytes', [source.name + '.' + field, offset + 1, length]))
    .limit(2)
  if (values_.length !== 1 || !(values_[0].bytes instanceof Uint8Array) || values_[0].bytes.byteLength !== length)
    invalid()
  return new Uint8Array(values_[0].bytes)
}
