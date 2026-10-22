import { snapshotJournalDataRecord, snapshotJournalDataDigest } from './SnapshotJournalReceiptData'
import {
  parseSnapshotJournalFieldUploadRequest,
  type SnapshotJournalFieldUploadRequest
} from './SnapshotJournalFieldUploadRequest'
import {
  parseSnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveBinding
} from './SnapshotJournalArchiveBinding'
import { parseSnapshotJournalDataCheckpoint, snapshotJournalDataCapabilities } from './SnapshotJournalDataProtocol'
import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { remoteSnapshotStorageKey } from '../RemoteSnapshotSyncProtocol'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'

export const snapshotJournalFieldRpcMethods = Object.freeze([
  'offerSnapshotJournalFieldUpload',
  'beginSnapshotJournalFieldUpload',
  'getSnapshotJournalFieldUploadStatus',
  'findSnapshotJournalFieldUpload',
  'resumeSnapshotJournalFieldUpload',
  'appendSnapshotJournalFieldPacket',
  'sealSnapshotJournalFieldUpload',
  'getSnapshotJournalFieldStatus',
  'stageSnapshotJournalFieldFrame',
  'promoteSnapshotJournalFields',
  'getSnapshotJournalFieldContentReceipt',
  'confirmSnapshotJournalFieldContentReceipt',
  'beginSnapshotJournalFieldTransfer',
  'writeSnapshotJournalFieldTransferPart',
  'appendSnapshotJournalFieldTransfer',
  'releaseSnapshotJournalFieldTransfer',
  'cancelSnapshotJournalFieldUpload'
] as const)
export type SnapshotJournalFieldRpcMethod = (typeof snapshotJournalFieldRpcMethods)[number]
export function isSnapshotJournalFieldRpcMethod(method: string): method is SnapshotJournalFieldRpcMethod {
  return (snapshotJournalFieldRpcMethods as readonly string[]).includes(method)
}
export const snapshotJournalFieldRpcCapabilities = Object.freeze({
  ...snapshotJournalDataCapabilities,
  version: 1 as const,
  encoding: 'wallet-journal-fields/1' as const
})
export type SnapshotJournalFieldRpcCapabilities = typeof snapshotJournalFieldRpcCapabilities
export function validateSnapshotJournalFieldRpcCapabilities(input: unknown) {
  const row = snapshotJournalDataRecord(input, Object.keys(snapshotJournalFieldRpcCapabilities))
  if (Object.entries(snapshotJournalFieldRpcCapabilities).some(([key, value]) => row[key] !== value))
    throw new TypeError('Invalid field destination capability')
  return snapshotJournalFieldRpcCapabilities
}
function integer(input: unknown, minimum: number, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum)
    throw new TypeError('Invalid field destination coordinate')
  return input
}
function bytes(input: unknown, maximum: number, minimum = 4): Uint8Array {
  const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
  if (
    !(input instanceof Uint8Array) ||
    length === undefined ||
    length.call(input) < minimum ||
    length.call(input) > maximum
  )
    throw new TypeError('Invalid bounded field destination bytes')
  return new Uint8Array(input)
}
export interface SnapshotJournalFieldRpcInput {
  source?: SnapshotJournalFieldArchiveBinding
  sourceStorageIdentity?: string
  request?: Readonly<SnapshotJournalFieldUploadRequest>
  checkpoint?: SnapshotJournalDestinationCheckpoint
  sequence?: number
  streamIndex?: number
  packet?: Uint8Array
  transferId?: string
  digest?: string
  totalBytes?: number
  offset?: number
  bytes?: Uint8Array
  revision?: SnapshotSyncContentRevision
}
/** All wire values remain bounded DATA. SQL admission is performed separately
 * by the actual authenticated endpoint and its stored upload/window owners. */
export function parseSnapshotJournalFieldRpcInput(
  method: SnapshotJournalFieldRpcMethod,
  params: unknown[],
  identityKey: string
): SnapshotJournalFieldRpcInput {
  if (
    !isSnapshotJournalFieldRpcMethod(method) ||
    !Array.isArray(params) ||
    Reflect.ownKeys(params).length !== 2 ||
    Object.getOwnPropertyDescriptor(params, 'length')?.value !== 1
  )
    throw new TypeError('Invalid field destination arguments')
  const p = Object.getOwnPropertyDescriptor(params, '0')
  if (p === undefined || !Object.hasOwn(p, 'value') || !p.enumerable)
    throw new TypeError('Invalid field destination argument')
  const extra =
      method === 'offerSnapshotJournalFieldUpload'
        ? ['source']
        : method === 'getSnapshotJournalFieldStatus' ||
            method === 'getSnapshotJournalFieldContentReceipt' ||
            method === 'findSnapshotJournalFieldUpload'
          ? ['sourceStorageIdentity']
          : method === 'confirmSnapshotJournalFieldContentReceipt'
            ? ['sourceStorageIdentity', 'revision']
            : method === 'cancelSnapshotJournalFieldUpload'
              ? ['request']
              : method === 'releaseSnapshotJournalFieldTransfer'
                ? ['transferId']
                : [
                    'source',
                    'request',
                    ...(method === 'appendSnapshotJournalFieldPacket'
                      ? ['sequence', 'streamIndex', 'packet']
                      : method === 'stageSnapshotJournalFieldFrame' || method === 'promoteSnapshotJournalFields'
                        ? ['checkpoint']
                        : method === 'beginSnapshotJournalFieldTransfer'
                          ? ['sequence', 'streamIndex', 'digest', 'totalBytes']
                          : method === 'writeSnapshotJournalFieldTransferPart'
                            ? ['sequence', 'streamIndex', 'transferId', 'offset', 'bytes']
                            : method === 'appendSnapshotJournalFieldTransfer'
                              ? ['sequence', 'streamIndex', 'transferId']
                              : [])
                  ],
    row = snapshotJournalDataRecord(p.value, ['version', 'identityKey', ...extra]),
    result: SnapshotJournalFieldRpcInput = {}
  if (row.version !== 1 || row.identityKey !== identityKey || !/^(02|03)[0-9a-f]{64}$/.test(identityKey))
    throw new TypeError('Field destination authenticated profile differs')
  if (extra.includes('source')) {
    result.source = parseSnapshotJournalFieldArchiveBinding(row.source)
    if (result.source.user.identityKey !== identityKey) throw new TypeError('Field upload source profile differs')
  }
  if (extra.includes('sourceStorageIdentity'))
    result.sourceStorageIdentity = remoteSnapshotStorageKey(row.sourceStorageIdentity)
  if (extra.includes('request')) result.request = parseSnapshotJournalFieldUploadRequest(row.request)
  if (extra.includes('checkpoint')) result.checkpoint = parseSnapshotJournalDataCheckpoint(row.checkpoint)
  if (extra.includes('sequence')) result.sequence = integer(row.sequence, 0, 4095)
  if (extra.includes('streamIndex')) result.streamIndex = integer(row.streamIndex, 0, 14)
  if (extra.includes('packet')) result.packet = bytes(row.packet, snapshotJournalFieldRpcCapabilities.inlinePacketBytes)
  if (extra.includes('transferId')) result.transferId = snapshotJournalDataDigest(row.transferId)
  if (extra.includes('digest')) result.digest = snapshotJournalDataDigest(row.digest)
  if (extra.includes('totalBytes'))
    result.totalBytes = integer(row.totalBytes, 4, snapshotJournalFieldRpcCapabilities.maxPacketBytes)
  if (extra.includes('offset'))
    result.offset = integer(row.offset, 0, snapshotJournalFieldRpcCapabilities.maxPacketBytes)
  if (extra.includes('bytes')) result.bytes = bytes(row.bytes, snapshotJournalFieldRpcCapabilities.partBytes, 1)
  if (extra.includes('revision')) result.revision = parseSnapshotSyncContentRevision(row.revision)
  return result
}
