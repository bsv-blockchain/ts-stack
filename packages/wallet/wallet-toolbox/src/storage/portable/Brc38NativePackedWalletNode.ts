import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { hasBrc38NativePackedSchema, requireBrc38PackedWriter } from './Brc38NativePackedSchemaNode'
import {
  readBrc38NativePackedDescriptor,
  writeBrc38NativePackedBytes,
  hashBrc38NativePackedVersion,
  brc38NativePackedLength,
  collectBrc38NativePackedGarbage
} from './Brc38NativePackedFieldsNode'
import { readBrc38NativeBinaryRange } from './Brc38NativeBinaryReadNode'
import type { Brc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const definitions = {
  transactions: {
    table: 'transactions',
    key: 'transactionId',
    fields: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']
  },
  proven_txs: { table: 'provenTxs', key: 'provenTxId', fields: ['rawTx', 'merklePath'] },
  proven_tx_reqs: { table: 'provenTxReqs', key: 'provenTxReqId', fields: ['rawTx', 'inputBEEF'] },
  outputs: { table: 'outputs', key: 'outputId', fields: ['lockingScript'] },
  commissions: { table: 'commissions', key: 'commissionId', fields: ['lockingScript'] }
} as const
export type Brc38NativePackedWalletTable = keyof typeof definitions
export function isBrc38NativePackedWalletTable(table: string): table is Brc38NativePackedWalletTable {
  return Object.hasOwn(definitions, table)
}
export function brc38NativePackedWalletFields(table: Brc38NativePackedWalletTable): readonly string[] {
  return definitions[table].fields
}
const maximumAllocation = 16777216
function invalid(): never {
  throw new Error('Native packed wallet field or current metadata row differs')
}
/** Absent packed schema retains the stock path. Genuine native operations use
 * one actual transaction for metadata plus binary cells, never two snapshots.
 * This chooses a producer, not a reusable source/schema/profile admission. */
export async function withBrc38NativePackedWalletTransaction<T>(
  k: Knex,
  run: (database: Knex, packed: boolean) => Promise<T>
): Promise<T> {
  if (!isOwnedNativeSqlite(k)) return await run(k, false)
  if (k.isTransaction) return await run(k, await hasBrc38NativePackedSchema(k as Knex.Transaction))
  return await k.transaction(async trx => await run(trx, await hasBrc38NativePackedSchema(trx)))
}
/** Complete bounded legacy DTOs only. Charge the eventual number-array/copy
 * allocation before payload reads. No empty physical marker escapes as data.
 * Oversize values must use the separately bounded logical extent interface. */
export async function hydrateBrc38NativePackedWalletRows<T extends object>(
  k: Knex,
  table: Brc38NativePackedWalletTable,
  rows: T[],
  completeOutputScripts = false
): Promise<T[]> {
  const trx = k as Knex.Transaction
  if (!isOwnedNativeSqlite(trx) || !(await hasBrc38NativePackedSchema(trx))) invalid()
  const spec = definitions[table],
    pending: Array<{
      row: Record<string, unknown>
      field: Brc38NativeBlobRead['field']
      rowId: number
      bytes: number
      sha256: string
    }> = []
  let allocation = 262144
  for (const entity of rows) {
    const row = entity as Record<string, unknown>,
      rowId = row[spec.key]
    if (!Number.isSafeInteger(rowId) || ((rowId as number) < 1 && !(await hasBrc38NativeLocalPackedLayout(trx))))
      invalid()
    for (const name of spec.fields) {
      if (!Object.hasOwn(row, name)) continue
      const field = name as Brc38NativeBlobRead['field'],
        value = row[field],
        actual = await readBrc38NativePackedDescriptor(trx, { table: spec.table, field, rowId: rowId as number })
      if (
        table === 'outputs' &&
        field === 'lockingScript' &&
        completeOutputScripts &&
        typeof row.scriptLength === 'number' &&
        row.scriptLength > 0 &&
        typeof row.scriptOffset === 'number' &&
        row.scriptOffset > 0 &&
        typeof row.txid === 'string' &&
        row.txid !== '' &&
        actual?.bytes !== row.scriptLength
      ) {
        if (!Number.isSafeInteger(row.scriptLength) || !Number.isSafeInteger(row.scriptOffset)) invalid()
        // Nullable/offloaded scripts and a mismatched stored script may be
        // filled from the raw transaction in this SAME retained view. Reserve
        // those result arrays across the page before reading any payload.
        allocation += 16 * row.scriptLength + 512
        if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
          throw new SnapshotResourceLimitError('Native packed script fallback exceeds its finite page allocation')
      }
      if (value == null) {
        if (actual !== undefined) invalid()
        continue
      }
      if (!(value instanceof Uint8Array) || value.byteLength !== 0 || actual === undefined) invalid()
      allocation += 16 * actual.bytes + 512
      if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
        throw new SnapshotResourceLimitError(
          'Native packed legacy DTO exceeds its finite allocation; use logical extents'
        )
      pending.push({ row, field, rowId: rowId as number, bytes: actual.bytes, sha256: actual.sha256 })
    }
  }
  for (const item of pending) {
    const value = await readBrc38NativeBinaryRange(
      trx,
      {
        table: spec.table,
        field: item.field,
        rowId: item.rowId,
        offset: 0,
        totalBytes: item.bytes,
        length: item.bytes
      },
      item.bytes
    )
    if (createHash('sha256').update(value).digest('hex') !== item.sha256) invalid()
    item.row[item.field] = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  return rows
}
/** Separate logical bytes from small SQL metadata before INSERT/UPDATE. Public
 * full-row inputs are already bounded DTOs; never accept a source callback.
 * Original null/undefined semantics and fields omitted from updates survive. */
export function prepareBrc38NativePackedWalletWrite(
  table: Brc38NativePackedWalletTable,
  input: object
): Readonly<{
  row: Record<string, unknown>
  fields: ReadonlyArray<
    Readonly<{
      field: Brc38NativeBlobRead['field']
      bytes: Uint8Array
    }>
  >
}> {
  const row = { ...input } as Record<string, unknown>,
    fields: Array<{ field: Brc38NativeBlobRead['field']; bytes: Uint8Array }> = []
  let allocation = 262144
  for (const name of definitions[table].fields) {
    if (!Object.hasOwn(row, name) || row[name] == null) continue
    const value = row[name]
    if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
    const length = value instanceof Uint8Array ? value.byteLength : value.length
    allocation += 16 * length + 512
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocation)
      throw new SnapshotResourceLimitError(
        'Native packed legacy write exceeds its finite allocation; use staged streaming'
      )
    if (Array.isArray(value) && value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) invalid()
    const bytes = new Uint8Array(value)
    fields.push({ field: name as Brc38NativeBlobRead['field'], bytes })
    row[name] = Buffer.alloc(0)
  }
  return Object.freeze({ row, fields: Object.freeze(fields) })
}
export async function finishBrc38NativePackedWalletWrite(
  k: Knex,
  table: Brc38NativePackedWalletTable,
  rowId: number,
  fields: ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields'],
  maximumCollectionChunks: 0 | 16 = 16
): Promise<void> {
  if (maximumCollectionChunks !== 0 && maximumCollectionChunks !== 16) invalid()
  requireBrc38PackedWriter(k as Knex.Transaction)
  for (const item of fields)
    await writeBrc38NativePackedBytes(
      k as Knex.Transaction,
      { table: definitions[table].table, field: item.field, rowId },
      item.bytes
    )
  // Foreground work contributes at most one 1 MiB retirement page. Metadata,
  // pointers and collection commit together; readers retain their SQLite view.
  if (maximumCollectionChunks !== 0)
    await collectBrc38NativePackedGarbage(k as Knex.Transaction, maximumCollectionChunks)
}

/** Proof CAS compares current logical bytes, including independently read
 * postimages; physical empty cells or an expected SHA alone cannot match. */
export async function matchesBrc38NativePackedWalletBytes(
  k: Knex,
  table: Brc38NativePackedWalletTable,
  rowId: number,
  expected: object
): Promise<boolean> {
  const trx = k as Knex.Transaction
  requireBrc38PackedWriter(trx)
  if (!(await hasBrc38NativePackedSchema(trx))) invalid()
  const prepared = prepareBrc38NativePackedWalletWrite(table, expected),
    spec = definitions[table],
    deadline = performance.now() + 10000
  const check = (): void => {
    requireBrc38PackedWriter(trx)
    if (performance.now() >= deadline) throw new Error('Packed native logical byte comparison expired')
  }
  for (const item of prepared.fields) {
    check()
    const actual = await readBrc38NativePackedDescriptor(trx, { table: spec.table, field: item.field, rowId }),
      sha256 = createHash('sha256').update(item.bytes).digest('hex')
    if (actual?.bytes !== item.bytes.byteLength || actual.sha256 !== sha256) return false
    if ((await hashBrc38NativePackedVersion(trx, actual.sha256, actual.bytes, check)) !== sha256) invalid()
  }
  return true
}
export async function readBrc38NativePackedWalletRawSlice(
  k: Knex,
  txid: string,
  offset: number,
  length: number
): Promise<number[] | undefined> {
  const trx = k as Knex.Transaction
  if (
    !isOwnedNativeSqlite(trx) ||
    !(await hasBrc38NativePackedSchema(trx)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  )
    invalid()
  for (const name of ['proven_txs', 'proven_tx_reqs'] as const) {
    const spec = definitions[name],
      query = trx(name).where({ txid })
    if (name === 'proven_tx_reqs')
      query.whereIn('status', ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail'])
    const rows = (await query
      .select(spec.key, trx.raw('typeof(rawTx) AS kind,length(rawTx) AS physicalBytes'))
      .limit(2)) as Array<Record<string, unknown>>
    if (rows.length > 1) invalid()
    if (rows.length === 0 || rows[0].kind === 'null') continue
    const rowId = rows[0][spec.key]
    if (
      rows[0].kind !== 'blob' ||
      rows[0].physicalBytes !== 0 ||
      typeof rowId !== 'number' ||
      !Number.isSafeInteger(rowId) ||
      (rowId < 1 && !(await hasBrc38NativeLocalPackedLayout(trx)))
    )
      invalid()
    const actual = await readBrc38NativePackedDescriptor(trx, { table: spec.table, field: 'rawTx', rowId })
    if (actual === undefined) invalid()
    const amount = Math.min(Math.max(actual.bytes - offset, 0), length)
    if (16 * amount + 262144 > maximumAllocation)
      throw new SnapshotResourceLimitError('Native packed legacy raw slice exceeds its finite allocation')
    if (amount === 0) return []
    return Array.from(
      await readBrc38NativeBinaryRange(
        trx,
        { table: spec.table, field: 'rawTx', rowId, offset, totalBytes: actual.bytes, length: amount },
        amount
      )
    )
  }
  return undefined
}

/** Source-owned logical field lengths for a freshly checked packed transaction.
 * Identifiers originate from that call's actual bounded column inventory. */
export function brc38NativePackedWalletRowCharge(
  k: Knex,
  table: Brc38NativePackedWalletTable,
  columns: readonly string[],
  multiplier: number,
  fixed: number
): Knex.Raw {
  const spec = definitions[table]
  if (columns.length < 1 || columns.length > 64 || ![2, 16].includes(multiplier) || ![64, 256, 512].includes(fixed))
    invalid()
  const binaries: Knex.Raw[] = [],
    cells = columns.map(column => {
      const binary = (spec.fields as readonly string[]).includes(column),
        length = binary
          ? brc38NativePackedLength(k as Knex.Transaction, {
              table: spec.table,
              field: column as Brc38NativeBlobRead['field']
            })
          : k.raw('length(cast(?? as blob))', [column])
      if (binary) binaries.push(length)
      return k.raw('?*coalesce(?,0)+?', [multiplier, length, fixed])
    }),
    sum = k.raw('(' + cells.map(() => '?').join('+') + ')', cells)
  return binaries.length === 0
    ? sum
    : k.raw('CASE WHEN ' + binaries.map(() => '?<0').join(' OR ') + ' THEN -1 ELSE ? END', [...binaries, sum])
}
