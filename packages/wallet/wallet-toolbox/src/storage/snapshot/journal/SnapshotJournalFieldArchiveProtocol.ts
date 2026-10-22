import {
  parseSnapshotJournalFieldArchiveReference,
  type SnapshotJournalFieldArchiveReference
} from './SnapshotJournalReceiptData'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { snapshotArchiveRequestBytes, snapshotArchiveResponseBytes } from '../archive/SnapshotArchiveProtocol'
import {
  validateSnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderOptions
} from '../archive/SnapshotArchiveReaderRequest'
import { snapshotJournalFieldArchiveEncoding, snapshotJournalArchivePacketBytes } from './SnapshotJournalArchivePacket'
import {
  parseSnapshotJournalFieldArchiveReaderRequest,
  type SnapshotJournalFieldArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import {
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  parseSnapshotJournalArchivePosition,
  type SnapshotJournalArchivePosition
} from './SnapshotJournalReceiptData'

export const snapshotJournalFieldArchiveMethods = Object.freeze([
  'getSnapshotJournalFieldArchiveReaderOffer',
  'reopenSnapshotJournalFieldArchive',
  'retireSnapshotJournalFieldArchive',
  'admitSnapshotJournalFieldArchive',
  'getSnapshotJournalFieldArchiveStatus',
  'getSnapshotJournalFieldArchiveDirectory',
  'readSnapshotJournalFieldArchivePage',
  'cancelSnapshotJournalFieldArchiveRequest'
] as const)
export type SnapshotJournalFieldArchiveMethod = (typeof snapshotJournalFieldArchiveMethods)[number]
export function isSnapshotJournalFieldArchiveMethod(method: string): method is SnapshotJournalFieldArchiveMethod {
  return (snapshotJournalFieldArchiveMethods as readonly string[]).includes(method)
}
export interface SnapshotJournalFieldArchiveCapabilities {
  readonly version: 1
  readonly encoding: typeof snapshotJournalFieldArchiveEncoding
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
export function snapshotJournalFieldArchiveCapabilities(
  maxLifetimeMs: number
): Readonly<SnapshotJournalFieldArchiveCapabilities> {
  return Object.freeze({
    version: 1,
    encoding: snapshotJournalFieldArchiveEncoding,
    maxRequestBytes: snapshotArchiveRequestBytes,
    maxResponseBytes: snapshotArchiveResponseBytes,
    maxPageBytes: snapshotJournalArchivePacketBytes,
    maxArchiveBytes: snapshotArchiveLimits.archiveBytes,
    maxPages: snapshotArchiveLimits.pages,
    maxLifetimeMs: integer(maxLifetimeMs, 1, snapshotArchiveLimits.lifetimeMs)
  })
}
export function validateSnapshotJournalFieldArchiveCapabilities(
  input: unknown
): Readonly<SnapshotJournalFieldArchiveCapabilities> {
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
    expected = snapshotJournalFieldArchiveCapabilities(
      integer(value.maxLifetimeMs, 1, snapshotArchiveLimits.lifetimeMs)
    )
  if (Object.entries(expected).some(([key, part]) => value[key] !== part)) invalid()
  return expected
}
export type SnapshotJournalFieldArchiveRpcInput =
  | {
      method: 'reopenSnapshotJournalFieldArchive' | 'retireSnapshotJournalFieldArchive'
      identityKey: string
      reference: Readonly<SnapshotJournalFieldArchiveReference>
    }
  | {
      method: 'getSnapshotJournalFieldArchiveReaderOffer'
      identityKey: string
      options: Readonly<SnapshotArchiveReaderOptions>
      position: Readonly<SnapshotJournalArchivePosition> | undefined
    }
  | {
      method:
        | 'admitSnapshotJournalFieldArchive'
        | 'getSnapshotJournalFieldArchiveStatus'
        | 'cancelSnapshotJournalFieldArchiveRequest'
      identityKey: string
      request: Readonly<SnapshotJournalFieldArchiveReaderRequest>
    }
  | {
      method: 'getSnapshotJournalFieldArchiveDirectory'
      identityKey: string
      request: Readonly<SnapshotJournalFieldArchiveReaderRequest>
      archiveId: string
    }
  | {
      method: 'readSnapshotJournalFieldArchivePage'
      identityKey: string
      request: Readonly<SnapshotJournalFieldArchiveReaderRequest>
      archiveId: string
      sequence: number
    }

/** Strict new namespace. The original row/content parser stays version1/2. */
export function parseSnapshotJournalFieldArchiveRpcInput(
  method: SnapshotJournalFieldArchiveMethod,
  params: unknown[]
): SnapshotJournalFieldArchiveRpcInput {
  if (
    !Array.isArray(params) ||
    Reflect.ownKeys(params).length !== 2 ||
    Object.getOwnPropertyDescriptor(params, 'length')?.value !== 1
  )
    invalid()
  const parameter = Object.getOwnPropertyDescriptor(params, '0')
  if (parameter === undefined || !Object.hasOwn(parameter, 'value') || !parameter.enumerable) invalid()
  const extra =
      method === 'reopenSnapshotJournalFieldArchive' || method === 'retireSnapshotJournalFieldArchive'
        ? ['reference']
        : method === 'getSnapshotJournalFieldArchiveReaderOffer'
          ? ['options', 'position']
          : method === 'readSnapshotJournalFieldArchivePage'
            ? ['request', 'archiveId', 'sequence']
            : method === 'getSnapshotJournalFieldArchiveDirectory'
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
  if (method === 'getSnapshotJournalFieldArchiveReaderOffer')
    return {
      method,
      identityKey,
      options: validateSnapshotArchiveReaderOptions(value.options),
      position: parseSnapshotJournalArchivePosition(value.position)
    }
  if (method === 'reopenSnapshotJournalFieldArchive' || method === 'retireSnapshotJournalFieldArchive')
    return { method, identityKey, reference: parseSnapshotJournalFieldArchiveReference(value.reference) }
  const request = parseSnapshotJournalFieldArchiveReaderRequest(value.request)
  switch (method) {
    case 'admitSnapshotJournalFieldArchive':
    case 'getSnapshotJournalFieldArchiveStatus':
    case 'cancelSnapshotJournalFieldArchiveRequest':
      return { method, identityKey, request }
    case 'getSnapshotJournalFieldArchiveDirectory':
      return { method, identityKey, request, archiveId: snapshotJournalDataDigest(value.archiveId) }
    case 'readSnapshotJournalFieldArchivePage':
      return {
        method,
        identityKey,
        request,
        archiveId: snapshotJournalDataDigest(value.archiveId),
        sequence: integer(value.sequence, 0, snapshotArchiveLimits.pages - 1)
      }
  }
}
