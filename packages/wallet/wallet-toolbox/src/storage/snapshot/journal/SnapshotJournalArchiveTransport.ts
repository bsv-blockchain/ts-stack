import type { SnapshotArchiveChain } from '../archive/SnapshotArchiveChain'
import { awaitFromSync } from '../../../utility/promiseFromSync'
import {
  validateSnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderOptions
} from '../archive/SnapshotArchiveReaderRequest'
import {
  validateSnapshotArchiveOffer,
  validateSnapshotArchiveRequestReceipt,
  type SnapshotArchiveOffer
} from '../archive/SnapshotArchiveProtocol'
import { validateSnapshotArchiveCancellation } from '../archive/SnapshotArchiveCleanup'
import { verifySnapshotArchivePage } from '../archive/SnapshotArchiveDirectory'
import type { SnapshotArchiveAdmission } from '../archive/SnapshotArchiveAdmission'
import type { SnapshotArchiveRequestReceipt } from '../archive/SnapshotArchiveRequest'
import {
  parseSnapshotJournalArchiveRpcInput,
  validateSnapshotJournalArchiveCapabilities,
  type SnapshotJournalArchiveCapabilities,
  type SnapshotJournalArchiveMethod
} from './SnapshotJournalArchiveProtocol'
import {
  parseSnapshotJournalArchiveReaderRequest,
  validateSnapshotJournalArchiveReaderRequest,
  type SnapshotJournalArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import {
  parseSnapshotJournalArchivePosition,
  snapshotJournalDataRecord,
  type SnapshotJournalArchivePosition
} from './SnapshotJournalReceiptData'
import {
  verifySnapshotJournalArchiveDirectory,
  type VerifiedSnapshotJournalArchiveDirectory
} from './SnapshotJournalArchiveDirectory'

export type SnapshotJournalArchiveRpcCall = (
  method: SnapshotJournalArchiveMethod,
  params: unknown[],
  signal?: AbortSignal
) => Promise<unknown>
export type SnapshotJournalArchiveOffer =
  | {
      readonly version: 1
      readonly outcome: 'offered'
      readonly offer: Readonly<SnapshotArchiveOffer>
      readonly request: Readonly<SnapshotJournalArchiveReaderRequest>
    }
  | { readonly version: 1; readonly outcome: 'resource-limited' }

/** Authenticated bounded DATA transport. Neither its receipt nor its directory
 * implements a live SQL source or a destination writer. */
export class SnapshotJournalArchiveTransport {
  readonly capabilities: Readonly<SnapshotJournalArchiveCapabilities>
  constructor(
    private readonly rpc: SnapshotJournalArchiveRpcCall,
    private readonly identityKey: string,
    private readonly storageIdentityKey: string,
    private readonly chain: SnapshotArchiveChain,
    capabilities: SnapshotJournalArchiveCapabilities
  ) {
    this.capabilities = validateSnapshotJournalArchiveCapabilities(capabilities)
  }
  private call(
    method: SnapshotJournalArchiveMethod,
    fields: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    return awaitFromSync(() => {
      const params = [{ version: 1, identityKey: this.identityKey, ...fields }]
      parseSnapshotJournalArchiveRpcInput(method, params)
      return this.rpc(method, params, signal)
    })
  }
  async offer(
    input: SnapshotArchiveReaderOptions,
    inputPosition?: SnapshotJournalArchivePosition,
    signal?: AbortSignal
  ): Promise<SnapshotJournalArchiveOffer> {
    const options = validateSnapshotArchiveReaderOptions(input),
      position = parseSnapshotJournalArchivePosition(inputPosition ?? null) ?? null
    if (options.lifetimeMs > this.capabilities.maxLifetimeMs)
      throw new TypeError('Journal archive offer exceeds negotiated lifetime')
    const value = await this.call('getSnapshotJournalArchiveReaderOffer', { options, position }, signal)
    const outcome =
      value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'outcome')?.value : undefined
    const row = snapshotJournalDataRecord(
      value,
      outcome === 'offered' ? ['version', 'outcome', 'offer', 'request'] : ['version', 'outcome']
    )
    if (row.version !== 1) throw new TypeError('Invalid journal archive offer')
    if (row.outcome === 'resource-limited') return Object.freeze({ version: 1, outcome: 'resource-limited' })
    if (row.outcome !== 'offered') throw new TypeError('Invalid journal archive offer')
    const offer = validateSnapshotArchiveOffer(row.offer, this.storageIdentityKey, this.chain),
      request = validateSnapshotJournalArchiveReaderRequest(row.request, offer.serverTime)
    if (
      request.notAfter !== offer.serverTime + options.lifetimeMs ||
      request.maxBytes !== options.maxBytes ||
      JSON.stringify(request.position) !== JSON.stringify(position)
    )
      throw new TypeError('Journal archive offer changed requested bounds')
    return Object.freeze({ version: 1, outcome: 'offered', offer, request })
  }
  async admit(
    input: SnapshotJournalArchiveReaderRequest,
    signal?: AbortSignal
  ): Promise<Readonly<SnapshotArchiveAdmission>> {
    const request = parseSnapshotJournalArchiveReaderRequest(input),
      value = await this.call('admitSnapshotJournalArchive', { request }, signal)
    const outcome =
      value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'outcome')?.value : undefined
    const row = snapshotJournalDataRecord(
      value,
      outcome === 'accepted' ? ['version', 'outcome', 'receipt'] : ['version', 'outcome', 'requestId', 'expiresAt']
    )
    if (row.version !== 1) throw new TypeError('Invalid journal archive admission')
    if (row.outcome === 'accepted')
      return Object.freeze({
        version: 1,
        outcome: 'accepted',
        receipt: validateSnapshotArchiveRequestReceipt(row.receipt, request)
      })
    if (row.outcome !== 'resource-limited' || row.requestId !== request.requestId || row.expiresAt !== request.notAfter)
      throw new TypeError('Invalid journal archive admission')
    return Object.freeze({
      version: 1,
      outcome: 'resource-limited',
      requestId: request.requestId,
      expiresAt: request.notAfter
    })
  }
  async status(
    input: SnapshotJournalArchiveReaderRequest,
    signal?: AbortSignal
  ): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
    const request = parseSnapshotJournalArchiveReaderRequest(input)
    return validateSnapshotArchiveRequestReceipt(
      await this.call('getSnapshotJournalArchiveStatus', { request }, signal),
      request
    )
  }
  async cancelRequest(input: SnapshotJournalArchiveReaderRequest, signal?: AbortSignal): Promise<void> {
    const request = parseSnapshotJournalArchiveReaderRequest(input)
    validateSnapshotArchiveCancellation(
      await this.call('cancelSnapshotJournalArchiveRequest', { request }, signal),
      request.requestId
    )
  }
  async directory(
    input: SnapshotJournalArchiveReaderRequest,
    receipt: SnapshotArchiveRequestReceipt,
    offer: SnapshotArchiveOffer,
    now: number,
    signal?: AbortSignal
  ): Promise<VerifiedSnapshotJournalArchiveDirectory> {
    const request = parseSnapshotJournalArchiveReaderRequest(input),
      ready = validateSnapshotArchiveRequestReceipt(receipt, request)
    if (ready.state !== 'ready' || ready.archiveId === undefined || ready.digest === undefined)
      throw new TypeError('Journal archive is not ready')
    return verifySnapshotJournalArchiveDirectory(
      await this.call('getSnapshotJournalArchiveDirectory', { request, archiveId: ready.archiveId }, signal),
      {
        identityKey: this.identityKey,
        chain: this.chain,
        sourceStorageIdentityKey: this.storageIdentityKey,
        sourceSchema: offer.sourceSchema,
        archiveId: ready.archiveId,
        digest: ready.digest,
        expiresAt: ready.expiresAt,
        ...(request.position === null ? {} : { position: request.position })
      },
      now
    )
  }
  async page(
    input: SnapshotJournalArchiveReaderRequest,
    directory: VerifiedSnapshotJournalArchiveDirectory,
    sequence: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= directory.receipts.length)
      throw new TypeError('Invalid journal archive packet sequence')
    const request = parseSnapshotJournalArchiveReaderRequest(input)
    return verifySnapshotArchivePage(
      await this.call(
        'readSnapshotJournalArchivePage',
        { request, archiveId: directory.manifest.archiveId, sequence },
        signal
      ),
      directory.receipts[sequence]
    )
  }
}
