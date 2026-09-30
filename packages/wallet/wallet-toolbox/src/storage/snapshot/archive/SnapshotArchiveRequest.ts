import { syncTransferDigest } from '../../remoting/SyncTransfer'
import { snapshotArchiveLimits } from './SnapshotArchive'

export interface SnapshotArchiveRequest {
  version: 1
  nonce: string
  notAfter: number
  maxBytes: number
  requestId: string
}

export interface SnapshotArchiveRequestReceipt {
  version: 1
  requestId: string
  expiresAt: number
  state: 'building' | 'ready' | 'closed' | 'failed' | 'expired'
  archiveId?: string
  digest?: string
}

/** Internal admission ownership; never part of an RPC result or argument. */
export interface SnapshotArchiveRequestOwner {
  identityKey: string
  requestId: string
  claimToken: string
}

function invalid(): never {
  throw new TypeError('Invalid snapshot archive creation request')
}

function fields(input: unknown): Omit<SnapshotArchiveRequest, 'requestId'> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const names = ['version', 'nonce', 'notAfter', 'maxBytes', 'requestId']
  if (Reflect.ownKeys(input).length !== names.length) invalid()
  const data: Record<string, unknown> = {}
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (field === undefined || !('value' in field) || !field.enumerable) invalid()
    data[name] = field.value
  }
  if (data.version !== 1 || typeof data.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(data.nonce)) invalid()
  const notAfter = data.notAfter
  const maxBytes = data.maxBytes
  if (typeof notAfter !== 'number' || !Number.isSafeInteger(notAfter) || notAfter < 1) invalid()
  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < snapshotArchiveLimits.headerCharge + 1 ||
    maxBytes > snapshotArchiveLimits.archiveBytes
  )
    invalid()
  const request = { version: 1 as const, nonce: data.nonce, notAfter, maxBytes }
  if (data.requestId !== snapshotArchiveRequestId(request)) invalid()
  return request
}

/** A deadline is part of the request identity, so an expired ID cannot reopen. */
export function snapshotArchiveRequestId(request: Omit<SnapshotArchiveRequest, 'requestId'>): string {
  return syncTransferDigest(
    new TextEncoder().encode(
      JSON.stringify(['wallet-snapshot-request/1', request.version, request.nonce, request.notAfter, request.maxBytes])
    )
  )
}

export function parseSnapshotArchiveRequest(input: unknown): Readonly<SnapshotArchiveRequest> {
  const request = fields(input)
  return Object.freeze({ ...request, requestId: snapshotArchiveRequestId(request) })
}

/** Validate against the database clock; callers obtain time from an authenticated offer. */
export function validateSnapshotArchiveRequest(input: unknown, now: number): Readonly<SnapshotArchiveRequest> {
  const request = parseSnapshotArchiveRequest(input)
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    request.notAfter <= now ||
    request.notAfter - now > snapshotArchiveLimits.lifetimeMs
  )
    invalid()
  return request
}
