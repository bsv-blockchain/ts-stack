import { brc38ImportRowForm, brc38ImportTableOrder } from './Brc38ImportForms'
export { brc38ImportRowForm, brc38ImportTableOrder } from './Brc38ImportForms'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonBinaryField, type Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import {
  copyBrc38ImportDecodedValue,
  chargeBrc38ImportDecodedBudget,
  type Brc38ImportDecodedBudget
} from './Brc38ImportEntityMergeNode'
import { createHash } from 'node:crypto'
import type { BRC38WalletData } from './index'
import { decodePortableRow, requireNumber, type PortableRow } from './Brc38PortableRows'
import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './Brc38SemanticStage'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { brc38ImportIncomingId, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import type { SyncMap } from '../schema/entities/EntityBase'
import type { Brc38ImportJournalAdmission, Brc38ImportJournalStep } from './Brc38ImportJournal'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'
import type {
  TableUser,
  TableSettings,
  TableProvenTx,
  TableOutputBasket,
  TableOutputTag,
  TableTxLabel,
  TableTransaction,
  TableOutput,
  TableTxLabelMap,
  TableOutputTagMap,
  TableCertificate,
  TableCertificateField,
  TableCommission,
  TableProvenTxReq,
  TableSyncState
} from '../schema/tables'

export interface Brc38ImportRowTypes {
  provenTxs: TableProvenTx
  outputBaskets: TableOutputBasket
  outputTags: TableOutputTag
  txLabels: TableTxLabel
  transactions: TableTransaction
  outputs: TableOutput
  txLabelMaps: TableTxLabelMap
  outputTagMaps: TableOutputTagMap
  certificates: TableCertificate
  certificateFields: TableCertificateField
  commissions: TableCommission
  provenTxReqs: TableProvenTxReq
  syncStates: TableSyncState
}
export type Brc38PreparedImportData =
  | {
      readonly kind: 'header'
      readonly source: Readonly<TableSettings>
      readonly user: Readonly<TableUser>
      readonly original: Readonly<BRC38WalletData>
    }
  | {
      [K in Brc38StageTable]: {
        readonly kind: 'table'
        readonly table: K
        readonly fromIndex: number
        readonly rows: ReadonlyArray<Readonly<Brc38ImportRowTypes[K]>>
      }
    }[Brc38StageTable]
function invalid(): never {
  throw new Error('Bounded private import page is inconsistent or stale')
}
function integer(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
}
function extent(value: unknown, allocation: number, maximum: number): number {
  let bytes = 0
  for (const chunk of canonicalPortableChunks(value, {
    maximumValueBytes: allocation,
    maximumChunkBytes: 4096
  })) {
    if (chunk.byteLength > maximum - bytes)
      throw new SnapshotResourceLimitError('Private import row exceeds its fixed preparation byte budget')
    bytes += chunk.byteLength
  }
  return bytes
}
function addReference(
  wanted: Map<string, Brc38ImportIdReference>,
  entity: keyof SyncMap,
  value: unknown,
  required: boolean
): void {
  const incomingId = requireNumber(value, 'import reference'),
    identity = JSON.stringify([entity, brc38ImportIncomingId(incomingId)]),
    previous = wanted.get(identity)
  if (previous !== undefined) {
    if (required && !previous.required) wanted.set(identity, Object.freeze({ entity, incomingId, required }))
    return
  }
  if (wanted.size >= 4096)
    throw new SnapshotResourceLimitError('Private import page exceeds 4096 prepared ID references')
  wanted.set(identity, Object.freeze({ entity, incomingId, required }))
}
function rowReferences(
  table: Brc38StageTable,
  row: Readonly<PortableRow>,
  wanted: Map<string, Brc38ImportIdReference>
): void {
  const form = brc38ImportRowForm(table)
  if (form.entity !== undefined && form.id !== undefined) addReference(wanted, form.entity, row[form.id], false)
  for (const parent of form.parents) {
    if (parent.optional === true && row[parent.field] === undefined) continue
    addReference(wanted, parent.entity, row[parent.field], true)
  }
}
function freezeRecord<T extends object>(value: T): Readonly<T> {
  // All data comes from bounded private JSON/legacy decoder. Typed Date objects
  // remain private to the one-use payload; no caller sees them before consume.
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freezeRecord(child)
  return Object.freeze(value)
}
/** One opaque already-decoded page. This is prepared data, not an authorization
 * token. The actual private owner/destination fence must be held separately.
 * Payload is consumed only once inside an internal bounded apply callback. */
export class Brc38PreparedImportPage {
  #consumed = false
  readonly #data: Brc38PreparedImportData
  readonly step: Readonly<Brc38ImportJournalStep>
  readonly references: readonly Brc38ImportIdReference[]
  constructor(
    step: Brc38ImportJournalStep,
    references: readonly Brc38ImportIdReference[],
    data: Brc38PreparedImportData
  ) {
    this.#data = data
    this.step = Object.freeze({ ...step })
    this.references = Object.freeze([...references])
    Object.freeze(this)
  }
  consume<T>(apply: (data: Brc38PreparedImportData) => Promise<T>): Promise<T> {
    if (this.#consumed) throw new Error('Prepared private import page is already consumed')
    this.#consumed = true
    return apply(this.#data)
  }
}
/** Called within the actual authenticated private read owner. Fixed thirteen
 * scalar counts and one indexed bounded row at a time; no OFFSET, whole table
 * payloads, destination I/O, crypto or source read is deferred into the writer.
 * Large nested sync-state/notification projections remain distinct bounded
 * application work; raw original history is retained exactly by the decoder. */
function preparationLimits(
  metadata: Readonly<{ rows: number }>,
  admission: Brc38ImportJournalAdmission,
  fromRow: number
): number[] {
  integer(metadata.rows, 1000000000)
  integer(fromRow, metadata.rows)
  if (admission.totalRows !== metadata.rows + 1) invalid()
  integer(admission.maximumStepRows, 4096)
  integer(admission.maximumStepBytes, 16777216)
  if (admission.maximumStepRows === 0 || admission.maximumStepBytes === 0) invalid()
  if (typeof admission.originalLimitsJson !== 'string' || Buffer.byteLength(admission.originalLimitsJson) > 256)
    invalid()
  const original: unknown = JSON.parse(admission.originalLimitsJson)
  if (!Array.isArray(original) || original.length !== 6 || JSON.stringify(original) !== admission.originalLimitsJson)
    invalid()
  const limits = original as number[]
  integer(limits[3], 16777216)
  integer(limits[4], 16777216)
  if (
    limits[3] === 0 ||
    limits[4] === 0 ||
    admission.maximumStepBytes > limits[4] ||
    metadata.rows > limits[0] ||
    limits[5] !== admission.expiresAt
  )
    invalid()
  return limits
}
async function sourceCounts(
  reader: Pick<Brc38AuthenticatedImportReader, 'count'>,
  rows: number,
  signal?: AbortSignal
): Promise<ReadonlyMap<Brc38StageTable, number>> {
  const counts = new Map<Brc38StageTable, number>()
  let total = 0
  await runInSeries(brc38StageTables, async table => {
    signal?.throwIfAborted()
    const count = await reader.count(table)
    integer(count, rows)
    total += count
    if (total > rows) invalid()
    counts.set(table, count)
  })
  if (total !== rows) invalid()
  return counts
}
function hashValue(hash: ReturnType<typeof createHash>, value: unknown, allocation: number): void {
  for (const chunk of canonicalPortableChunks(value, {
    maximumValueBytes: allocation,
    maximumChunkBytes: 4096
  }))
    hash.update(chunk)
}
interface PreparedPayload {
  data: Brc38PreparedImportData
  rows: number
  bytes: number
  mappedIds: number
}
async function headerPayload(
  reader: Pick<Brc38AuthenticatedImportReader, 'header'>,
  admission: Brc38ImportJournalAdmission,
  limits: readonly number[],
  hash: ReturnType<typeof createHash>
): Promise<PreparedPayload> {
  const header = await reader.header()
  if (brc38StageTables.some(table => header.tables[table].length !== 0)) invalid()
  const bytes = extent(header, limits[4], limits[3])
  if (bytes > admission.maximumStepBytes)
    throw new SnapshotResourceLimitError('Private import header exceeds its fixed page byte budget')
  hashValue(hash, header, limits[4])
  return {
    rows: 1,
    bytes,
    mappedIds: 0,
    data: freezeRecord({
      kind: 'header',
      source: decodePortableRow<TableSettings>('settings', header.sourceStorage),
      user: decodePortableRow<TableUser>('user', header.user),
      original: header
    })
  }
}
function locate(
  counts: ReadonlyMap<Brc38StageTable, number>,
  fromRow: number
): { table: Brc38StageTable; position: number } {
  let position = fromRow - 1
  for (const table of brc38ImportTableOrder) {
    const count = counts.get(table)!
    if (position < count) return { table, position }
    position -= count
  }
  return invalid()
}
async function tablePayload(
  reader: Brc38AuthenticatedImportReader,
  admission: Brc38ImportJournalAdmission,
  fromRow: number,
  limits: readonly number[],
  counts: ReadonlyMap<Brc38StageTable, number>,
  hash: ReturnType<typeof createHash>,
  wanted: Map<string, Brc38ImportIdReference>,
  maximumPreparedRows: number,
  signal?: AbortSignal
): Promise<PreparedPayload> {
  const { table, position } = locate(counts, fromRow),
    maximum = Math.min(counts.get(table)! - position, maximumPreparedRows),
    decoded: unknown[] = []
  hash.update(JSON.stringify([table, position]))
  let stopped = false,
    bytes = 0,
    rows = 0
  await runInSeries(
    Array.from({ length: maximum }, (_value, index) => position + index),
    async index => {
      if (stopped) return
      signal?.throwIfAborted()
      const row = await reader.row(table, index)
      if (row === undefined) invalid()
      const size = extent(row, limits[4], limits[3])
      if (size > admission.maximumStepBytes - bytes) {
        if (rows === 0)
          throw new SnapshotResourceLimitError('Private import first row exceeds its fixed page byte budget')
        stopped = true
        return
      }
      rowReferences(table, row, wanted)
      hashValue(hash, row, limits[4])
      decoded.push(freezeRecord(decodePortableRow<Record<string, unknown>>(brc38ImportRowForm(table).kind, row)))
      bytes += size
      rows++
    }
  )
  if (rows === 0) invalid()
  const data = Object.freeze({
    kind: 'table',
    table,
    fromIndex: position,
    rows: Object.freeze(decoded)
  }) as Brc38PreparedImportData
  return { data, rows, bytes, mappedIds: brc38ImportRowForm(table).entity === undefined ? 0 : rows }
}
export async function prepareBrc38ImportPage(
  reader: Readonly<Brc38AuthenticatedImportReader>,
  metadata: Readonly<{ rows: number }>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  fromRow: number,
  signal?: AbortSignal,
  maximumPreparedRows = admission.maximumStepRows
): Promise<Brc38PreparedImportPage> {
  signal?.throwIfAborted()
  const limits = preparationLimits(metadata, admission, fromRow)
  integer(maximumPreparedRows, admission.maximumStepRows)
  if (maximumPreparedRows === 0) invalid()
  if (Date.now() >= admission.expiresAt) invalid()
  const counts = await sourceCounts(reader, metadata.rows, signal),
    hash = createHash('sha256'),
    wanted = new Map<string, Brc38ImportIdReference>()
  hash.update(
    JSON.stringify([
      'brc38-prepared-import-page/v1',
      admission.scope.importId,
      admission.scope.bindingSha256,
      admission.scope.archiveSha256,
      admission.scope.userId,
      admission.previewId,
      fromRow
    ])
  )
  const payload =
    fromRow === 0
      ? await headerPayload(reader, admission, limits, hash)
      : await tablePayload(reader, admission, fromRow, limits, counts, hash, wanted, maximumPreparedRows, signal)
  signal?.throwIfAborted()
  if (Date.now() >= admission.expiresAt) invalid()
  return new Brc38PreparedImportPage(
    {
      fromRow,
      rows: payload.rows,
      bytes: payload.bytes,
      mappedIds: payload.mappedIds,
      pageSha256: hash.digest('hex')
    },
    [...wanted.values()],
    payload.data
  )
}

export type Brc38PreparedStreamedData =
  | Extract<Brc38PreparedImportData, { kind: 'header' }>
  | {
      readonly kind: 'table'
      readonly table: Brc38StageTable
      readonly fromIndex: number
      readonly rows: ReadonlyArray<
        Readonly<{ source: Brc38JsonStreamedRow; metadata: Readonly<Record<string, unknown>> }>
      >
    }
export interface Brc38PreparedStreamedPage {
  readonly data: Brc38PreparedStreamedData
  readonly step: Readonly<Brc38ImportJournalStep>
  readonly references: readonly Brc38ImportIdReference[]
  /** One shared retained-allocation allowance for page/receiver/provenance. */
  readonly budget: Brc38ImportDecodedBudget
}
/** Actual source preparation only: no complete binary/placeholder row, target
 * write or chain/capability authority. The page hash includes every descriptor
 * and metadata value in a separate domain; legacy page hashing is unchanged. */
export async function prepareBrc38StreamedImportPage(
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  metadata: Readonly<{ rows: number }>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  fromRow: number,
  signal?: AbortSignal
): Promise<Brc38PreparedStreamedPage> {
  return await prepareFieldAwarePage(reader, metadata, admission, fromRow, false, signal)
}
/** Explicit large structured receiver preparation. Original raw field SHA and
 * byte coordinates remain in its own replay domain; no field data/placeholder
 * row or native write is fetched here. Complete authenticated source and actual
 * receiver/physical owner admission belong to the surrounding caller. */
export async function prepareBrc38StructuredImportPage(
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  metadata: Readonly<{ rows: number }>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  fromRow: number,
  signal?: AbortSignal,
  maximumPreparedRows?: number
): Promise<Brc38PreparedStreamedPage> {
  return await prepareFieldAwarePage(reader, metadata, admission, fromRow, true, signal, maximumPreparedRows)
}
async function prepareFieldAwarePage(
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  metadata: Readonly<{ rows: number }>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  fromRow: number,
  structured: boolean,
  signal?: AbortSignal,
  selectedMaximumPreparedRows?: number
): Promise<Brc38PreparedStreamedPage> {
  const maximumPreparedRows = selectedMaximumPreparedRows ?? admission.maximumStepRows
  if (
    !Number.isSafeInteger(maximumPreparedRows) ||
    maximumPreparedRows < 1 ||
    maximumPreparedRows > admission.maximumStepRows
  )
    invalid()
  const limits = preparationLimits(metadata, admission, fromRow),
    counts = await sourceCounts(reader, metadata.rows, signal),
    hash = createHash('sha256'),
    wanted = new Map<string, Brc38ImportIdReference>(),
    budget: Brc38ImportDecodedBudget = {
      maximum: admission.maximumStepBytes,
      remaining: admission.maximumStepBytes,
      signal
    }
  const check = (): void => {
    signal?.throwIfAborted()
    if (Date.now() >= admission.expiresAt) invalid()
  }
  check()
  hash.update(
    JSON.stringify([
      structured ? 'brc38-prepared-structured-import-page/v1' : 'brc38-prepared-streamed-import-page/v1',
      admission.scope,
      admission.previewId,
      fromRow
    ])
  )
  if (fromRow === 0) {
    const value = await headerPayload(reader, admission, limits, hash),
      data = copyBrc38ImportDecodedValue(value.data, budget) as Extract<Brc38PreparedImportData, { kind: 'header' }>
    check()
    return {
      data,
      budget,
      references: Object.freeze([]),
      step: Object.freeze({ fromRow, rows: 1, bytes: value.bytes, mappedIds: 0, pageSha256: hash.digest('hex') })
    }
  }
  const { table, position } = locate(counts, fromRow),
    maximum = Math.min(counts.get(table)! - position, maximumPreparedRows),
    rows: Array<Readonly<{ source: Brc38JsonStreamedRow; metadata: Readonly<Record<string, unknown>> }>> = []
  let bytes = 0
  hash.update(JSON.stringify([table, position]))
  for (let index = position; index < position + maximum; index++) {
    check()
    const source = await reader.row(table, index)
    if (
      source === undefined ||
      Object.keys(source.binaries).length > 3 ||
      (!structured && Object.keys(source.fields).some(field => brc38JsonBinaryField(table, field)))
    )
      invalid()
    for (const [field, value] of Object.entries(source.binaries))
      if (
        !brc38JsonBinaryField(table, field) ||
        value.field !== field ||
        Object.hasOwn(source.fields, field) ||
        value.encoding !== (field === 'noSendExpiryReclaimRawTx' ? 'number-array' : 'base64') ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        value.bytes > 1000000000 ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        invalid()
    const json = source.structured ?? {},
      jsonNames = Object.keys(json)
    if (jsonNames.length > 3 || (!structured && jsonNames.length !== 0)) invalid()
    for (const field of jsonNames) {
      const value = json[field]
      if (
        !brc38JsonStructuredField(table, field) ||
        Object.hasOwn(source.fields, field) ||
        Object.hasOwn(source.binaries, field) ||
        value.field !== field ||
        value.encoding !== 'utf8-json' ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 2 ||
        value.bytes > 1000000000 ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        invalid()
    }
    const texts = source.texts ?? {},
      textNames = Object.keys(texts)
    if (textNames.length > 7 || (!structured && textNames.length !== 0)) invalid()
    for (const field of textNames) {
      const value = texts[field]
      if (
        !brc38JsonTextField(table, field) ||
        Object.hasOwn(source.fields, field) ||
        Object.hasOwn(source.binaries, field) ||
        Object.hasOwn(json, field) ||
        value.field !== field ||
        value.encoding !== 'utf8' ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        value.bytes > 1000000000 ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      )
        invalid()
    }
    const size = extent(source, limits[4], limits[3])
    if (size > admission.maximumStepBytes - bytes) {
      if (rows.length === 0) throw new SnapshotResourceLimitError('First streamed row metadata exceeds its page budget')
      break
    }
    const before = budget.remaining
    let detached: Brc38JsonStreamedRow, decoded: Record<string, unknown>
    try {
      detached = copyBrc38ImportDecodedValue(source, budget)
      // Charge retained date/JSON decoding before it allocates its normalized
      // metadata, and reserve room for actual provenance/writer preparation.
      chargeBrc38ImportDecodedBudget(budget, 512 + 8 * size)
      decoded = decodePortableRow<Record<string, unknown>>(
        brc38ImportRowForm(table).kind,
        detached.fields as PortableRow
      )
      if (budget.remaining < 4096 * (rows.length + 1) + 24 * (bytes + size))
        throw new SnapshotResourceLimitError('Streamed page receiver preparation allowance reached')
    } catch (cause) {
      // Precharge precedes clone. No partially allocated retained row escapes.
      if (!(cause instanceof SnapshotResourceLimitError) || rows.length === 0) throw cause
      budget.remaining = before
      break
    }
    rowReferences(table, detached.fields, wanted)
    hashValue(hash, detached, limits[4])
    bytes += size
    rows.push(Object.freeze({ source: detached, metadata: Object.freeze(decoded) }))
  }
  if (rows.length === 0) invalid()
  check()
  return {
    data: Object.freeze({ kind: 'table', table, fromIndex: position, rows: Object.freeze(rows) }),
    budget,
    references: Object.freeze([...wanted.values()]),
    step: Object.freeze({
      fromRow,
      rows: rows.length,
      bytes,
      mappedIds: brc38ImportRowForm(table).entity === undefined ? 0 : rows.length,
      pageSha256: hash.digest('hex')
    })
  }
}
