import { hasBrc38NativePreparedFieldsSchema, nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38WorkingAllocation, brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { hasBrc38NativePackedSchema, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { inspectBrc38NativePackedTextInventory } from './Brc38NativePackedTextInventoryNode'
import { readBrc38NativePackedDescriptor, hashBrc38NativePackedVersion } from './Brc38NativePackedFieldsNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { requireBrc38NativeProfileTransaction, requireBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import { readBrc38ImportJournal as readNativeJournal } from './Brc38NativeImportJournalNode'
import { nativeStreamedProvenance } from './Brc38NativeStreamedProvenanceNode'
import {
  verifyBrc38NativeTailLayout,
  verifyBrc38PublishedNativeTailLayout,
  verifyBrc38PublishedCopyTailLayout
} from './Brc38NativeTailLayoutNode'
import { readBrc38NativeBinaryExtent } from './Brc38NativeBinaryReadNode'
import type { Brc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import { admissionCopy } from './Brc38ImportJournalCore'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { isBrc38OwnedPrivateNativeSqlite, KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import {
  verifyBrc38ImportStreamedProvenanceSchema,
  readBrc38ImportStreamedOriginal
} from './Brc38ImportStreamedProvenanceNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlStructuredDescriptors, hasBrc38SqlStructuredSchema } from './Brc38SqlStructuredStaging'
import { readBrc38SqlTextDescriptors, hasBrc38SqlTextSchema } from './Brc38SqlTextStaging'
import { inspectBrc38TextNativeField } from './Brc38TextNativeFieldInventoryNode'
import { hasBrc38SqlCanonicalStructuredSchema } from './Brc38SqlCanonicalStructuredStaging'
import { hasBrc38SqlProjectedStructuredSchema } from './Brc38SqlProjectedStructuredStaging'
import {
  verifyBrc38ImportStructuredProvenanceSchema,
  readBrc38ImportStructuredOriginal,
  nativeStructuredProvenance
} from './Brc38ImportStructuredProvenanceNode'
import {
  inspectBrc38StructuredNativeField,
  type Brc38StructuredNativeFieldInventoryPolicy
} from './Brc38StructuredNativeFieldInventoryNode'
import { requireBrc38StructuredProjectionRead } from './Brc38PublishedStructuredSourceNode'
import { brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import {
  readBrc38NativePackedTextDescriptor,
  hashBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'
import { nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { prepareBrc38ImportHistory } from './Brc38ImportHistory'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { runInSeries } from '../../utility/runInSeries'

const tables: Readonly<Record<Brc38StageTable, string>> = {
  provenTxs: 'proven_txs',
  outputBaskets: 'output_baskets',
  outputTags: 'output_tags',
  txLabels: 'tx_labels',
  transactions: 'transactions',
  outputs: 'outputs',
  txLabelMaps: 'tx_labels_map',
  outputTagMaps: 'output_tags_map',
  certificates: 'certificates',
  certificateFields: 'certificate_fields',
  commissions: 'commissions',
  provenTxReqs: 'proven_tx_reqs',
  syncStates: 'sync_states'
}
function invalid(): never {
  throw new Error('Complete private streamed native inventory differs')
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
function hash(value: unknown, maximum: number): string {
  const result = createHash('sha256')
  for (const bytes of canonicalPortableChunks(value, { maximumValueBytes: maximum, maximumChunkBytes: 4096 }))
    result.update(bytes)
  return result.digest('hex')
}
async function count(k: Knex.Transaction, table: string, maximum: number, where?: object): Promise<number> {
  const query = k(table)
  if (where !== undefined) query.where(where)
  const value = (await query.count({ count: '*' }).first()) as { count: unknown } | undefined
  return integer(value?.count, maximum)
}
interface Budget {
  remaining: number
  used: number
  readonly reservation: Brc38WorkingCharge
}
function budget(working: Brc38WorkingAllocation): Budget {
  return { remaining: working.maximum - working.used, used: 0, reservation: working.claim(0) }
}
function charge(budget: Budget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining)
    throw new SnapshotResourceLimitError('Streamed native inventory exceeds its original row allocation allowance')
  budget.reservation.resize(budget.used + bytes)
  budget.used += bytes
  budget.remaining -= bytes
}
function transferWidth(working: Brc38WorkingAllocation, requested = 65536): number {
  // Legacy native transport also serializes its response. Admit that transient
  // representation before requesting any bytes; packed SQL uses a smaller
  // separate charge, without treating that difference as a source grant.
  const width = Math.min(requested, Math.floor((working.maximum - working.used - 2048) / 32))
  if (!Number.isSafeInteger(width) || width < 1)
    throw new SnapshotResourceLimitError('Native inventory cannot admit a transfer in its original allowance')
  return width
}
async function fields(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  maximum: number,
  budget: Budget
): Promise<PortableRow> {
  const key = { tableName: table, position },
    extent = (await k('rows')
      .where(key)
      .first('bytes', k.raw('length(CAST(payload AS BLOB)) AS actualBytes'), k.raw('typeof(payload) AS kind'))) as
      { bytes: unknown; actualBytes: unknown; kind: string } | undefined
  const bytes = integer(extent?.bytes, maximum)
  if (bytes === 0 || extent?.kind !== 'text' || extent.actualBytes !== bytes) invalid()
  charge(budget, 512 + 16 * bytes)
  const value = (await k('rows').where(key).first('payload')) as { payload: string } | undefined
  if (value === undefined || Buffer.byteLength(value.payload) !== bytes) invalid()
  return JSON.parse(value.payload) as PortableRow
}
async function blob(
  k: Knex.Transaction,
  table: Brc38NativeBlobRead['table'],
  rowId: number,
  descriptor: Brc38JsonStreamedField,
  check: () => void,
  working: Brc38WorkingAllocation,
  requestedWidth = 65536
): Promise<void> {
  const width = transferWidth(working, requestedWidth)
  const extent = (await k(tables[table])
    .whereRaw('rowid=?', [rowId])
    .first(k.raw('typeof(??) AS kind,length(??) AS bytes', [descriptor.field, descriptor.field]))) as
    { kind: string; bytes: unknown } | undefined
  if (extent?.kind !== 'blob') invalid()
  const packed = await hasBrc38NativePackedSchema(k)
  if (packed) {
    const actual = await readBrc38NativePackedDescriptor(k, {
      table,
      field: descriptor.field as Brc38NativeBlobRead['field'],
      rowId
    })
    if (extent.bytes !== 0 || actual?.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) invalid()
    if (
      (await hashBrc38NativePackedVersion(k, actual.sha256, actual.bytes, check, width, working)) !== descriptor.sha256
    )
      invalid()
    check()
    return
  } else if (integer(extent.bytes, 1000000000) !== descriptor.bytes) invalid()
  const result = createHash('sha256')
  for (let offset = 0; offset < descriptor.bytes;) {
    check()
    const amount = Math.min(width, descriptor.bytes - offset),
      scratch = working.claim(2048 + 32 * amount)
    let payload: Uint8Array | undefined
    try {
      payload = await readBrc38NativeBinaryExtent(k, {
        table,
        rowId,
        field: descriptor.field as Brc38NativeBlobRead['field'],
        offset,
        totalBytes: descriptor.bytes,
        length: amount
      })
      check()
      result.update(payload)
      offset += amount
    } finally {
      payload?.fill(0)
      scratch.close()
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (result.digest('hex') !== descriptor.sha256) invalid()
  check()
}
async function nativeMetadata(
  k: Knex.Transaction,
  table: string,
  key: object,
  names: readonly string[],
  budget: Budget
): Promise<Record<string, unknown>> {
  if (names.length < 1 || names.length > 64 || names.some(name => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))) invalid()
  const extents = (await k(table)
    .where(key)
    .select(k.raw('(' + names.map(() => 'coalesce(length(CAST(?? AS BLOB)),0)').join('+') + ') AS bytes', [...names]))
    .limit(2)) as Array<{ bytes: number }>
  if (extents.length !== 1) invalid()
  charge(budget, 512 + 512 * names.length + 16 * integer(extents[0].bytes, 16777216))
  const actual = (await k(table)
    .where(key)
    .select([...names])
    .limit(2)) as Array<Record<string, unknown>>
  if (actual.length !== 1) invalid()
  return actual[0]
}
function native(value: unknown): unknown {
  // StorageReader serializes SQLite restore dates as ISO text. Require the
  // same exact representation in both private and published-copy inventories.
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}
function textFields(table: Brc38StageTable): readonly Brc38NativeTextRead['field'][] {
  return nativePackedTextSources.find(source => source.table === table)?.fields ?? []
}
function binaryFieldNames(table: Brc38StageTable): readonly Brc38NativeBlobRead['field'][] {
  switch (table) {
    case 'provenTxs':
      return ['rawTx', 'merklePath']
    case 'provenTxReqs':
      return ['rawTx', 'inputBEEF']
    case 'transactions':
      return ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']
    case 'outputs':
    case 'commissions':
      return ['lockingScript']
    default:
      return []
  }
}
async function inlineBinary(
  k: Knex.Transaction,
  table: Brc38NativeBlobRead['table'],
  rowId: number,
  field: Brc38NativeBlobRead['field'],
  value: unknown,
  budget: Budget,
  check: () => void,
  working: Brc38WorkingAllocation,
  requestedWidth?: number
): Promise<number | undefined> {
  check()
  if (value == null) {
    const cell = (await k(tables[table])
      .whereRaw('rowid=?', [rowId])
      .first(k.raw('typeof(??) AS kind', [field]))) as { kind: string } | undefined
    if (cell?.kind !== 'null' || (await readBrc38NativePackedDescriptor(k, { table, rowId, field })) !== undefined)
      invalid()
    return undefined
  }
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
  charge(budget, 512 + 16 * value.length)
  if (Array.isArray(value) && value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) invalid()
  const bytes = Buffer.from(value),
    descriptor: Brc38JsonStreamedField = {
      field,
      encoding: field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  try {
    await blob(k, table, rowId, descriptor, check, working, requestedWidth)
    return descriptor.bytes
  } finally {
    bytes.fill(0)
  }
}
async function inlineText(
  k: Knex.Transaction,
  table: Brc38NativeTextRead['table'],
  rowId: number,
  field: Brc38NativeTextRead['field'],
  value: unknown,
  budget: Budget,
  check: () => void,
  working: Brc38WorkingAllocation,
  requestedWidth?: number
): Promise<boolean> {
  check()
  const actual = await readBrc38NativePackedTextDescriptor(k, { table, rowId, field })
  if (value == null) {
    if (actual !== undefined) invalid()
    return false
  }
  if (typeof value !== 'string') invalid()
  const bytes = Buffer.byteLength(value, 'utf8')
  charge(budget, 512 + 16 * bytes)
  const sha256 = createHash('sha256').update(value, 'utf8').digest('hex')
  if (
    actual?.bytes !== bytes ||
    actual.sha256 !== sha256 ||
    (await hashBrc38NativePackedTextVersion(
      k,
      sha256,
      bytes,
      check,
      transferWidth(working, requestedWidth),
      working
    )) !== sha256
  )
    invalid()
  check()
  return true
}
async function structuredFamily(
  k: Knex.Transaction,
  metadata: string,
  chunks: string,
  expected: number,
  maximum: number
): Promise<void> {
  const hasMetadata = await k.schema.hasTable(metadata),
    hasChunks = await k.schema.hasTable(chunks)
  if (!hasMetadata && !hasChunks) {
    if (expected !== 0) invalid()
    return
  }
  if (
    !hasMetadata ||
    !hasChunks ||
    (await count(k, metadata, maximum)) !== expected ||
    (await k(metadata).whereNot({ state: 'complete' }).select(k.raw('1 AS invalid')).limit(1)).length !== 0
  )
    invalid()
  const orphan = await k(chunks)
    .whereNotExists(
      k(metadata)
        .select(k.raw('1'))
        .whereRaw('?? = ??', [metadata + '.tableName', chunks + '.tableName'])
        .whereRaw('?? = ??', [metadata + '.position', chunks + '.position'])
        .whereRaw('?? = ??', [metadata + '.field', chunks + '.field'])
    )
    .select(k.raw('1 AS invalid'))
    .limit(1)
  if (orphan.length !== 0) invalid()
}
/** Explicit structured inventory entry. Runtime labels route only; actual
 * private/native/copy actor, exact source/layout/journal and every postimage
 * remain independently verified in this retained read-only transaction. */
export async function inspectBrc38StructuredNativeRestoreInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'private' | 'published-native' | 'published-copy',
  selectedPolicy: Brc38StructuredNativeFieldInventoryPolicy,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  if (!['private', 'published-native', 'published-copy'].includes(runtime)) invalid()
  const source = brc38PrivateStructuredPolicy(selectedPolicy.sourcePolicy),
    projection = selectedPolicy.projectionPolicy,
    operationSignal = signal ?? source.signal ?? projection.signal,
    expiresAt = selectedPolicy.inspectionExpiresAt,
    combined = selectedPolicy.maximumCombinedTemporaryBytes,
    lifetime = expiresAt - Date.now()
  if (
    (source.signal !== undefined && source.signal !== operationSignal) ||
    (projection.signal !== undefined && projection.signal !== operationSignal) ||
    !Number.isSafeInteger(expiresAt) ||
    lifetime < 1 ||
    lifetime > 3600000 ||
    projection.expiresAt !== expiresAt ||
    projection.privateParent !== source.privateIndexParent ||
    !Number.isSafeInteger(combined) ||
    combined < 3145728 ||
    combined > 17179869184 ||
    !Number.isSafeInteger(projection.maximumTemporaryFileBytes) ||
    projection.maximumTemporaryFileBytes < 2097152 ||
    projection.maximumTemporaryFileBytes > combined - source.maximumTemporaryIndexBytes ||
    !Number.isSafeInteger(projection.maximumMembers) ||
    projection.maximumMembers < 1 ||
    projection.maximumMembers > 2000000000 ||
    !Number.isSafeInteger(projection.maximumOutputBytes) ||
    projection.maximumOutputBytes < 2 ||
    projection.maximumOutputBytes > source.maximumCanonicalBytes ||
    !Number.isSafeInteger(projection.maximumScalarBytes) ||
    projection.maximumScalarBytes < 2 ||
    projection.maximumScalarBytes > 16777216 ||
    (projection.maximumReadBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumReadBytes) ||
        projection.maximumReadBytes < 64 ||
        projection.maximumReadBytes > 65536)) ||
    (projection.maximumIndexAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumIndexAllocationBytes) ||
        projection.maximumIndexAllocationBytes < 4096 ||
        projection.maximumIndexAllocationBytes > 16777216)) ||
    (projection.maximumGrammarAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumGrammarAllocationBytes) ||
        projection.maximumGrammarAllocationBytes < 4096 ||
        projection.maximumGrammarAllocationBytes > 16777216))
  )
    invalid()
  const policy = Object.freeze({
    sourcePolicy: Object.freeze({ ...source, signal: operationSignal }),
    projectionPolicy: Object.freeze({
      privateParent: projection.privateParent,
      maximumTemporaryFileBytes: projection.maximumTemporaryFileBytes,
      maximumMembers: projection.maximumMembers,
      maximumOutputBytes: projection.maximumOutputBytes,
      maximumScalarBytes: projection.maximumScalarBytes,
      maximumIndexAllocationBytes: projection.maximumIndexAllocationBytes,
      maximumGrammarAllocationBytes: projection.maximumGrammarAllocationBytes,
      workingAllocation: projection.workingAllocation,
      maximumReadBytes: projection.maximumReadBytes,
      expiresAt: projection.expiresAt,
      signal: operationSignal
    }),
    inspectionExpiresAt: selectedPolicy.inspectionExpiresAt,
    maximumCombinedTemporaryBytes: selectedPolicy.maximumCombinedTemporaryBytes,
    privateSource: selectedPolicy.privateSource
  })
  return await inspectInventory(k, selected, runtime, operationSignal, policy)
}
/** Full actual private inventory before publication. One real read-only native
 * transaction owns the coherent view; caller retains its physical lease and
 * current source/profile/schema/destination fence. No marker, digest, previous
 * match, configuration class or returned receipt can substitute for this view.
 * All13 cardinalities, metadata, mapped IDs/parents, exact original envelopes
 * and actual blob postimages are examined; no full binary crosses into JS.
 * This returns DATA only and grants no publication or activation authority. */
export async function inspectBrc38PrivateStreamedNativeInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectInventory(k, selected, 'private', signal)
}
/** READY only: the actual published-profile factory must independently retain
 * its physical/kernel/inventory/catalog/copy/current state before entry. This
 * compares the complete original postimage before any activation or new writes. */
export async function inspectBrc38ReadyPublishedStreamedNativeInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectInventory(k, selected, 'published-native', signal)
}
/** Independently copied packed bytes, retained read-only by the actual profile
 * factory. This cannot enroll a native producer, write a field or activate a
 * provider. The caller holds the kernel claim and independently checks copy
 * hashes/inodes/catalog before and after this complete content inspection. */
export async function inspectBrc38PublishedCopyStreamedInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  signal?: AbortSignal
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  return await inspectInventory(k, selected, 'published-copy', signal)
}
async function inspectInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'private' | 'published-native' | 'published-copy',
  signal?: AbortSignal,
  structured?: Readonly<Brc38StructuredNativeFieldInventoryPolicy>
): Promise<Readonly<{ rows: number; mappedIds: number; binaryBytes: number }>> {
  const requireCurrent = (): void => {
    if (runtime === 'published-native') requireBrc38NativeProfileTransaction(k)
    else if (runtime === 'published-copy') requireBrc38PublishedCopyInspection(k)
    else if (!isBrc38OwnedPrivateNativeSqlite(k)) invalid()
    if (k.isTransaction !== true) invalid()
    if (structured !== undefined) requireBrc38StructuredProjectionRead(k)
  }
  signal?.throwIfAborted()
  requireCurrent()
  const readJournal = runtime === 'published-native' ? readNativeJournal : readBrc38ImportJournal,
    verifyOriginals =
      structured === undefined
        ? runtime === 'published-native'
          ? nativeStreamedProvenance.verify
          : verifyBrc38ImportStreamedProvenanceSchema
        : runtime === 'published-native'
          ? nativeStructuredProvenance.verify
          : verifyBrc38ImportStructuredProvenanceSchema,
    readOriginal =
      structured === undefined
        ? runtime === 'published-native'
          ? nativeStreamedProvenance.read
          : readBrc38ImportStreamedOriginal
        : runtime === 'published-native'
          ? nativeStructuredProvenance.read
          : readBrc38ImportStructuredOriginal,
    originalsTable = structured === undefined ? 'brc38_import_streamed_original' : 'brc38_import_structured_original'
  const admission = admissionCopy(selected),
    limits = JSON.parse(admission.originalLimitsJson) as number[],
    expiresAt = admission.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    inspectionDeadline =
      structured === undefined
        ? undefined
        : performance.now() + Math.max(0, structured.inspectionExpiresAt - Date.now())
  if (structured !== undefined) {
    if (
      structured.projectionPolicy.maximumScalarBytes > Math.min(admission.maximumStepBytes, limits[4]) ||
      (runtime === 'private' &&
        (!(structured.privateSource instanceof KnexBrc38StagingStore) ||
          structured.inspectionExpiresAt !== admission.expiresAt)) ||
      (runtime !== 'private' && structured.privateSource !== undefined)
    )
      invalid()
    if (runtime === 'private') structured.privateSource!.assertPrivateNativeReadTransaction(k)
  }
  const supplied = brc38WorkingAllocation(
    structured?.sourcePolicy.workingAllocation ?? structured?.projectionPolicy.workingAllocation
  )
  if (
    (supplied !== undefined && supplied.maximum > limits[4]) ||
    (structured?.sourcePolicy.workingAllocation !== undefined &&
      structured.projectionPolicy.workingAllocation !== undefined &&
      structured.sourcePolicy.workingAllocation !== structured.projectionPolicy.workingAllocation)
  )
    invalid()
  const working = supplied ?? new Brc38WorkingAllocation(limits[4]),
    lifetimeAllocation = working.claim(12288)
  let retained = false
  try {
    const original = async (sourceRow: number, budget: Budget): Promise<Awaited<ReturnType<typeof readOriginal>>> => {
      const extent = (await k(originalsTable)
          .where({ ...admission.scope, sourceRow })
          .first(k.raw('length(CAST(originalJson AS BLOB)) AS bytes'))) as { bytes: unknown } | undefined,
        bytes = integer(extent?.bytes, 16777216)
      charge(budget, 512 + 16 * bytes)
      return await readOriginal(k, admission.scope, sourceRow, bytes)
    }
    const check = (): void => {
      signal?.throwIfAborted()
      structured?.sourcePolicy.signal?.throwIfAborted()
      requireCurrent()
      // The private import retains its original, nonrenewable deadline. A copied
      // RECEIVING profile enforces that same deadline through its actual factory
      // guard. A permanent READY profile is owned independently of the expired
      // import; its current read scope never revives import/write admission.
      if (runtime === 'private' && (Date.now() >= expiresAt || performance.now() >= deadline)) invalid()
      if (
        structured !== undefined &&
        (Date.now() >= structured.inspectionExpiresAt || performance.now() >= inspectionDeadline!)
      )
        invalid()
    }
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (runtime === 'published-native') await verifyBrc38PublishedNativeTailLayout(k)
    else if (runtime === 'published-copy') {
      if (!(await hasBrc38NativePackedSchema(k))) invalid()
      await verifyBrc38PublishedCopyTailLayout(k)
    } else await verifyBrc38NativeTailLayout(k)
    await verifyOriginals(k)
    if (structured !== undefined) {
      // Check definitions even when there are no descriptors to trigger a field
      // read. A partially present or altered empty family cannot be accepted.
      await hasBrc38SqlStructuredSchema(k)
      await hasBrc38SqlTextSchema(k)
      await hasBrc38SqlCanonicalStructuredSchema(k)
      if (!(await hasBrc38NativePackedTextSchema(k)) || !(await hasBrc38SqlProjectedStructuredSchema(k))) invalid()
      const receiver = await k('private_native_restore')
        .where({ slot: 1 })
        .first(k.raw("CASE WHEN protocol='brc38-private-native-restore/v5' THEN 1 ELSE 0 END AS structured"))
      if (receiver?.structured !== 1) invalid()
    }
    const receipt = await readJournal(k, admission, working)
    if (receipt.state !== 'COMPLETE' || receipt.nextRow !== admission.totalRows) invalid()
    const counts = new Map<Brc38StageTable, number>()
    let total = 0,
      mappedIds = 0,
      sourceRow = 1,
      binaryBytes = 0,
      binaryFields = 0,
      structuredFields = 0,
      projectedFields = 0,
      nativeTextFields = 0,
      scalarTextFields = 0
    await runInSeries(brc38ImportTableOrder, async table => {
      check()
      const value = (await k('table_counts').where({ tableName: table }).first('rows')) as
          { rows: unknown } | undefined,
        amount = integer(value?.rows, limits[0])
      counts.set(table, amount)
      total += amount
      if (total > limits[0] || (await count(k, tables[table], limits[0])) !== amount) invalid()
      if (brc38ImportRowForm(table).entity !== undefined) mappedIds += amount
    })
    if (
      total + 1 !== admission.totalRows ||
      mappedIds !== receipt.mappedIds ||
      (await count(k, 'brc38_import_ids', limits[0], admission.scope)) !== mappedIds ||
      (await count(k, originalsTable, limits[0] + 1, admission.scope)) !== total + 1
    )
      invalid()
    await (async () => {
      const headerBudget = budget(working)
      try {
        const headerExtent = (await k('metadata')
          .where({ slot: 1 })
          .first(k.raw('length(CAST(header AS BLOB)) AS bytes'))) as { bytes: unknown }
        charge(headerBudget, 512 + 16 * integer(headerExtent?.bytes, limits[3]))
        const bindingExtent = (await k('private_binding')
          .where({ slot: 1 })
          .first(
            k.raw("CASE WHEN typeof(bindingJson)='text' THEN length(CAST(bindingJson AS BLOB)) ELSE NULL END AS bytes")
          )) as { bytes: unknown } | undefined
        charge(headerBudget, 512 + 16 * integer(bindingExtent?.bytes, 4096))
        const metadata = (await k('metadata')
            .where({ slot: 1 })
            .first(
              'rows',
              k.raw(
                'CASE WHEN typeof(header)=? AND length(CAST(header AS BLOB))<=? THEN header ELSE NULL END AS header',
                ['text', limits[3]]
              )
            )) as { rows: unknown; header: string | null } | undefined,
          binding = (await k('private_binding')
            .where({ slot: 1 })
            .first(
              'digest',
              k.raw('CASE WHEN length(CAST(bindingJson AS BLOB))<=4096 THEN bindingJson ELSE NULL END AS bindingJson')
            )) as { digest: string; bindingJson: string | null } | undefined
        if (
          metadata?.rows !== total ||
          typeof metadata.header !== 'string' ||
          binding?.digest !== admission.scope.bindingSha256 ||
          typeof binding.bindingJson !== 'string'
        )
          invalid()
        const bound = JSON.parse(binding.bindingJson) as {
            archiveSha256: string
            identityKey: string
            targetStorageIdentityKey: string
            chain: string
          },
          settingsExtent = (await k('settings')
            .select(
              k.raw(
                "CASE WHEN typeof(chain)='text' AND typeof(storageIdentityKey)='text' AND length(CAST(chain AS BLOB))<=8 AND length(CAST(storageIdentityKey AS BLOB))<=256 THEN length(CAST(chain AS BLOB))+length(CAST(storageIdentityKey AS BLOB)) ELSE NULL END AS bytes"
              )
            )
            .limit(2)) as Array<{ bytes: unknown }>
        if (settingsExtent.length !== 1) invalid()
        charge(headerBudget, 1536 + 16 * integer(settingsExtent[0].bytes, 264))
        const settings = (await k('settings')
          .select(
            k.raw('CASE WHEN length(CAST(chain AS BLOB))<=8 THEN chain ELSE NULL END AS chain'),
            k.raw(
              'CASE WHEN length(CAST(storageIdentityKey AS BLOB))<=256 THEN storageIdentityKey ELSE NULL END AS storageIdentityKey'
            )
          )
          .limit(2)) as Array<{ chain: string; storageIdentityKey: string }>
        if (
          bound.archiveSha256 !== admission.scope.archiveSha256 ||
          settings.length !== 1 ||
          settings[0].chain !== bound.chain ||
          settings[0].storageIdentityKey !== bound.targetStorageIdentityKey
        )
          invalid()
        const header = await original(0, headerBudget),
          sourceHeader = JSON.parse(header.originalJson) as { user: PortableRow },
          user = decodePortableRow<Record<string, unknown>>('user', sourceHeader.user)
        if (
          header.tableName !== 'header' ||
          header.originalJson !== metadata.header ||
          user.identityKey !== bound.identityKey ||
          user.userId !== admission.scope.userId ||
          (await count(k, 'users', 2)) !== 1
        )
          invalid()
        user.activeStorage = ''
        const actualUser = await nativeMetadata(
          k,
          'users',
          { userId: admission.scope.userId },
          Object.keys(user),
          headerBudget
        )
        if (Object.keys(user).some(field => actualUser[field] !== native(user[field]))) invalid()
      } finally {
        headerBudget.reservation.close()
      }
    })()
    await runInSeries(brc38ImportTableOrder, async table => {
      const form = brc38ImportRowForm(table)
      for (let position = 0; position < counts.get(table)!; position++, sourceRow++) {
        check()
        const plan = await (async () => {
          const rowBudget = budget(working)
          try {
            const budget = rowBudget
            const source = await fields(k, table, position, limits[3], budget),
              descriptors = await readBrc38SqlBinaryDescriptors(k, table, position),
              json = structured === undefined ? undefined : await readBrc38SqlStructuredDescriptors(k, table, position),
              rawTexts = structured === undefined ? undefined : await readBrc38SqlTextDescriptors(k, table, position),
              originalRow = await original(sourceRow, budget)
            if (
              json !== undefined &&
              Object.keys(json).some(field => Object.hasOwn(source, field) || Object.hasOwn(descriptors, field))
            )
              invalid()
            if (
              rawTexts !== undefined &&
              Object.keys(rawTexts).some(
                field =>
                  Object.hasOwn(source, field) || Object.hasOwn(descriptors, field) || Object.hasOwn(json ?? {}, field)
              )
            )
              invalid()
            if (
              originalRow.tableName !== table ||
              createHash('sha256').update(originalRow.originalJson).digest('hex') !==
                hash(
                  {
                    protocol: structured === undefined ? 'brc38-streamed-original/v1' : 'brc38-structured-original/v1',
                    table,
                    index: position,
                    fields: source,
                    binaries: descriptors,
                    ...(json === undefined ? {} : { structured: json }),
                    ...(Object.keys(rawTexts ?? {}).length === 0 ? {} : { texts: rawTexts })
                  },
                  limits[4]
                )
            )
              invalid()
            if (structured !== undefined)
              for (const field of binaryFieldNames(table)) {
                const value = source[field]
                if (value == null) continue
                charge(
                  budget,
                  512 + 8 * (typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : 0)
                )
              }
            const expected = decodePortableRow<Record<string, unknown>>(form.kind, source),
              references = [
                ...(form.entity === undefined || form.id === undefined
                  ? []
                  : [{ entity: form.entity, incomingId: Number(expected[form.id]), required: true }]),
                ...form.parents
                  .filter(parent => expected[parent.field] !== undefined)
                  .map(parent => ({
                    entity: parent.entity,
                    incomingId: Number(expected[parent.field]),
                    required: true
                  }))
              ]
            charge(budget, 4096 + 1024 * references.length)
            const loaded = await loadBrc38ImportIdMap(k, admission.scope, references)
            const key: Record<string, unknown> = {}
            if (form.entity !== undefined && form.id !== undefined) {
              expected[form.id] = loaded.map[form.entity].idMap[Number(source[form.id])]
              key[form.id] = expected[form.id]
            }
            for (const parent of form.parents)
              if (expected[parent.field] !== undefined)
                expected[parent.field] = loaded.map[parent.entity].idMap[Number(expected[parent.field])]
            if (form.entity === undefined) {
              if (table === 'txLabelMaps')
                Object.assign(key, { txLabelId: expected.txLabelId, transactionId: expected.transactionId })
              else if (table === 'outputTagMaps')
                Object.assign(key, { outputTagId: expected.outputTagId, outputId: expected.outputId })
              else if (table === 'certificateFields')
                Object.assign(key, { certificateId: expected.certificateId, fieldName: expected.fieldName })
              else
                Object.assign(key, {
                  userId: expected.userId,
                  storageIdentityKey: expected.storageIdentityKey,
                  syncStateId: expected.syncStateId
                })
            }
            if (table === 'provenTxReqs' || table === 'syncStates') {
              const historyField = table === 'provenTxReqs' ? 'notify' : 'syncMap'
              if (json?.[historyField] === undefined) {
                const historyJson = source[historyField]
                if (typeof historyJson !== 'string') invalid()
                charge(budget, 1024 + 16 * Buffer.byteLength(historyJson))
                // The inline fallback retains parsed objects, Sets, projected maps,
                // two encoded representations and at most 128 loaded mappings. It
                // therefore has its own conservative simultaneous working model;
                // encoded-byte allowance alone cannot cover those allocations.
                const allowance = Math.floor((budget.remaining - 8192) / 512)
                if (allowance < 1)
                  throw new SnapshotResourceLimitError('Inline history cannot fit the original inventory allowance')
                charge(budget, 8192 + 256 * allowance)
                const history = await prepareBrc38ImportHistory(
                  k,
                  admission.scope,
                  { kind: 'table', table, fromIndex: position, rows: [expected] } as unknown as Brc38PreparedImportData,
                  allowance,
                  signal
                )
                if (history.length !== 1 || history[0].activated !== false) invalid()
                expected[history[0].field] = history[0].mappedJson
              }
              if (table === 'syncStates') expected.init = false
            }
            const texts = structured === undefined ? [] : textFields(table),
              binaries = structured === undefined ? [] : binaryFieldNames(table),
              names = Object.keys(expected).filter(field =>
                structured === undefined
                  ? true
                  : !texts.includes(field as Brc38NativeTextRead['field']) && !brc38JsonBinaryField(table, field)
              )
            if (names.length > 64) invalid()
            // Metadata transfer is independently byte-preflighted before selection.
            const actual = await nativeMetadata(k, tables[table], key, names, budget)
            if (names.some(field => actual[field] !== native(expected[field]))) invalid()
            let actualTextRowId: number | undefined
            if (structured !== undefined && texts.length !== 0) {
              // Inert sync states retain their original signed key; they have no
              // remapped entity ID in the portable import form.
              let rowId: unknown =
                table === 'syncStates' ? expected.syncStateId : form.id === undefined ? undefined : expected[form.id]
              if (table === 'certificateFields') {
                charge(budget, 2048)
                const physical: Array<{ rowid: number }> = await k(tables[table]).where(key).select('rowid').limit(2)
                if (physical.length !== 1) invalid()
                rowId = physical[0].rowid
              }
              if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) invalid()
              actualTextRowId = rowId
              const jsonNames = Object.keys(json ?? {}),
                rawNames = Object.keys(rawTexts ?? {})
              if (
                jsonNames.some(field => !texts.includes(field as Brc38NativeTextRead['field'])) ||
                rawNames.some(field => !texts.includes(field as Brc38NativeTextRead['field']))
              )
                invalid()
              scalarTextFields += rawNames.length
              structuredFields += jsonNames.length
              for (const field of texts) {
                check()
                if (json?.[field] !== undefined || rawTexts?.[field] !== undefined) {
                  // Independently regenerate this field after the row's metadata and
                  // original envelope scopes end. This stores coordinates DATA only.
                } else if (
                  await inlineText(
                    k,
                    table as Brc38NativeTextRead['table'],
                    rowId,
                    field,
                    expected[field],
                    budget,
                    check,
                    working,
                    structured.sourcePolicy.maximumReadBytes
                  )
                )
                  nativeTextFields++
              }
            } else if (
              (json !== undefined && Object.keys(json).length !== 0) ||
              (rawTexts !== undefined && Object.keys(rawTexts).length !== 0)
            )
              invalid()
            const binaryNames = Object.keys(descriptors)
            if (
              structured !== undefined &&
              binaryNames.some(field => !binaries.includes(field as Brc38NativeBlobRead['field']))
            )
              invalid()
            binaryFields += binaryNames.length
            if (binaryNames.length !== 0 && (form.id === undefined || typeof expected[form.id] !== 'number')) invalid()
            for (const field of binaries) {
              if (Object.hasOwn(descriptors, field)) continue
              if (form.id === undefined || typeof expected[form.id] !== 'number') invalid()
              const bytes = await inlineBinary(
                k,
                table as Brc38NativeBlobRead['table'],
                Number(expected[form.id]),
                field,
                expected[field],
                budget,
                check,
                working,
                structured?.sourcePolicy.maximumReadBytes
              )
              if (bytes === undefined) continue
              if (bytes > Number.MAX_SAFE_INTEGER - binaryBytes) invalid()
              binaryBytes += bytes
              binaryFields++
            }
            return Object.freeze({
              rowId:
                actualTextRowId ??
                (table === 'syncStates' && structured !== undefined
                  ? Number(expected.syncStateId)
                  : form.id === undefined
                    ? undefined
                    : Number(expected[form.id])),
              texts: Object.freeze(Object.keys(rawTexts ?? {})),
              structured: Object.freeze(Object.keys(json ?? {})),
              binaries: descriptors
            })
          } finally {
            rowBudget.reservation.close()
          }
        })()
        // The coherent current read-only transaction is still the authority.
        // Metadata/provenance and derived coordinates are never an admission
        // receipt or a reusable semantic verdict for these independent proofs.
        check()
        for (const field of plan.structured) {
          if (structured === undefined || typeof plan.rowId !== 'number' || !Number.isSafeInteger(plan.rowId)) invalid()
          await inspectBrc38StructuredNativeField(
            k,
            admission,
            {
              table: table as Brc38NativeTextRead['table'],
              field: field as Brc38NativeTextRead['field'],
              rowId: plan.rowId,
              sourceIndex: position
            },
            {
              ...structured,
              sourcePolicy: { ...structured.sourcePolicy, workingAllocation: working },
              projectionPolicy: { ...structured.projectionPolicy, workingAllocation: working }
            }
          )
          if (field === 'notify' || field === 'syncMap') projectedFields++
          nativeTextFields++
        }
        for (const field of plan.texts) {
          if (structured === undefined || typeof plan.rowId !== 'number' || !Number.isSafeInteger(plan.rowId)) invalid()
          await inspectBrc38TextNativeField(
            k,
            {
              table: table as Brc38NativeTextRead['table'],
              field: field as Brc38NativeTextRead['field'],
              rowId: plan.rowId,
              sourceIndex: position
            },
            working,
            Math.min(16384, transferWidth(working, structured.sourcePolicy.maximumReadBytes)),
            check
          )
          nativeTextFields++
        }
        for (const field of Object.keys(plan.binaries)) {
          if (typeof plan.rowId !== 'number' || !Number.isSafeInteger(plan.rowId)) invalid()
          const descriptor = plan.binaries[field]
          await blob(
            k,
            table as Brc38NativeBlobRead['table'],
            plan.rowId,
            descriptor,
            check,
            working,
            structured?.sourcePolicy.maximumReadBytes
          )
          if (descriptor.bytes > Number.MAX_SAFE_INTEGER - binaryBytes) invalid()
          binaryBytes += descriptor.bytes
        }
      }
    })
    check()
    if (structured !== undefined) {
      await structuredFamily(k, 'private_text_fields', 'private_text_chunks', scalarTextFields, 7 * limits[0])
      await structuredFamily(
        k,
        'private_structured_fields',
        'private_structured_chunks',
        structuredFields,
        3 * limits[0]
      )
      await structuredFamily(
        k,
        'private_canonical_structured_fields',
        'private_canonical_structured_chunks',
        structuredFields,
        3 * limits[0]
      )
      await structuredFamily(
        k,
        'private_projected_structured_fields',
        'private_projected_structured_chunks',
        projectedFields,
        3 * limits[0]
      )
      if ((await count(k, nativePackedTextTables.fields, 7 * limits[0])) !== nativeTextFields) invalid()
    }
    if (await hasBrc38NativePackedSchema(k)) {
      if ((await hasBrc38NativePreparedFieldsSchema(k)) && (await count(k, nativePreparedFieldsTable, 0)) !== 0)
        invalid()
      if (
        (await count(k, nativePackedTables.fields, 3 * limits[0])) !== binaryFields ||
        (await count(k, nativePackedTables.garbage, 3 * limits[0])) !== 0
      )
        invalid()
      const orphan = await k(nativePackedTables.versions).whereNot({ state: 'SEALED' }).select('sha256').limit(1)
      if (
        orphan.length !== 0 ||
        (
          await k(nativePackedTables.versions)
            .whereNotExists(
              k(nativePackedTables.fields)
                .select(k.raw('1'))
                .whereRaw('?? = ??', [nativePackedTables.fields + '.sha256', nativePackedTables.versions + '.sha256'])
            )
            .select('sha256')
            .limit(1)
        ).length !== 0
      )
        invalid()
    }
    if (await hasBrc38NativePackedTextSchema(k))
      await inspectBrc38NativePackedTextInventory(
        k,
        7 * limits[0],
        signal,
        check,
        transferWidth(working, structured?.sourcePolicy.maximumReadBytes),
        working
      )
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (JSON.stringify(await readJournal(k, admission, working)) !== JSON.stringify(receipt)) invalid()
    return Object.freeze({ rows: total + 1, mappedIds, binaryBytes })
  } catch (error) {
    if (error instanceof Brc38StagingCleanupError) {
      retained = true
      throw new Brc38StagingCleanupError(
        [error],
        'Native inventory retains original allocation through cleanup',
        async () => {
          await error.retryCleanup()
          lifetimeAllocation.close()
        }
      )
    }
    throw error
  } finally {
    if (!retained) lifetimeAllocation.close()
  }
}
