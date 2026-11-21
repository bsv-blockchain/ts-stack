import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PrivateLocalBaselineRow } from './Brc38PrivateLocalBaselineRowNode'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { hasBrc38NativePackedSchema, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import { readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'
import { readBrc38NativePackedTextDescriptor } from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

const binary = Object.freeze([
  { id: 0, table: 'transactions', key: 'transactionId', fields: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'] },
  { id: 1, table: 'proven_txs', key: 'provenTxId', fields: ['rawTx', 'merklePath'] },
  { id: 2, table: 'proven_tx_reqs', key: 'provenTxReqId', fields: ['rawTx', 'inputBEEF'] },
  { id: 3, table: 'outputs', key: 'outputId', fields: ['lockingScript'] },
  { id: 4, table: 'commissions', key: 'commissionId', fields: ['lockingScript'] }
])
function invalid(): never {
  throw new Error('Private local packed row differs from its complete metadata, fields or actual writer')
}
function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((byte, index) => byte === b[index])
  return Object.is(a, b)
}
/** Row/pointer storage primitive only. The complete-candidate controller MUST
 * independently prove original/current source epoch, durable progress and
 * primary fencing in this same writer and atomically record its receipt.
 * This helper never grants semantic admission from prepared descriptor DATA.
 * No source callback or large whole field is evaluated inside the writer. */
export async function writeBrc38PrivateLocalPackedRow(
  store: KnexBrc38StagingStore,
  k: Knex.Transaction,
  row: Readonly<Brc38PrivateLocalBaselineRow>,
  lifetimes: Brc38PrivateDerivedTextLifetimes,
  selected: Readonly<{ expiresAt: number; workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>
): Promise<void> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    table = row.table,
    rowId = row.rowId,
    expiresAt = selected.expiresAt,
    signal = selected.signal
  if (working === undefined || !brc38NativeLocalBaselineTables.includes(table) || !Number.isSafeInteger(rowId))
    invalid()
  const check = (): void => {
    store.assertPrivateNativeWriteTransaction(k)
    lifetimes.assert(store, working, expiresAt, signal)
  }
  check()
  const charge = working.claim(131072)
  let post: Record<string, unknown> | undefined,
    savepoint = false
  try {
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (
      !(await hasBrc38NativeLocalPackedLayout(k)) ||
      !(await hasBrc38NativePackedSchema(k)) ||
      !(await hasBrc38NativePackedTextSchema(k))
    )
      invalid()
    const sources = [
        ...binary
          .filter(source => source.table === table)
          .map(source => ({ ...source, first: 0, kind: 'binary' as const })),
        ...nativePackedTextSources
          .filter(source => source.sql === table)
          .map(source => ({ ...source, table: source.sql, kind: 'text' as const })),
        ...brc38NativeLocalPackedSources
          .filter(source => source.table === table)
          .map(source => ({ ...source, first: 0 }))
      ],
      expected = sources.flatMap(source =>
        source.fields.map((field, ordinal) => ({ field, source, fieldId: source.first + ordinal }))
      ),
      columns = (await k.raw(
        'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 129',
        [table]
      )) as Array<{ name: string | null }>
    if (
      columns.length < 1 ||
      columns.length > 128 ||
      columns.some(column => typeof column.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.name)) ||
      row.fields.length !== expected.length ||
      expected.some(
        field =>
          row.fields.filter(
            value => value.field === field.field && value.kind === (field.source.kind === 'binary' ? 'blob' : 'text')
          ).length !== 1
      )
    )
      invalid()
    const names = columns.map(column => column.name!),
      metadataNames = names.filter(name => !expected.some(field => field.field === name))
    if (
      Object.keys(row.metadata).length !== metadataNames.length ||
      metadataNames.some(name => !Object.hasOwn(row.metadata, name)) ||
      expected.some(field => !names.includes(field.field))
    )
      invalid()
    let bytes = 4096
    for (const name of metadataNames) {
      const descriptor = Object.getOwnPropertyDescriptor(row.metadata, name)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid()
      const value: unknown = descriptor.value
      if (typeof value === 'string') bytes += 8 * value.length + 256
      else if (value instanceof Uint8Array) bytes += 8 * value.length + 256
      else if (value !== null && typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isFinite(value)))
        invalid()
      else bytes += 256
      if (bytes > 4194304) invalid()
    }
    charge.resize(131072 + 8 * bytes)
    const main: Record<string, unknown> = { ...row.metadata, rowid: BigInt(rowId) }
    for (const field of row.fields) {
      if (
        (field.bytes !== null &&
          (!Number.isSafeInteger(field.bytes) ||
            field.bytes < 0 ||
            field.bytes > 1000000000 ||
            typeof field.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(field.sha256))) ||
        (field.bytes === null && field.sha256 !== undefined)
      )
        invalid()
      main[field.field] = field.bytes === null ? null : field.kind === 'blob' ? Buffer.alloc(0) : ''
    }
    check()
    await k.raw('SAVEPOINT __brc38_local_packed_row')
    savepoint = true
    // Release old row references before marker-only metadata replacement.
    for (const source of sources) {
      const prior = (await k(table)
        .whereRaw('rowid=?', [rowId])
        .select(source.key)
        .limit(2)
        .options({ safeIntegers: true })) as Array<Record<string, unknown>>
      if (prior.length > 1) invalid()
      if (prior.length === 1)
        await k(source.kind === 'binary' ? nativePackedTables.fields : nativePackedTextTables.fields)
          .where({ tableId: source.id, rowId: prior[0][source.key] })
          .delete()
    }
    await k(table).insert(main).onConflict('rowid').merge(main)
    check()
    for (const field of expected) {
      const descriptor = row.fields.find(value => value.field === field.field)!,
        source = field.source,
        key = source.key === 'rowid' ? BigInt(rowId) : main[source.key]
      if (typeof key !== 'bigint' || key < -9007199254740991n || key > 9007199254740991n) invalid()
      if (descriptor.bytes !== null)
        await k(source.kind === 'binary' ? nativePackedTables.fields : nativePackedTextTables.fields).insert({
          tableId: source.id,
          rowId: key,
          fieldId: field.fieldId,
          sha256: descriptor.sha256
        })
      const coordinate = {
          table:
            source.kind === 'binary'
              ? source.table === 'proven_txs'
                ? 'provenTxs'
                : source.table === 'proven_tx_reqs'
                  ? 'provenTxReqs'
                  : source.table
              : (nativePackedTextSources.find(value => value.sql === source.table)?.table ?? source.table),
          field: field.field,
          rowId: Number(key)
        },
        actual =
          source.kind === 'binary'
            ? await readBrc38NativePackedDescriptor(k, coordinate as Brc38NativePackedBinaryCoordinate)
            : await readBrc38NativePackedTextDescriptor(k, coordinate as Brc38NativePackedTextCoordinate)
      if (
        descriptor.bytes === null
          ? actual !== undefined
          : actual?.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256
      )
        invalid()
    }
    const rows = (await k(table)
      .whereRaw('rowid=?', [rowId])
      .select([...metadataNames, k.raw('rowid AS __physicalRowId')])
      .limit(2)
      .options({ safeIntegers: true })) as Array<Record<string, unknown>>
    if (rows.length !== 1) invalid()
    post = rows[0]
    if (post.__physicalRowId !== BigInt(rowId) || metadataNames.some(name => !equal(post![name], row.metadata[name])))
      invalid()
    check()
    await k.raw('RELEASE __brc38_local_packed_row')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_local_packed_row')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_local_packed_row')
        } catch (error) {
          cleanup.push(error)
        }
    }
    if (cleanup.length !== 0)
      throw new AggregateError([cause, ...cleanup], 'Local packed row retains actual writer cleanup', { cause })
    throw cause
  } finally {
    for (const value of Object.values(post ?? {})) if (value instanceof Uint8Array) value.fill(0)
    charge.close()
  }
}
