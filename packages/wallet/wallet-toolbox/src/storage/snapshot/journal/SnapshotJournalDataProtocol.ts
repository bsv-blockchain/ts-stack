import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import {
  remoteSnapshotStorageKey,
  remoteSnapshotSyncRequestBytes,
  remoteSnapshotSyncResponseBytes,
  remoteSnapshotSyncPartBytes,
  remoteSnapshotSyncInlineFrameBytes
} from '../RemoteSnapshotSyncProtocol'
import { snapshotJournalArchiveEncoding, snapshotJournalArchivePacketBytes } from './SnapshotJournalArchivePacket'
import { parseSnapshotJournalArchiveBinding, type SnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import {
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  snapshotJournalDataText,
  parseSnapshotJournalReceiptBindingData,
  parseSnapshotJournalReceiptData
} from './SnapshotJournalReceiptData'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

export const snapshotJournalDataMethods = Object.freeze([
  'getSnapshotJournalDataContentReceipt',
  'confirmSnapshotJournalDataContentReceipt',
  'beginSnapshotJournalData',
  'getSnapshotJournalDataStatus',
  'stageSnapshotJournalDataPacket',
  'promoteSnapshotJournalData',
  'cleanupSnapshotJournalData',
  'beginSnapshotJournalDataTransfer',
  'writeSnapshotJournalDataTransferPart',
  'stageSnapshotJournalDataTransfer',
  'releaseSnapshotJournalDataTransfer'
] as const)
export type SnapshotJournalDataMethod = (typeof snapshotJournalDataMethods)[number]
export function isSnapshotJournalDataMethod(method: string): method is SnapshotJournalDataMethod {
  return (snapshotJournalDataMethods as readonly string[]).includes(method)
}
export const snapshotJournalDataCapabilities = Object.freeze({
  version: 1 as const,
  encoding: snapshotJournalArchiveEncoding,
  maxRequestBytes: remoteSnapshotSyncRequestBytes,
  maxResponseBytes: remoteSnapshotSyncResponseBytes,
  maxPacketBytes: snapshotJournalArchivePacketBytes,
  inlinePacketBytes: remoteSnapshotSyncInlineFrameBytes,
  partBytes: remoteSnapshotSyncPartBytes,
  maxIoMs: 30000
})
export const snapshotJournalDataContentCapabilities = Object.freeze({ version: 1 as const })
export function validateSnapshotJournalDataContentCapabilities(
  input: unknown
): typeof snapshotJournalDataContentCapabilities {
  if (snapshotJournalDataRecord(input, ['version']).version !== 1) invalid()
  return snapshotJournalDataContentCapabilities
}
export type SnapshotJournalDataCapabilities = typeof snapshotJournalDataCapabilities
function invalid(): never {
  throw new TypeError('Invalid authenticated journal destination DATA')
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
export function validateSnapshotJournalDataCapabilities(input: unknown): SnapshotJournalDataCapabilities {
  const row = snapshotJournalDataRecord(input, Object.keys(snapshotJournalDataCapabilities))
  if (Object.entries(snapshotJournalDataCapabilities).some(([key, value]) => row[key] !== value)) invalid()
  return snapshotJournalDataCapabilities
}

/** Structural comparison DATA; actual target admission must reread its stored
 * window/profile/root/schema/primary before using any supplied coordinates. */
export function parseSnapshotJournalDataCheckpoint(input: unknown): SnapshotJournalDestinationCheckpoint {
  const hasAfter = input !== null && typeof input === 'object' && Object.hasOwn(input, 'after'),
    row = snapshotJournalDataRecord(input, [
      'version',
      'sessionId',
      'binding',
      'sequence',
      'phase',
      'streamIndex',
      'tableIndex',
      'promotionSequence',
      ...(hasAfter ? ['after'] : [])
    ])
  if (row.version !== 1 || (row.phase !== 'intake' && row.phase !== 'promoting' && row.phase !== 'acknowledged'))
    invalid()
  let after
  if (hasAfter) {
    const value = snapshotJournalDataRecord(row.after, ['revision', 'id1', 'id2', 'exactText'])
    after = {
      revision: snapshotJournalRevision(value.revision),
      id1: integer(value.id1, -Number.MAX_SAFE_INTEGER),
      id2: integer(value.id2),
      exactText: snapshotJournalDataText(value.exactText, 400)
    }
  }
  return {
    version: 1,
    sessionId: snapshotJournalDataDigest(row.sessionId),
    binding: snapshotJournalDataDigest(row.binding),
    sequence: integer(row.sequence),
    phase: row.phase,
    streamIndex: integer(row.streamIndex, 0, 15),
    tableIndex: integer(row.tableIndex, 0, 12),
    promotionSequence: integer(row.promotionSequence),
    ...(after === undefined ? {} : { after })
  }
}
export function parseSnapshotJournalDataBinding(
  input: unknown,
  encoding?: 'wallet-journal-fields/1'
): SnapshotJournalDestinationBinding {
  const fieldEncoding = input !== null && typeof input === 'object' && Object.hasOwn(input, 'fieldEncoding'),
    bootstrap = input !== null && typeof input === 'object' && Object.hasOwn(input, 'bootstrap'),
    row = snapshotJournalDataRecord(input, [
      'lineageVersion',
      ...(fieldEncoding ? ['fieldEncoding'] : []),
      ...(bootstrap ? ['bootstrap'] : []),
      'source',
      'receipt',
      'low',
      'destinationBackend',
      'destinationStorageIdentity',
      'destinationUserId',
      'primaryEpoch',
      'activeStorage'
    ])
  if (
    fieldEncoding !== (encoding === 'wallet-journal-fields/1') ||
    row.lineageVersion !== 2 ||
    (fieldEncoding && row.fieldEncoding !== 'wallet-journal-fields/1') ||
    (bootstrap && row.bootstrap !== true)
  )
    invalid()
  const source = parseSnapshotJournalReceiptBindingData(row.source),
    receipt = parseSnapshotJournalReceiptData(row.receipt, source),
    low = snapshotJournalRevision(row.low),
    backend = snapshotJournalDataDigest(row.destinationBackend),
    storage = remoteSnapshotStorageKey(row.destinationStorageIdentity)
  if (
    backend === source.backend ||
    storage === source.storageIdentity ||
    receipt.highWater === '0' ||
    compareSnapshotJournalRevisions(low, receipt.highWater) > 0 ||
    (bootstrap ? low !== '0' : compareSnapshotJournalRevisions(receipt.floor, low) > 0)
  )
    invalid()
  return {
    ...(fieldEncoding ? { fieldEncoding: 'wallet-journal-fields/1' as const } : {}),
    lineageVersion: 2,
    ...(bootstrap ? { bootstrap: true as const } : {}),
    source: { ...source },
    receipt: { ...receipt },
    low,
    destinationBackend: backend,
    destinationStorageIdentity: storage,
    destinationUserId: integer(row.destinationUserId, 1),
    primaryEpoch: snapshotJournalRevision(row.primaryEpoch),
    activeStorage: row.activeStorage === null ? null : snapshotJournalDataText(row.activeStorage, 256, 1)
  }
}
export function snapshotJournalDataBindingDigest(input: SnapshotJournalDestinationBinding): string {
  return toHex(
    sha256(
      new TextEncoder().encode(
        'snapshot-journal-destination-window-v1\n' +
          JSON.stringify(parseSnapshotJournalDataBinding(input, input.fieldEncoding))
      )
    )
  )
}
export interface SnapshotJournalDataStatus {
  readonly version: 1
  readonly binding: SnapshotJournalDestinationBinding
  readonly checkpoint: SnapshotJournalDestinationCheckpoint
  readonly progress: {
    commits: number
    pages: number
    examined: number
    payloadBytes: number
    inserts: number
    updates: number
  }
}
export function parseSnapshotJournalDataStatus(
  input: unknown,
  identityKey: string,
  sourceStorageIdentity: string,
  destinationStorageIdentity: string,
  encoding?: 'wallet-journal-fields/1'
): SnapshotJournalDataStatus {
  const row = snapshotJournalDataRecord(input, ['version', 'binding', 'checkpoint', 'progress']),
    binding = parseSnapshotJournalDataBinding(row.binding, encoding),
    checkpoint = parseSnapshotJournalDataCheckpoint(row.checkpoint),
    progress = snapshotJournalDataRecord(row.progress, [
      'commits',
      'pages',
      'examined',
      'payloadBytes',
      'inserts',
      'updates'
    ])
  if (
    row.version !== 1 ||
    binding.source.identityKey !== identityKey ||
    binding.source.storageIdentity !== sourceStorageIdentity ||
    binding.destinationStorageIdentity !== destinationStorageIdentity ||
    checkpoint.binding !== snapshotJournalDataBindingDigest(binding)
  )
    invalid()
  return {
    version: 1,
    binding,
    checkpoint,
    progress: {
      commits: integer(progress.commits),
      pages: integer(progress.pages),
      examined: integer(progress.examined),
      payloadBytes: integer(progress.payloadBytes),
      inserts: integer(progress.inserts),
      updates: integer(progress.updates)
    }
  }
}
export type SnapshotJournalDataInput = {
  method: SnapshotJournalDataMethod
  identityKey: string
  sourceStorageIdentity: string
  source?: SnapshotJournalArchiveBinding
  checkpoint?: SnapshotJournalDestinationCheckpoint
  revision?: Readonly<SnapshotSyncContentRevision>
  packet?: Uint8Array
  transferId?: string
  digest?: string
  totalBytes?: number
  offset?: number
  bytes?: Uint8Array
}
export function parseSnapshotJournalDataInput(
  method: SnapshotJournalDataMethod,
  params: unknown[],
  authenticatedIdentity: string
): SnapshotJournalDataInput {
  if (!isSnapshotJournalDataMethod(method)) invalid()
  if (
    !/^(02|03)[0-9a-f]{64}$/.test(authenticatedIdentity) ||
    !Array.isArray(params) ||
    Object.getOwnPropertyDescriptor(params, 'length')?.value !== 1 ||
    Reflect.ownKeys(params).length !== 2
  )
    invalid()
  const parameter = Object.getOwnPropertyDescriptor(params, '0')
  if (parameter === undefined || !Object.hasOwn(parameter, 'value') || !parameter.enumerable) invalid()
  const fields =
    method === 'beginSnapshotJournalData'
      ? ['source']
      : [
          'sourceStorageIdentity',
          ...([
            'getSnapshotJournalDataStatus',
            'getSnapshotJournalDataContentReceipt',
            'confirmSnapshotJournalDataContentReceipt',
            'releaseSnapshotJournalDataTransfer'
          ].includes(method)
            ? []
            : ['checkpoint']),
          ...(method === 'confirmSnapshotJournalDataContentReceipt'
            ? ['revision']
            : method === 'stageSnapshotJournalDataPacket'
              ? ['packet']
              : method === 'beginSnapshotJournalDataTransfer'
                ? ['digest', 'totalBytes']
                : method === 'writeSnapshotJournalDataTransferPart'
                  ? ['transferId', 'offset', 'bytes']
                  : method === 'stageSnapshotJournalDataTransfer' || method === 'releaseSnapshotJournalDataTransfer'
                    ? ['transferId']
                    : [])
        ]
  const row = snapshotJournalDataRecord(parameter.value, ['version', 'identityKey', ...fields])
  if (row.version !== 1 || row.identityKey !== authenticatedIdentity) invalid()
  if (method === 'beginSnapshotJournalData') {
    const source = parseSnapshotJournalArchiveBinding(row.source)
    if (source.user.identityKey !== authenticatedIdentity) invalid()
    return {
      method,
      identityKey: authenticatedIdentity,
      sourceStorageIdentity: remoteSnapshotStorageKey(source.sourceStorage.storageIdentityKey),
      source
    }
  }
  const result: SnapshotJournalDataInput = {
    method,
    identityKey: authenticatedIdentity,
    sourceStorageIdentity: remoteSnapshotStorageKey(row.sourceStorageIdentity)
  }
  if (method === 'confirmSnapshotJournalDataContentReceipt')
    result.revision = parseSnapshotSyncContentRevision(row.revision)
  if (Object.hasOwn(row, 'checkpoint')) result.checkpoint = parseSnapshotJournalDataCheckpoint(row.checkpoint)
  if (Object.hasOwn(row, 'transferId')) result.transferId = snapshotJournalDataDigest(row.transferId)
  if (method === 'stageSnapshotJournalDataPacket') {
    if (
      !(row.packet instanceof Uint8Array) ||
      row.packet.byteLength < 4 ||
      row.packet.byteLength > remoteSnapshotSyncInlineFrameBytes
    )
      invalid()
    result.packet = new Uint8Array(row.packet)
  }
  if (method === 'beginSnapshotJournalDataTransfer') {
    result.digest = snapshotJournalDataDigest(row.digest)
    result.totalBytes = integer(row.totalBytes, 4, snapshotJournalArchivePacketBytes)
  }
  if (method === 'writeSnapshotJournalDataTransferPart') {
    if (
      !(row.bytes instanceof Uint8Array) ||
      row.bytes.byteLength < 1 ||
      row.bytes.byteLength > remoteSnapshotSyncPartBytes
    )
      invalid()
    result.offset = integer(row.offset, 0, snapshotJournalArchivePacketBytes - 1)
    result.bytes = new Uint8Array(row.bytes)
  }
  return result
}
