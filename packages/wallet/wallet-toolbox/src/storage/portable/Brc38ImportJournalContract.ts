import { SHA256 } from '@bsv/sdk/primitives/Hash'
export interface Brc38ImportMapScope {
  readonly importId: string
  readonly bindingSha256: string
  readonly archiveSha256: string
  readonly userId: number
}
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Portable checkpoint DATA shared by SQLite and IndexedDB. These helpers
 * establish no backend, source, schema, profile, semantic or activation authority.
 * Both providers must freshly establish their actual actor and transaction. */
export interface Brc38ImportJournalAdmission {
  readonly scope: Readonly<Brc38ImportMapScope>
  readonly previewId: string
  readonly originalLimitsJson: string
  readonly expiresAt: number
  readonly initialDestinationSha256: string
  readonly totalRows: number
  readonly maximumStepRows: number
  readonly maximumStepBytes: number
  readonly maximumMappedIds: number
  /** Explicit destination journal budget, distinct from private scratch disk.
   * Fixed admission reserves 4096 bytes plus 512 per newly mapped ID.
   * Source-owned SQL triggers charge actual insertions in the same transaction. This is
   * a logical bound; it does not claim a physical SQLite disk quota. */
  readonly maximumJournalLogicalBytes: number
}

export interface Brc38ImportJournalStep {
  readonly fromRow: number
  readonly rows: number
  readonly bytes: number
  readonly mappedIds: number
  readonly pageSha256: string
}

export interface Brc38ImportJournalReceipt {
  readonly protocol: 'brc38-destination-import/v1'
  readonly state: 'PREPARED' | 'COMMITTED' | 'COMPLETE' | 'EXPIRED'
  readonly sequence: number
  readonly nextRow: number
  readonly mappedIds: number
  readonly logicalBytes: number
  readonly destinationSha256: string
  readonly lastStep: Readonly<Brc38ImportJournalStep> | null
}

export interface StoredReceipt {
  bindingSha256: string | null
  archiveSha256: string | null
  userId: number | null
  mappedIds: number | null
  maximumMappedIds: number | null
  cleanupAllowed: number | null
  admissionJson: string | null
  admissionSha256: string | null
  receiptJson: string | null
  receiptSha256: string | null
}

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const sha = /^[0-9a-f]{64}$/

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && sha.test(value)
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value)
}

export function invalid(): never {
  throw new Error('Private import journal is missing, inconsistent or stale')
}

export function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
}

export function digest(json: string): string {
  return new SHA256().update(new TextEncoder().encode(json)).digestHex()
}

export function boundedJson(value: unknown): string {
  const json = JSON.stringify(value)
  if (json.length > 4096 || new TextEncoder().encode(json).byteLength > 4096)
    throw new SnapshotResourceLimitError('Private import journal metadata exceeds 4096 bytes')
  return json
}

export function originalLimits(
  json: string,
  expiresAt: number
): { json: string; rows: number; allocationBytes: number } {
  if (typeof json !== 'string' || json.length > 256 || new TextEncoder().encode(json).byteLength > 256) invalid()
  const payload: unknown = JSON.parse(json)
  if (!Array.isArray(payload) || payload.length !== 6) invalid()
  const value = payload as number[]
  integer(value[0], 1, 1000000000)
  integer(value[1], 1, Number.MAX_SAFE_INTEGER)
  integer(value[2], 1048576, Number.MAX_SAFE_INTEGER)
  integer(value[3], 1, 16777216)
  integer(value[4], 1, 16777216)
  if (value[5] !== expiresAt) invalid()
  // Use the exact six-number tuple already bound by brc38StagingBinding.
  const projected = JSON.stringify(value)
  if (projected !== json) invalid()
  return {
    json: projected,
    rows: value[0],
    allocationBytes: value[4]
  }
}

export function admissionCopy(input: Brc38ImportJournalAdmission): Readonly<Brc38ImportJournalAdmission> {
  const s = input.scope
  if (
    !isUuid(s.importId) ||
    !isSha(s.bindingSha256) ||
    !isSha(s.archiveSha256) ||
    !Number.isSafeInteger(s.userId) ||
    !isUuid(input.previewId) ||
    input.previewId === s.importId ||
    !isSha(input.initialDestinationSha256)
  )
    invalid()
  integer(input.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  integer(input.totalRows, 0, 1000000001)
  integer(input.maximumStepRows, 1, 4096)
  integer(input.maximumStepBytes, 1, 16777216)
  integer(input.maximumMappedIds, 0, 1000000000)
  integer(input.maximumJournalLogicalBytes, 4096, Number.MAX_SAFE_INTEGER)
  const limits = originalLimits(input.originalLimitsJson, input.expiresAt)
  if (
    input.totalRows > limits.rows + 1 ||
    input.maximumMappedIds > limits.rows ||
    input.maximumStepBytes > limits.allocationBytes
  )
    invalid()
  return Object.freeze({
    scope: Object.freeze({
      importId: s.importId,
      bindingSha256: s.bindingSha256,
      archiveSha256: s.archiveSha256,
      userId: s.userId
    }),
    previewId: input.previewId,
    originalLimitsJson: limits.json,
    expiresAt: input.expiresAt,
    initialDestinationSha256: input.initialDestinationSha256,
    totalRows: input.totalRows,
    maximumStepRows: input.maximumStepRows,
    maximumStepBytes: input.maximumStepBytes,
    maximumMappedIds: input.maximumMappedIds,
    maximumJournalLogicalBytes: input.maximumJournalLogicalBytes
  })
}

export function stepCopy(
  step: Brc38ImportJournalStep,
  admission: Brc38ImportJournalAdmission
): Readonly<Brc38ImportJournalStep> {
  integer(step.fromRow, 0, admission.totalRows)
  integer(step.rows, 1, Math.min(admission.maximumStepRows, admission.totalRows - step.fromRow))
  integer(step.bytes, 1, admission.maximumStepBytes)
  integer(step.mappedIds, 0, Math.min(4096, admission.maximumMappedIds))
  if (!isSha(step.pageSha256)) invalid()
  return Object.freeze({
    fromRow: step.fromRow,
    rows: step.rows,
    bytes: step.bytes,
    mappedIds: step.mappedIds,
    pageSha256: step.pageSha256
  })
}

export function decodeReceipt(
  json: string,
  admission: Brc38ImportJournalAdmission
): Readonly<Brc38ImportJournalReceipt> {
  const payload: unknown = JSON.parse(json)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) invalid()
  const value = payload as Brc38ImportJournalReceipt
  if (
    value.protocol !== 'brc38-destination-import/v1' ||
    !['PREPARED', 'COMMITTED', 'COMPLETE', 'EXPIRED'].includes(value.state) ||
    !isSha(value.destinationSha256)
  )
    invalid()
  integer(value.sequence, 0, admission.totalRows)
  integer(value.nextRow, 0, admission.totalRows)
  integer(value.mappedIds, 0, admission.maximumMappedIds)
  integer(value.logicalBytes, 4096, admission.maximumJournalLogicalBytes)
  if (value.logicalBytes !== 4096 + value.mappedIds * 512) invalid()
  const lastStep = value.lastStep === null ? null : stepCopy(value.lastStep, admission)
  if (lastStep === null) {
    if (
      value.sequence !== 0 ||
      value.nextRow !== 0 ||
      value.mappedIds !== 0 ||
      value.destinationSha256 !== admission.initialDestinationSha256
    )
      invalid()
  } else if (
    value.sequence < 1 ||
    value.sequence > value.nextRow ||
    lastStep.fromRow + lastStep.rows !== value.nextRow ||
    lastStep.mappedIds > value.mappedIds
  )
    invalid()
  if (
    (value.state === 'PREPARED' && (lastStep !== null || admission.totalRows === 0)) ||
    (value.state === 'COMMITTED' && (lastStep === null || value.nextRow === admission.totalRows)) ||
    (value.state === 'COMPLETE' && value.nextRow !== admission.totalRows)
  )
    invalid()
  const projected = Object.freeze({
    protocol: value.protocol,
    state: value.state,
    sequence: value.sequence,
    nextRow: value.nextRow,
    mappedIds: value.mappedIds,
    logicalBytes: value.logicalBytes,
    destinationSha256: value.destinationSha256,
    lastStep
  })
  if (JSON.stringify(projected) !== json) invalid()
  return projected
}

export function mappingCapacity(admission: Brc38ImportJournalAdmission): number {
  return Math.min(admission.maximumMappedIds, Math.floor((admission.maximumJournalLogicalBytes - 4096) / 512))
}

export function validateMappingCharge(
  row: StoredReceipt,
  admission: Brc38ImportJournalAdmission,
  mappedIds: number
): void {
  if (
    row.bindingSha256 !== admission.scope.bindingSha256 ||
    row.archiveSha256 !== admission.scope.archiveSha256 ||
    row.userId !== admission.scope.userId ||
    row.mappedIds !== mappedIds ||
    row.maximumMappedIds !== mappingCapacity(admission) ||
    row.cleanupAllowed !== 0
  )
    invalid()
}

export function read(row: StoredReceipt, admission: Brc38ImportJournalAdmission): Readonly<Brc38ImportJournalReceipt> {
  if (
    row.admissionJson !== boundedJson(admission) ||
    row.admissionSha256 !== digest(row.admissionJson) ||
    row.receiptJson === null ||
    row.receiptSha256 !== digest(row.receiptJson)
  )
    invalid()
  const receipt = decodeReceipt(row.receiptJson, admission)
  validateMappingCharge(row, admission, receipt.mappedIds)
  return receipt
}
