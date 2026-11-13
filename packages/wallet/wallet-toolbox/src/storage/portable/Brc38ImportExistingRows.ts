import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import {
  hasBrc38NativePackedSchema,
  requireBrc38PackedWriter,
  requireBrc38PackedRead
} from './Brc38NativePackedSchemaNode'
import { brc38NativePackedLength, readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { readBrc38NativePackedTextDescriptor } from './Brc38NativePackedTextFieldsNode'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import type { Brc38NativeBlobRead, Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { isBrc38NativeBinaryReadTransaction, readBrc38NativeBinaryRange } from './Brc38NativeBinaryReadNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38ImportRowTypes, Brc38PreparedImportData } from './Brc38ImportPage'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import {
  brc38ImportTargetIndexes,
  brc38ImportTargetIndexName,
  verifyBrc38ImportTargetIndexes
} from './Brc38ImportTargetIndexes'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { runInSeries } from '../../utility/runInSeries'

export type Brc38ImportExistingRow = {
  [K in Brc38StageTable]: {
    readonly table: K
    readonly row?: Readonly<Brc38ImportRowTypes[K]>
    readonly allocationBytes: number
  }
}[Brc38StageTable]
interface Form {
  readonly id?: string
  readonly booleans?: string[]
  readonly dates?: string[]
}
const forms: Readonly<Record<Brc38StageTable, Form>> = {
  provenTxs: { id: 'provenTxId' },
  outputBaskets: { id: 'basketId', booleans: ['isDeleted'] },
  outputTags: { id: 'outputTagId', booleans: ['isDeleted'] },
  txLabels: { id: 'txLabelId', booleans: ['isDeleted'] },
  transactions: { id: 'transactionId', booleans: ['isOutgoing'] },
  outputs: { id: 'outputId', booleans: ['spendable', 'change'] },
  txLabelMaps: { booleans: ['isDeleted'] },
  outputTagMaps: { booleans: ['isDeleted'] },
  certificates: { id: 'certificateId', booleans: ['isDeleted'] },
  certificateFields: {},
  commissions: { id: 'commissionId', booleans: ['isRedeemed'] },
  provenTxReqs: { id: 'provenTxReqId', booleans: ['notified', 'wasBroadcast'] },
  syncStates: { id: 'syncStateId', booleans: ['init'], dates: ['when'] }
}
function invalid(): never {
  throw new Error('Private import existing row differs from its prepared indexed identity')
}
function limit(): never {
  throw new SnapshotResourceLimitError('Private import existing payload exceeds its fixed allocation budget')
}
function query(trx: Knex.Transaction, target: Brc38ImportEntityTarget): Knex.QueryBuilder {
  const [table, keys] = brc38ImportTargetIndexes[target.index]
  if (
    brc38ImportTargetIndexes[target.table][0] !== table ||
    Object.keys(target.key).length !== keys.length ||
    keys.some(key => !Object.hasOwn(target.key, key))
  )
    invalid()
  return trx
    .from(trx.raw('?? INDEXED BY ??', [table, brc38ImportTargetIndexName(target.index, trx)]))
    .where(target.key)
    .limit(2)
}
async function columns(trx: Knex.Transaction, table: string): Promise<string[]> {
  const rows: Array<{ name: string }> = await trx.raw(
    'SELECT CASE WHEN length(CAST(name AS BLOB)) BETWEEN 1 AND 128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 65',
    [table]
  )
  if (rows.length < 1 || rows.length > 64 || rows.some(row => typeof row.name !== 'string')) invalid()
  return rows.map(row => row.name)
}
/** Conservative native Buffer plus legacy number[]/string normalization charge.
 * This is an allocation policy, not BRC-38 serialized length or a disk quota. */
function charge(trx: Knex.Transaction, names: readonly string[]): Knex.Raw {
  return trx.raw(`(${names.map(() => '16 * COALESCE(length(CAST(?? AS BLOB)), 0) + 256').join(' + ')})`, [...names])
}
async function rowMetadata(
  trx: Knex.Transaction,
  target: Brc38ImportEntityTarget,
  names: readonly string[],
  remaining: number
): Promise<number | undefined> {
  const id = forms[target.table].id,
    rows: Array<{ allocationBytes: number; localId: number }> = await query(trx, target).select(
      trx.raw('CASE WHEN ? <= ? THEN ? END AS allocationBytes', [charge(trx, names), remaining, charge(trx, names)]),
      id === undefined
        ? trx.raw('1 AS localId')
        : trx.raw("CASE WHEN typeof(??) = 'integer' AND ?? BETWEEN ? AND ? THEN ?? END AS localId", [
            id,
            id,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            id
          ])
    )
  if (rows.length !== (target.found ? 1 : 0)) invalid()
  if (rows.length === 0) return undefined
  if ((id === undefined && target.localId !== undefined) || (id !== undefined && rows[0].localId !== target.localId))
    invalid()
  const bytes = rows[0].allocationBytes
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) limit()
  return bytes
}
interface RawSelection {
  readonly txid: string
  readonly offset?: number
  readonly length?: number
}
function requireSlice(value: RawSelection): void {
  if (
    value.offset !== undefined &&
    (!/^[0-9a-f]{64}$/i.test(value.txid) ||
      !Number.isSafeInteger(value.offset) ||
      !Number.isSafeInteger(value.length) ||
      value.offset < 0 ||
      (value.length as number) < 0 ||
      !Number.isSafeInteger(value.offset + (value.length as number)))
  )
    throw new WERR_INVALID_PARAMETER(
      'txid, offset and length',
      'a hexadecimal transaction id and non-negative safe slice integers with a safe sum'
    )
}
function rawQuery(trx: Knex.Transaction, index: 'provenTxs' | 'provenTxReqs', value: RawSelection): Knex.QueryBuilder {
  const [table] = brc38ImportTargetIndexes[index],
    selected = trx
      .from(trx.raw('?? INDEXED BY ??', [table, brc38ImportTargetIndexName(index, trx)]))
      .where({ txid: value.txid })
      .limit(2)
  if (index === 'provenTxReqs')
    void selected.whereIn(
      'status',
      value.offset === undefined
        ? ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed']
        : ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail']
    )
  return selected
}
async function rawCandidate(
  trx: Knex.Transaction,
  index: 'provenTxs' | 'provenTxReqs',
  value: RawSelection,
  remaining: number,
  signal?: AbortSignal
): Promise<{ found: boolean; rawTx?: number[]; allocationBytes: number }> {
  const packed = isBrc38NativeBinaryReadTransaction(trx) && (await hasBrc38NativePackedSchema(trx)),
    size = packed ? brc38NativePackedLength(trx, { table: index, field: 'rawTx' }) : trx.raw('length(rawTx)'),
    extent =
      value.offset === undefined
        ? size
        : trx.raw('MIN(MAX(? - ?, 0), ?)', [size, value.offset, value.length as number]),
    rows: Array<{ bytes: number | null }> = await rawQuery(trx, index, value).select(
      trx.raw(
        "CASE WHEN rawTx IS NULL THEN NULL WHEN typeof(rawTx) <> 'blob' THEN -2 WHEN 16 * ? + 256 <= ? THEN 16 * ? + 256 ELSE -1 END AS bytes",
        [extent, remaining, extent]
      )
    )
  if (rows.length > 1) invalid()
  if (rows.length === 0 || rows[0].bytes === null) return { found: rows.length !== 0, allocationBytes: 0 }
  const bytes = rows[0].bytes
  if (bytes === -2) invalid()
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) limit()
  signal?.throwIfAborted()
  if (isBrc38NativeBinaryReadTransaction(trx)) {
    const actual = (await rawQuery(trx, index, value).select(
        trx.raw('rowid AS rowId,? AS totalBytes', [size])
      )) as Array<{ rowId: number; totalBytes: number }>,
      amount = (bytes - 256) / 16
    if (actual.length !== 1 || !Number.isSafeInteger(amount) || amount < 0) invalid()
    const rawTx =
      amount === 0
        ? new Uint8Array(0)
        : await readBrc38NativeBinaryRange(
            trx,
            {
              table: index,
              field: 'rawTx',
              rowId: actual[0].rowId,
              offset: value.offset ?? 0,
              totalBytes: actual[0].totalBytes,
              length: amount
            },
            amount,
            signal
          )
    return { found: true, rawTx: Array.from(rawTx), allocationBytes: bytes }
  }
  const expression =
      value.offset === undefined
        ? 'rawTx'
        : trx.raw('substr(rawTx, ?, ?)', [(value.offset as number) + 1, value.length as number]),
    payload: Array<{ rawTx: Buffer }> = await rawQuery(trx, index, value).select({
      rawTx: expression
    })
  if (payload.length !== 1 || !Buffer.isBuffer(payload[0].rawTx)) invalid()
  return { found: true, rawTx: Array.from(payload[0].rawTx), allocationBytes: bytes }
}
async function knownRawTx(
  trx: Knex.Transaction,
  value: RawSelection,
  remaining: number,
  signal?: AbortSignal
): Promise<{ rawTx?: number[]; allocationBytes: number }> {
  requireSlice(value)
  const proven = await rawCandidate(trx, 'provenTxs', value, remaining, signal)
  // Preserve the existing full-raw and slice paths' distinct request statuses
  // and proof-null fallback rules. No proof parser or unbounded provider read.
  if (proven.rawTx !== undefined || (value.offset === undefined && proven.found)) return proven
  signal?.throwIfAborted()
  return await rawCandidate(trx, 'provenTxReqs', value, remaining, signal)
}
async function reconstruct(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  row: Record<string, unknown>,
  remaining: number,
  signal?: AbortSignal
): Promise<number> {
  if (typeof row.txid !== 'string' || row.txid === '') return 0
  let value: RawSelection, field: string
  if (table === 'transactions' && row.rawTx === undefined) {
    value = { txid: row.txid }
    field = 'rawTx'
  } else if (
    table === 'outputs' &&
    typeof row.scriptOffset === 'number' &&
    typeof row.scriptLength === 'number' &&
    row.scriptOffset !== 0 &&
    row.scriptLength !== 0 &&
    (!Array.isArray(row.lockingScript) || row.lockingScript.length !== row.scriptLength)
  ) {
    value = { txid: row.txid, offset: row.scriptOffset, length: row.scriptLength }
    field = 'lockingScript'
  } else return 0
  const result = await knownRawTx(trx, value, remaining, signal)
  if (result.rawTx !== undefined) row[field] = result.rawTx
  return result.allocationBytes
}
/** Actual query-only pinned destination preparation before writer acquisition.
 * Every native row and reconstruction dependency is charged in SQL before its
 * payload reaches JS. Full legacy row normalization is retained. This helper
 * does not apply entities, authorize activation, or establish physical quotas. */
export async function prepareBrc38ImportExistingRows(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  data: Brc38PreparedImportData,
  targets: readonly Brc38ImportEntityTarget[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportExistingRow[]> {
  if (data.kind === 'header') {
    await requireReadOwner(trx, userId, maximumAllocationBytes, signal)
    if (targets.length !== 0) invalid()
    return Object.freeze([])
  }
  if (data.rows.length !== targets.length) invalid()
  return await prepareBrc38ImportExistingTargets(
    trx,
    storage,
    userId,
    data.table,
    targets,
    maximumAllocationBytes,
    signal
  )
}
async function requireReadOwner(
  trx: Knex.Transaction,
  userId: number,
  maximum: number,
  signal?: AbortSignal
): Promise<void> {
  requireBrc38ImportSqliteTransaction(trx)
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16777216)
    throw new RangeError('Invalid fixed private import existing payload allocation budget')
  if (!Number.isSafeInteger(userId)) invalid()
  signal?.throwIfAborted()
  const mode: Array<{ query_only: number }> = await trx.raw('PRAGMA query_only')
  if (mode.length !== 1 || mode[0].query_only !== 1)
    throw new Error('Private import existing payload preparation requires query-only ownership')
  await verifyBrc38ImportTargetIndexes(trx)
}
/** Same bounded native payload reader for an already selected secondary key. */
export async function prepareBrc38ImportExistingTargets(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  table: Brc38StageTable,
  targets: readonly Brc38ImportEntityTarget[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportExistingRow[]> {
  await requireReadOwner(trx, userId, maximumAllocationBytes, signal)
  if (targets.length > 4096) invalid()
  const names = await columns(trx, brc38ImportTargetIndexes[table][0]),
    prepared: Brc38ImportExistingRow[] = []
  let remaining = maximumAllocationBytes
  await runInSeries(targets, async target => {
    signal?.throwIfAborted()
    if (target.table !== table || (Object.hasOwn(target.key, 'userId') && target.key.userId !== userId)) invalid()
    const bytes = await rowMetadata(trx, target, names, remaining)
    if (bytes === undefined) {
      prepared.push(Object.freeze({ table, allocationBytes: 0 }))
      return
    }
    remaining -= bytes
    signal?.throwIfAborted()
    const rows: Array<Record<string, unknown> & { created_at: Date; updated_at: Date }> = await query(
      trx,
      target
    ).select(names)
    if (rows.length !== 1) invalid()
    const form = forms[table],
      row = { ...storage.validateEntity(rows[0], form.dates, form.booleans) },
      extra = await reconstruct(trx, table, row, remaining, signal)
    remaining -= extra
    for (const field of Object.keys(row)) if (Array.isArray(row[field])) Object.freeze(row[field])
    prepared.push(
      Object.freeze({
        table,
        row: Object.freeze(row),
        allocationBytes: bytes + extra
      }) as Brc38ImportExistingRow
    )
  })
  signal?.throwIfAborted()
  return Object.freeze(prepared)
}

/** Metadata and immutable field coordinates are DATA, deliberately separate
 * from a complete Table DTO. No empty array/string stands in for an omitted
 * large field, and no SHA or descriptor grants proof/replacement authority. */
export interface Brc38ImportExistingFieldRow {
  readonly table: Brc38StageTable
  readonly metadata?: Readonly<Record<string, unknown> & { created_at: Date; updated_at: Date }>
  /** Binary native ABI uses the actual physical rowid; TEXT uses its logical key. */
  readonly binaryRowId?: number
  readonly binaries: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>
  readonly structured: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>
  readonly texts?: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>
  readonly textRowId?: number
  readonly allocationBytes: number
}
/** Actual indexed destination preparation for field-aware merge. Only bounded
 * metadata columns cross SQL; nonnull binary/TEXT markers are checked against
 * their current genuine native pointers. Reconstruction and full proof/history
 * validation belong to the subsequent retained preparation, never this read. */
export async function prepareBrc38ImportExistingFieldTargets(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  table: Brc38StageTable,
  targets: readonly Brc38ImportEntityTarget[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportExistingFieldRow[]> {
  signal?.throwIfAborted()
  if (!isBrc38NativeBinaryReadTransaction(trx) || targets.length > 4096) invalid()
  await requireReadOwner(trx, userId, maximumAllocationBytes, signal)
  return await readExistingFieldTargets(trx, storage, userId, table, targets, maximumAllocationBytes, signal)
}
async function readExistingFieldTargets(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  table: Brc38StageTable,
  targets: readonly Brc38ImportEntityTarget[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportExistingFieldRow[]> {
  const textSource = nativePackedTextSources.find(source => source.table === table)
  if (
    !(await hasBrc38NativePackedSchema(trx)) ||
    (textSource !== undefined && !(await hasBrc38NativePackedTextSchema(trx)))
  )
    invalid()
  const names = await columns(trx, brc38ImportTargetIndexes[table][0]),
    binaryNames = names.filter(name => brc38JsonBinaryField(table, name)),
    structuredNames = names.filter(name => brc38JsonStructuredField(table, name)),
    textNames = names.filter(name => textSource?.fields.some(field => field === name)),
    metadataNames = names.filter(name => !binaryNames.includes(name) && !textNames.includes(name)),
    prepared: Brc38ImportExistingFieldRow[] = [],
    form = forms[table]
  if (
    !metadataNames.includes('created_at') ||
    !metadataNames.includes('updated_at') ||
    (structuredNames.length !== 0 && form.id === undefined)
  )
    invalid()
  let remaining = maximumAllocationBytes
  await runInSeries(targets, async target => {
    signal?.throwIfAborted()
    if (target.table !== table || (Object.hasOwn(target.key, 'userId') && target.key.userId !== userId)) invalid()
    // Charge all descriptor/container/selection copies before creating them or
    // transferring metadata. Large content length never expands this charge.
    const fixed = 2048 + 1024 * (binaryNames.length + textNames.length)
    if (remaining < fixed) limit()
    const bytes = await rowMetadata(trx, target, metadataNames, remaining - fixed)
    remaining -= fixed + (bytes ?? 0)
    const binaries: Record<string, Readonly<{ bytes: number; sha256: string }>> = Object.create(null),
      structured: Record<string, Readonly<{ bytes: number; sha256: string }>> = Object.create(null),
      texts: Record<string, Readonly<{ bytes: number; sha256: string }>> = Object.create(null)
    if (bytes === undefined) {
      prepared.push(
        Object.freeze({
          table,
          binaries: Object.freeze(binaries),
          structured: Object.freeze(structured),
          texts: Object.freeze(texts),
          allocationBytes: fixed
        })
      )
      return
    }
    const rows = (await query(trx, target).select(
      ...metadataNames,
      ...(binaryNames.length + textNames.length === 0 ? [] : [trx.raw('rowid AS __brc38NativeBinaryRowId')])
    )) as Array<Record<string, unknown> & { created_at: Date; updated_at: Date }>
    if (rows.length !== 1) invalid()
    const physical = rows[0].__brc38NativeBinaryRowId
    if (binaryNames.length !== 0 && (typeof physical !== 'number' || !Number.isSafeInteger(physical) || physical < 1))
      invalid()
    delete rows[0].__brc38NativeBinaryRowId
    const metadata = { ...storage.validateEntity(rows[0], form.dates, form.booleans) }
    for (const name of binaryNames) {
      signal?.throwIfAborted()
      const value = await readBrc38NativePackedDescriptor(trx, {
        table: table as Brc38NativeBlobRead['table'],
        field: name as Brc38NativeBlobRead['field'],
        rowId: physical as number
      })
      if (value !== undefined) binaries[name] = Object.freeze({ bytes: value.bytes, sha256: value.sha256 })
    }
    const textRowId =
      textSource?.key === 'rowid' ? physical : textSource === undefined ? undefined : metadata[textSource.key]
    for (const name of textNames) {
      signal?.throwIfAborted()
      const rowId = textRowId
      if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
      const value = await readBrc38NativePackedTextDescriptor(trx, {
        table: table as Brc38NativeTextRead['table'],
        field: name as Brc38NativeTextRead['field'],
        rowId
      })
      if (value !== undefined) {
        const descriptor = Object.freeze({ bytes: value.bytes, sha256: value.sha256 })
        texts[name] = descriptor
        if (structuredNames.includes(name)) structured[name] = descriptor
      }
    }
    prepared.push(
      Object.freeze({
        table,
        metadata: Object.freeze(metadata),
        ...(binaryNames.length === 0 ? {} : { binaryRowId: physical as number }),
        ...(textSource === undefined ? {} : { textRowId: textRowId as number }),
        binaries: Object.freeze(binaries),
        structured: Object.freeze(structured),
        texts: Object.freeze(texts),
        allocationBytes: fixed + bytes
      })
    )
  })
  signal?.throwIfAborted()
  if (
    !isBrc38NativeBinaryReadTransaction(trx) ||
    !(await hasBrc38NativePackedSchema(trx)) ||
    (structuredNames.length !== 0 && !(await hasBrc38NativePackedTextSchema(trx)))
  )
    invalid()
  return Object.freeze(prepared)
}

/** Bounded current field DATA for operational native replica components. Both
 * query-only preparation and the final actual writer repeat the indexed row
 * selection, schema, marker and pointer inspection. The enclosing session
 * still owns original profile/parent/map/primary/checkpoint admission. */
export async function readBrc38NativeCurrentFieldTargets(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  table: Brc38StageTable,
  targets: readonly Brc38ImportEntityTarget[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportExistingFieldRow[]> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  requireBrc38ImportSqliteTransaction(trx)
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    targets.length > 128 ||
    !Number.isSafeInteger(maximumAllocationBytes) ||
    maximumAllocationBytes < 1 ||
    maximumAllocationBytes > 16777216
  )
    invalid()
  await verifyBrc38ImportTargetIndexes(trx)
  const rows = await readExistingFieldTargets(trx, storage, userId, table, targets, maximumAllocationBytes, signal)
  requireBrc38PackedRead(trx)
  signal?.throwIfAborted()
  return rows
}

/** Re-read the same bounded rows and actual field pointers in the genuine
 * final writer. Expected metadata is comparison DATA, never a stored verdict.
 * The enclosing controller separately locks and compares current profile,
 * generation/primary, source authentication and destination journal receipt. */
export async function assertBrc38ImportExistingFieldTargets(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  table: Brc38StageTable,
  targets: readonly Brc38ImportEntityTarget[],
  expected: readonly Brc38ImportExistingFieldRow[],
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(trx)
  requireBrc38ImportSqliteTransaction(trx)
  if (
    !Number.isSafeInteger(userId) ||
    targets.length > 4096 ||
    targets.length !== expected.length ||
    !Number.isSafeInteger(maximumAllocationBytes) ||
    maximumAllocationBytes < 1 ||
    maximumAllocationBytes > 16777216
  )
    invalid()
  await verifyBrc38ImportTargetIndexes(trx)
  const actual = await readExistingFieldTargets(trx, storage, userId, table, targets, maximumAllocationBytes, signal)
  for (const [index, row] of actual.entries()) {
    signal?.throwIfAborted()
    if (JSON.stringify(row) !== JSON.stringify(expected[index])) invalid()
  }
  requireBrc38PackedWriter(trx)
  signal?.throwIfAborted()
}
