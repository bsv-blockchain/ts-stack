import { syncTransferDigest } from '../../remoting/SyncTransfer'
import { snapshotArchiveLimits } from './SnapshotArchive'

/** Server-issued reader admission only. An absent request can never create a capture. */
export interface SnapshotArchiveReaderRequest {
  version: 2
  nonce: string
  notAfter: number
  maxBytes: number
  requestId: string
}

function invalid(): never {
  throw new TypeError('Invalid snapshot archive reader request')
}

export interface SnapshotArchiveReaderOptions {
  lifetimeMs: number
  maxBytes: number
}

function record(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalid()
  const fields: Record<string, unknown> = {}
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name)
    if (property === undefined || !('value' in property) || !property.enumerable) invalid()
    fields[name] = property.value
  }
  return fields
}

export function validateSnapshotArchiveReaderOptions(input: unknown): Readonly<SnapshotArchiveReaderOptions> {
  const fields = record(input, ['lifetimeMs', 'maxBytes'])
  const { lifetimeMs, maxBytes } = fields
  if (
    typeof lifetimeMs !== 'number' ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > snapshotArchiveLimits.lifetimeMs ||
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < snapshotArchiveLimits.headerCharge + 1 ||
    maxBytes > snapshotArchiveLimits.archiveBytes
  )
    invalid()
  return Object.freeze({ lifetimeMs, maxBytes })
}

export function snapshotArchiveReaderRequestId(request: Omit<SnapshotArchiveReaderRequest, 'requestId'>): string {
  return syncTransferDigest(
    new TextEncoder().encode(
      JSON.stringify([
        'wallet-snapshot-reader-request/1',
        request.version,
        request.nonce,
        request.notAfter,
        request.maxBytes
      ])
    )
  )
}

/** The distinct version and digest domain prevent the legacy start API recreating a closed reader. */
export function parseSnapshotArchiveReaderRequest(input: unknown): Readonly<SnapshotArchiveReaderRequest> {
  const names = ['version', 'nonce', 'notAfter', 'maxBytes', 'requestId']
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalid()
  const values: Record<string, unknown> = {}
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (field === undefined || !('value' in field) || !field.enumerable) invalid()
    values[name] = field.value
  }
  const { nonce, notAfter, maxBytes } = values
  if (
    values.version !== 2 ||
    typeof nonce !== 'string' ||
    !/^[0-9a-f]{64}$/.test(nonce) ||
    typeof notAfter !== 'number' ||
    !Number.isSafeInteger(notAfter) ||
    notAfter < 1 ||
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < snapshotArchiveLimits.headerCharge + 1 ||
    maxBytes > snapshotArchiveLimits.archiveBytes
  )
    invalid()
  const fields = { version: 2 as const, nonce, notAfter, maxBytes }
  const requestId = snapshotArchiveReaderRequestId(fields)
  if (values.requestId !== requestId) invalid()
  return Object.freeze({ ...fields, requestId })
}

export function validateSnapshotArchiveReaderRequest(
  input: unknown,
  now: number
): Readonly<SnapshotArchiveReaderRequest> {
  const request = parseSnapshotArchiveReaderRequest(input)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    request.notAfter <= now ||
    request.notAfter - now > snapshotArchiveLimits.lifetimeMs
  )
    invalid()
  return request
}
