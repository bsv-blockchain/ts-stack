import { snapshotArchiveLimits } from './SnapshotArchive'
import { snapshotArchiveEncoding } from './SnapshotArchiveDirectory'
import {
  parseSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestReceipt
} from './SnapshotArchiveRequest'

/** Includes JSON-RPC framing, compact binary tags and HTML escaping. */
export const snapshotArchiveResponseBytes = 2 * 1024 * 1024
export const snapshotArchiveRequestBytes = 4096
export const snapshotArchiveCapabilities = Object.freeze({
  version: 1 as const,
  encoding: snapshotArchiveEncoding,
  maxResponseBytes: snapshotArchiveResponseBytes,
  maxArchiveBytes: snapshotArchiveLimits.archiveBytes,
  maxPageBytes: snapshotArchiveLimits.pageBytes,
  maxPages: snapshotArchiveLimits.pages,
  maxLifetimeMs: snapshotArchiveLimits.lifetimeMs
})
export type SnapshotArchiveCapabilities = typeof snapshotArchiveCapabilities

export const snapshotArchiveMethods = Object.freeze([
  'getSnapshotArchiveOffer',
  'startSnapshotArchive',
  'getSnapshotArchiveStatus',
  'getSnapshotArchiveDirectory',
  'readSnapshotArchivePage',
  'cancelSnapshotArchive'
] as const)
export type SnapshotArchiveMethod = (typeof snapshotArchiveMethods)[number]

export interface SnapshotArchiveOffer {
  version: 1
  serverTime: number
  sourceStorageIdentityKey: string
  sourceSchema: string
  chain: 'main' | 'test'
}

function invalid(): never {
  throw new TypeError('Invalid snapshot archive protocol value')
}

function record(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  if (Reflect.ownKeys(input).length !== names.length) invalid()
  const result: Record<string, unknown> = {}
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name)
    if (property === undefined || !('value' in property) || !property.enumerable) invalid()
    result[name] = property.value
  }
  return result
}

function integer(input: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) invalid()
  return input
}

function digest(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) invalid()
  return input
}

export function validateSnapshotArchiveCapabilities(input: unknown): SnapshotArchiveCapabilities {
  const value = record(input, Object.keys(snapshotArchiveCapabilities))
  for (const [key, expected] of Object.entries(snapshotArchiveCapabilities)) {
    if (value[key] !== expected) invalid()
  }
  return snapshotArchiveCapabilities
}

export type SnapshotArchiveRpcInput =
  | { method: 'getSnapshotArchiveOffer'; identityKey: string }
  | { method: 'startSnapshotArchive'; identityKey: string; request: Readonly<SnapshotArchiveRequest> }
  | { method: 'getSnapshotArchiveStatus' | 'cancelSnapshotArchive'; identityKey: string; requestId: string }
  | { method: 'getSnapshotArchiveDirectory'; identityKey: string; archiveId: string }
  | { method: 'readSnapshotArchivePage'; identityKey: string; archiveId: string; sequence: number }

function requestFields(method: SnapshotArchiveMethod): string[] {
  switch (method) {
    case 'startSnapshotArchive':
      return ['request']
    case 'getSnapshotArchiveStatus':
    case 'cancelSnapshotArchive':
      return ['requestId']
    case 'getSnapshotArchiveDirectory':
      return ['archiveId']
    case 'readSnapshotArchivePage':
      return ['archiveId', 'sequence']
    default:
      return []
  }
}

/** Exact method-specific data only; ownership tokens have no wire representation. */
export function parseSnapshotArchiveRpcInput(
  method: SnapshotArchiveMethod,
  params: unknown[]
): SnapshotArchiveRpcInput {
  if (params.length !== 1) invalid()
  const input = record(params[0], ['version', 'identityKey', ...requestFields(method)])
  if (input.version !== 1 || typeof input.identityKey !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(input.identityKey))
    invalid()
  const identityKey = input.identityKey
  switch (method) {
    case 'getSnapshotArchiveOffer':
      return { method, identityKey }
    case 'startSnapshotArchive':
      return { method, identityKey, request: parseSnapshotArchiveRequest(input.request) }
    case 'getSnapshotArchiveStatus':
    case 'cancelSnapshotArchive':
      return { method, identityKey, requestId: digest(input.requestId) }
    case 'getSnapshotArchiveDirectory':
      return { method, identityKey, archiveId: digest(input.archiveId) }
    case 'readSnapshotArchivePage':
      return {
        method,
        identityKey,
        archiveId: digest(input.archiveId),
        sequence: integer(input.sequence, 0, snapshotArchiveLimits.pages - 1)
      }
  }
}

export function validateSnapshotArchiveOffer(
  input: unknown,
  storageIdentityKey: string,
  chain: 'main' | 'test'
): Readonly<SnapshotArchiveOffer> {
  const value = record(input, ['version', 'serverTime', 'sourceStorageIdentityKey', 'sourceSchema', 'chain'])
  if (
    value.version !== 1 ||
    value.sourceStorageIdentityKey !== storageIdentityKey ||
    value.chain !== chain ||
    typeof value.sourceSchema !== 'string' ||
    value.sourceSchema.length < 1 ||
    value.sourceSchema.length > 256
  )
    invalid()
  return Object.freeze({
    version: 1,
    serverTime: integer(value.serverTime, 0),
    sourceStorageIdentityKey: storageIdentityKey,
    sourceSchema: value.sourceSchema,
    chain
  })
}

export function validateSnapshotArchiveRequestReceipt(
  input: unknown,
  request: SnapshotArchiveRequest
): Readonly<SnapshotArchiveRequestReceipt> {
  const state =
    input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'state')?.value : undefined
  const value = record(input, [
    'version',
    'requestId',
    'expiresAt',
    'state',
    ...(state === 'ready' ? ['archiveId', 'digest'] : [])
  ])
  if (
    value.version !== 1 ||
    value.requestId !== request.requestId ||
    value.expiresAt !== request.notAfter ||
    !['building', 'ready', 'closed', 'failed', 'expired', 'resource-limited'].includes(state)
  )
    invalid()
  return Object.freeze({
    version: 1,
    requestId: request.requestId,
    expiresAt: request.notAfter,
    state,
    ...(state === 'ready' ? { archiveId: digest(value.archiveId), digest: digest(value.digest) } : {})
  })
}
