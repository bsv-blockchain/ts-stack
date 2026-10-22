import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { snapshotArchiveRequestBytes, snapshotArchiveResponseBytes } from '../archive/SnapshotArchiveProtocol'
import {
  validateSnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderOptions
} from '../archive/SnapshotArchiveReaderRequest'
import { snapshotJournalArchiveEncoding, snapshotJournalArchivePacketBytes } from './SnapshotJournalArchivePacket'
import {
  parseSnapshotJournalArchiveReaderRequest,
  type SnapshotJournalArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import {
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  parseSnapshotJournalArchivePosition,
  type SnapshotJournalArchivePosition
} from './SnapshotJournalReceiptData'

export const snapshotJournalArchiveMethods = Object.freeze([
  'getSnapshotJournalArchiveReaderOffer',
  'admitSnapshotJournalArchive',
  'getSnapshotJournalArchiveStatus',
  'getSnapshotJournalArchiveDirectory',
  'readSnapshotJournalArchivePage',
  'cancelSnapshotJournalArchiveRequest'
] as const)
export type SnapshotJournalArchiveMethod = (typeof snapshotJournalArchiveMethods)[number]
export function isSnapshotJournalArchiveMethod(method: string): method is SnapshotJournalArchiveMethod {
  return (snapshotJournalArchiveMethods as readonly string[]).includes(method)
}
export interface SnapshotJournalArchiveCapabilities {
  readonly version: 1
  readonly encoding: typeof snapshotJournalArchiveEncoding
  readonly maxRequestBytes: typeof snapshotArchiveRequestBytes
  readonly maxResponseBytes: typeof snapshotArchiveResponseBytes
  readonly maxPageBytes: typeof snapshotJournalArchivePacketBytes
  readonly maxArchiveBytes: number
  readonly maxPages: number
  readonly maxLifetimeMs: number
}
function invalid(): never {
  throw new TypeError('Invalid authenticated journal archive protocol DATA')
}
function integer(input: unknown, minimum: number, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) invalid()
  return input
}
export function snapshotJournalArchiveCapabilities(
  maxLifetimeMs: number
): Readonly<SnapshotJournalArchiveCapabilities> {
  return Object.freeze({
    version: 1,
    encoding: snapshotJournalArchiveEncoding,
    maxRequestBytes: snapshotArchiveRequestBytes,
    maxResponseBytes: snapshotArchiveResponseBytes,
    maxPageBytes: snapshotJournalArchivePacketBytes,
    maxArchiveBytes: snapshotArchiveLimits.archiveBytes,
    maxPages: snapshotArchiveLimits.pages,
    maxLifetimeMs: integer(maxLifetimeMs, 1, snapshotArchiveLimits.lifetimeMs)
  })
}
export function validateSnapshotJournalArchiveCapabilities(
  input: unknown
): Readonly<SnapshotJournalArchiveCapabilities> {
  const value = snapshotJournalDataRecord(input, [
      'version',
      'encoding',
      'maxRequestBytes',
      'maxResponseBytes',
      'maxPageBytes',
      'maxArchiveBytes',
      'maxPages',
      'maxLifetimeMs'
    ]),
    expected = snapshotJournalArchiveCapabilities(integer(value.maxLifetimeMs, 1, snapshotArchiveLimits.lifetimeMs))
  if (Object.entries(expected).some(([key, part]) => value[key] !== part)) invalid()
  return expected
}
export type SnapshotJournalArchiveRpcInput =
  | {
      method: 'getSnapshotJournalArchiveReaderOffer'
      identityKey: string
      options: Readonly<SnapshotArchiveReaderOptions>
      position: Readonly<SnapshotJournalArchivePosition> | undefined
    }
  | {
      method: 'admitSnapshotJournalArchive' | 'getSnapshotJournalArchiveStatus' | 'cancelSnapshotJournalArchiveRequest'
      identityKey: string
      request: Readonly<SnapshotJournalArchiveReaderRequest>
    }
  | {
      method: 'getSnapshotJournalArchiveDirectory'
      identityKey: string
      request: Readonly<SnapshotJournalArchiveReaderRequest>
      archiveId: string
    }
  | {
      method: 'readSnapshotJournalArchivePage'
      identityKey: string
      request: Readonly<SnapshotJournalArchiveReaderRequest>
      archiveId: string
      sequence: number
    }

/** Strict new namespace. The original row/content parser stays version1/2. */
export function parseSnapshotJournalArchiveRpcInput(
  method: SnapshotJournalArchiveMethod,
  params: unknown[]
): SnapshotJournalArchiveRpcInput {
  if (
    !Array.isArray(params) ||
    Reflect.ownKeys(params).length !== 2 ||
    Object.getOwnPropertyDescriptor(params, 'length')?.value !== 1
  )
    invalid()
  const parameter = Object.getOwnPropertyDescriptor(params, '0')
  if (parameter === undefined || !Object.hasOwn(parameter, 'value') || !parameter.enumerable) invalid()
  const extra =
      method === 'getSnapshotJournalArchiveReaderOffer'
        ? ['options', 'position']
        : method === 'readSnapshotJournalArchivePage'
          ? ['request', 'archiveId', 'sequence']
          : method === 'getSnapshotJournalArchiveDirectory'
            ? ['request', 'archiveId']
            : ['request'],
    value = snapshotJournalDataRecord(parameter.value, ['version', 'identityKey', ...extra])
  if (
    value.version !== 1 ||
    typeof value.identityKey !== 'string' ||
    !/^(02|03)[0-9a-fA-F]{64}$/.test(value.identityKey)
  )
    invalid()
  const identityKey = value.identityKey
  if (method === 'getSnapshotJournalArchiveReaderOffer')
    return {
      method,
      identityKey,
      options: validateSnapshotArchiveReaderOptions(value.options),
      position: parseSnapshotJournalArchivePosition(value.position)
    }
  const request = parseSnapshotJournalArchiveReaderRequest(value.request)
  switch (method) {
    case 'admitSnapshotJournalArchive':
    case 'getSnapshotJournalArchiveStatus':
    case 'cancelSnapshotJournalArchiveRequest':
      return { method, identityKey, request }
    case 'getSnapshotJournalArchiveDirectory':
      return { method, identityKey, request, archiveId: snapshotJournalDataDigest(value.archiveId) }
    case 'readSnapshotJournalArchivePage':
      return {
        method,
        identityKey,
        request,
        archiveId: snapshotJournalDataDigest(value.archiveId),
        sequence: integer(value.sequence, 0, snapshotArchiveLimits.pages - 1)
      }
  }
}
