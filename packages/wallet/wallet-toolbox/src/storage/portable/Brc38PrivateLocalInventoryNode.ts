import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource, type Brc38NativeLocalBaselineRow } from './Brc38NativeLocalBaselineSourceNode'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { brc38NativeLocalPackedSources } from './Brc38NativeLocalPackedLayout'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { readBrc38NativePackedDescriptor, readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'
import { readBrc38NativePackedTextDescriptor, readBrc38NativePackedTextExtent } from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import {
  SNAPSHOT_JOURNAL_SHARED_QUOTA,
  SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT,
  SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT,
  verifySnapshotJournalSharedQuota
} from '../snapshot/journal/SnapshotJournalSharedQuota'
import { verifySnapshotJournalDestinationSchema } from '../snapshot/journal/SnapshotJournalDestinationSchema'
import { inspectBrc38PrivateProofInventory, type Brc38PrivateProofInventory } from './Brc38PrivateProofInventoryNode'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'

const binary = Object.freeze({
  transactions: 'transactionId',
  proven_txs: 'provenTxId',
  proven_tx_reqs: 'provenTxReqId',
  outputs: 'outputId',
  commissions: 'commissionId'
})
function invalid(): never {
  throw new Error(
    'Private local baseline inventory differs from actual source metadata, keys, logical bytes or relationships'
  )
}
function equal(left: unknown, right: unknown): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array
    ? left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    : Object.is(left, right)
}
function coordinate(row: Readonly<Brc38NativeLocalBaselineRow>, field: string, kind: 'blob' | 'text') {
  const local = brc38NativeLocalPackedSources.find(value => value.table === row.table && value.fields.includes(field)),
    text = nativePackedTextSources.find(
      value => value.sql === row.table && (value.fields as readonly string[]).includes(field)
    ),
    key = local?.key ?? (kind === 'text' ? text?.key : binary[row.table as keyof typeof binary]),
    id = key === 'rowid' ? BigInt(row.rowId) : key === undefined ? undefined : row.metadata[key]
  if (
    typeof id !== 'bigint' ||
    id < -9007199254740991n ||
    id > 9007199254740991n ||
    (local !== undefined && (local.kind === 'binary' ? 'blob' : 'text') !== kind)
  )
    invalid()
  return {
    table:
      local?.table ??
      text?.table ??
      (row.table === 'proven_txs' ? 'provenTxs' : row.table === 'proven_tx_reqs' ? 'provenTxReqs' : row.table),
    field,
    rowId: Number(id)
  }
}
/** Full baseline comparison before incoming merge effects, on one retained
 * actual source view and one actual candidate read transaction. It makes no
 * READY record and grants no publication/current-primary admission. Point
 * hashes and prior comparison receipts cannot substitute for actual bytes. */
export interface Brc38PrivateLocalInventoryPolicy {
  readonly maximumRows: number
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
export async function inspectBrc38PrivateLocalBaseline(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<Brc38PrivateLocalInventoryPolicy>
): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
  return await inspectTables(store, source, k, selected, brc38NativeLocalBaselineTables, true)
}
const incomingTables = new Set<string>([
  'users',
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'commissions',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'sync_states'
])
/** The fixed 34 local recovery families: 32 remain unchanged, while two
 * prepared-cache families follow independently reconstructed proof effects.
 * Full source/candidate keys, metadata, physical markers and logical bytes are
 * compared again after import. Shared quota is independently recounted from
 * all preserved auxiliary rows and per-reference logical payload bytes. Core
 * merged rows require their separate checks; this never grants READY. */
export async function inspectBrc38PrivateLocalRecovery(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<Brc38PrivateLocalInventoryPolicy>
): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
  const tables = brc38NativeLocalBaselineTables.filter(table => !incomingTables.has(table))
  if (tables.length !== 34) invalid()
  store.assertPrivateNativeReadTransaction(k)
  const recovery = await readBrc38PrivateMergeRecovery(k)
  if (recovery?.phase !== 'IMPORT' || recovery.activeImportId === null) invalid()
  const inputs = (await k('brc38_import_journal')
    .where({ importId: recovery.activeImportId })
    .select(k.raw('CASE WHEN length(CAST(admissionJson AS BLOB)) BETWEEN 1 AND 4096 THEN admissionJson END AS json'))
    .limit(2)) as Array<{ json: string | null }>
  if (inputs.length !== 1 || typeof inputs[0].json !== 'string') invalid()
  const admission = JSON.parse(inputs[0].json) as Brc38ImportJournalAdmission,
    receipt = await readBrc38ImportJournal(k, admission, selected.workingAllocation)
  if (
    admission.scope.importId !== recovery.activeImportId ||
    receipt.state !== 'COMPLETE' ||
    receipt.nextRow !== admission.totalRows
  )
    invalid()
  const effects = await inspectBrc38PrivateProofInventory(store, source, k, {
    admission,
    maximumRows: selected.maximumRows,
    maximumReadBytes: selected.maximumReadBytes,
    workingAllocation: selected.workingAllocation,
    signal: selected.signal
  })
  return await inspectTables(store, source, k, selected, tables, true, effects)
}
async function inspectTables(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<Brc38PrivateLocalInventoryPolicy>,
  tables: readonly Brc38NativeLocalBaselineTable[],
  compareSharedQuota: boolean,
  cacheEffects?: Readonly<Brc38PrivateProofInventory>
): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    maximumRows = selected.maximumRows,
    width = selected.maximumReadBytes,
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    expiresAt !== store.operationExpiresAt ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384
  )
    invalid()
  const check = (): void => {
      signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline) invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    },
    frame = working.claim(2097152)
  let rows = 0,
    logicalBytes = 0n,
    sharedRows = 0,
    sharedBytes = 0n
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (!(await hasBrc38NativeLocalPackedLayout(k))) invalid()
    await verifySnapshotJournalDestinationSchema(k)
    for (const table of tables) {
      let after: number | null = null
      for (;;) {
        check()
        const fromSource = await Brc38NativeLocalBaselineSource.ownedPage(source, table, after, 1),
          query = k(table).select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
        if (after !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(after).toString()])
        const actualKeys = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (fromSource.length !== actualKeys.length || actualKeys.length > 1) invalid()
        if (fromSource.length === 0) break
        if (actualKeys[0].physical !== BigInt(fromSource[0]) || ++rows > maximumRows) invalid()
        const rowId = fromSource[0]
        await Brc38NativeLocalBaselineSource.withOwnedRow(source, table, rowId, async row => {
          check()
          let expectedMetadata = row.metadata
          if (cacheEffects !== undefined && table === 'prepared_beef_metadata') {
            if (
              rowId !== 1 ||
              row.metadata.preparedBeefMetadataId !== 1n ||
              typeof row.metadata.proofEpoch !== 'bigint' ||
              row.metadata.proofEpoch < 0n ||
              row.metadata.proofEpoch + BigInt(cacheEffects.cacheInvalidations) > 9007199254740991n
            )
              invalid()
            expectedMetadata = Object.freeze({
              ...row.metadata,
              proofEpoch: row.metadata.proofEpoch + BigInt(cacheEffects.cacheInvalidations)
            })
          }
          if (
            cacheEffects !== undefined &&
            table === 'prepared_beefs' &&
            row.metadata.state === 'ready' &&
            cacheEffects.cacheInvalidations !== 0
          ) {
            if (cacheEffects.cacheUpdatedAt === null) invalid()
            expectedMetadata = Object.freeze({
              ...row.metadata,
              state: 'stale',
              formatVersion: 0n,
              updated_at: cacheEffects.cacheUpdatedAt
            })
          }
          const names = Object.keys(row.metadata),
            fullNames = [...names, ...row.fields.map(field => field.field)],
            columns = (await k.raw(
              'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,"notnull" AS required FROM pragma_table_info(?) ORDER BY cid LIMIT 129',
              [table]
            )) as Array<{ name: string | null; required: number }>
          if (
            columns.length !== fullNames.length ||
            columns.length > 128 ||
            columns.some(column => column.name === null || !fullNames.includes(column.name)) ||
            new Set(fullNames).size !== fullNames.length
          )
            invalid()
          const extents = (await k(table)
            .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
            .select(
              k.raw(
                '(' +
                  names
                    .map(
                      () =>
                        "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                    )
                    .join('+') +
                  ') AS bytes',
                names.flatMap(name => [name, name])
              )
            )
            .limit(2)) as Array<{ bytes: number }>
          if (
            extents.length !== 1 ||
            !Number.isSafeInteger(extents[0].bytes) ||
            extents[0].bytes < 0 ||
            extents[0].bytes > 131072
          )
            invalid()
          const metadataCharge = working.claim(131072 + 32 * extents[0].bytes)
          let metadata: Record<string, unknown> | undefined
          try {
            const values = (await k(table)
              .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
              .select(names)
              .limit(2)
              .options({ safeIntegers: true })) as Array<Record<string, unknown>>
            if (values.length !== 1) invalid()
            metadata = values[0]
            if (names.some(name => !equal(metadata![name], expectedMetadata[name]))) invalid()
            for (const field of row.fields) {
              check()
              const pointer = coordinate(row, field.field, field.kind),
                markers = (await k(table)
                  .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
                  .select(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [field.field, field.field]))
                  .limit(2)) as Array<{ kind: string; bytes: number | null }>,
                descriptor =
                  field.kind === 'blob'
                    ? await readBrc38NativePackedDescriptor(k, pointer as Brc38NativePackedBinaryCoordinate)
                    : await readBrc38NativePackedTextDescriptor(k, pointer as Brc38NativePackedTextCoordinate)
              if (
                markers.length !== 1 ||
                (field.bytes === null
                  ? markers[0].kind !== 'null' || descriptor !== undefined
                  : markers[0].kind !== field.kind || markers[0].bytes !== 0 || descriptor?.bytes !== field.bytes)
              )
                invalid()
              if (field.bytes === null) continue
              const hash = createHash('sha256')
              for (let offset = 0; offset < field.bytes;) {
                const length = Math.min(width, field.bytes - offset),
                  allocation = working.claim(1048576 + 32 * length)
                let bytes: Uint8Array | undefined
                try {
                  bytes =
                    field.kind === 'blob'
                      ? await readBrc38NativePackedExtent(
                          k,
                          {
                            ...(pointer as Brc38NativePackedBinaryCoordinate),
                            offset,
                            length,
                            totalBytes: field.bytes
                          },
                          signal
                        )
                      : await readBrc38NativePackedTextExtent(
                          k,
                          { ...(pointer as Brc38NativePackedTextCoordinate), offset, length, totalBytes: field.bytes },
                          signal
                        )
                  const actual = bytes
                  await row.withFieldExtent(field.field, offset, length, async original => {
                    check()
                    if (!equal(actual, original)) invalid()
                    hash.update(actual)
                  })
                } finally {
                  bytes?.fill(0)
                  allocation.close()
                }
                offset += length
              }
              if (hash.digest('hex') !== descriptor!.sha256) invalid()
              logicalBytes += BigInt(field.bytes)
            }
            if (table.startsWith('snapshot_reconciliation_')) {
              // Exact destination DDL was freshly checked above. Its quota
              // triggers charge NOT NULL columns at four times SQLite's own
              // cast byte length, plus4096 per actual auxiliary row. Packed
              // payload markers are empty; add their already fully compared
              // logical lengths PER REFERENCE, including reused content.
              if (columns.some(column => column.required !== 0 && column.required !== 1)) invalid()
              const charged = columns.filter(column => column.required === 1).map(column => column.name!)
              if (charged.length === 0 || charged.length > 32) invalid()
              const values = (await k(table)
                .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
                .select(
                  k.raw(
                    '4096+' + charged.map(() => '4*coalesce(length(CAST(?? AS BLOB)),0)').join('+') + ' AS bytes',
                    charged
                  )
                )
                .limit(2)) as Array<{ bytes: number }>
              if (values.length !== 1 || !Number.isSafeInteger(values[0].bytes) || values[0].bytes < 4096) invalid()
              sharedBytes += BigInt(values[0].bytes)
              for (const field of row.fields)
                if (charged.includes(field.field) && field.bytes !== null) sharedBytes += 4n * BigInt(field.bytes)
              if (
                ++sharedRows > SNAPSHOT_JOURNAL_SHARED_ROW_LIMIT ||
                sharedBytes > BigInt(SNAPSHOT_JOURNAL_SHARED_BYTE_LIMIT)
              )
                invalid()
            }
          } finally {
            for (const value of Object.values(metadata ?? {})) if (value instanceof Uint8Array) value.fill(0)
            metadataCharge.close()
          }
        })
        after = rowId
      }
    }
    if (compareSharedQuota)
      await Brc38NativeLocalBaselineSource.withOwnedJournalQuota(source, async original => {
        check()
        await verifySnapshotJournalSharedQuota(k)
        const values = (await k(SNAPSHOT_JOURNAL_SHARED_QUOTA)
          .where({ id: 0 })
          .select(k.raw('CAST(bytes AS TEXT) AS bytes'), 'rows')
          .limit(2)) as Array<{ bytes: string; rows: number }>
        if (
          values.length !== 1 ||
          values[0].bytes !== original.bytes ||
          values[0].rows !== original.rows ||
          values[0].bytes !== sharedBytes.toString() ||
          values[0].rows !== sharedRows
        )
          invalid()
      })
    const foreign = (await k.raw('SELECT 1 AS differs FROM pragma_foreign_key_check LIMIT 1')) as Array<{
      differs: number
    }>
    if (foreign.length !== 0) invalid()
    check()
    return Object.freeze({ rows, logicalBytes: logicalBytes.toString() })
  } finally {
    frame.close()
  }
}
