import type { SnapshotArchiveChain } from './SnapshotArchiveChain'
import { awaitFromSync } from '../../../utility/promiseFromSync'
import {
  validateSnapshotArchiveReaderOffer,
  validateSnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderOffer
} from './SnapshotArchiveReaderOffer'
import { parseSnapshotArchiveReaderRequest, type SnapshotArchiveReaderRequest } from './SnapshotArchiveReaderRequest'
import { validateSnapshotArchiveAdmission, type SnapshotArchiveAdmission } from './SnapshotArchiveAdmission'
import { validateSnapshotArchiveCancellation } from './SnapshotArchiveCleanup'
import {
  verifySnapshotArchiveDirectory,
  verifySnapshotArchivePage,
  type VerifiedSnapshotArchiveDirectory
} from './SnapshotArchiveDirectory'
import {
  parseSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestReceipt
} from './SnapshotArchiveRequest'
import {
  parseSnapshotArchiveRpcInput,
  validateSnapshotArchiveOffer,
  validateSnapshotArchiveRequestReceipt,
  type SnapshotArchiveMethod,
  type SnapshotArchiveOffer
} from './SnapshotArchiveProtocol'

export type SnapshotArchiveRpcCall = (
  method: SnapshotArchiveMethod,
  params: unknown[],
  signal?: AbortSignal
) => Promise<unknown>

/** Bounded authenticated transport; a verified row reader is a separate layer. */
export class SnapshotArchiveTransport {
  constructor(
    private readonly rpc: SnapshotArchiveRpcCall,
    private readonly identityKey: string,
    private readonly sourceStorageIdentityKey: string,
    private readonly chain: SnapshotArchiveChain,
    readonly supportsReader = false,
    readonly contentRevision = false
  ) {
    parseSnapshotArchiveRpcInput('getSnapshotArchiveOffer', [{ version: 1, identityKey }])
  }

  private call(method: SnapshotArchiveMethod, fields: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return awaitFromSync(() => {
      const params = [{ version: 1, identityKey: this.identityKey, ...fields }]
      parseSnapshotArchiveRpcInput(method, params)
      return this.rpc(method, params, signal)
    })
  }

  async offer(signal?: AbortSignal): Promise<Readonly<SnapshotArchiveOffer>> {
    return validateSnapshotArchiveOffer(
      await this.call('getSnapshotArchiveOffer', {}, signal),
      this.sourceStorageIdentityKey,
      this.chain
    )
  }

  async start(input: SnapshotArchiveRequest, signal?: AbortSignal): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
    const request = parseSnapshotArchiveRequest(input)
    return validateSnapshotArchiveRequestReceipt(await this.call('startSnapshotArchive', { request }, signal), request)
  }

  async status(input: SnapshotArchiveRequest, signal?: AbortSignal): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
    const request = parseSnapshotArchiveRequest(input)
    return validateSnapshotArchiveRequestReceipt(
      await this.call('getSnapshotArchiveStatus', { requestId: request.requestId }, signal),
      request
    )
  }

  private requireReader(): void {
    if (!this.supportsReader) throw new TypeError('Snapshot archive reader was not negotiated')
  }

  async readerOffer(
    input: SnapshotArchiveReaderOptions,
    signal?: AbortSignal
  ): Promise<Readonly<SnapshotArchiveReaderOffer>> {
    this.requireReader()
    const options = validateSnapshotArchiveReaderOptions(input)
    return validateSnapshotArchiveReaderOffer(
      await this.call(
        this.contentRevision ? 'getSnapshotContentArchiveReaderOffer' : 'getSnapshotArchiveReaderOffer',
        { options },
        signal
      ),
      options,
      this.sourceStorageIdentityKey,
      this.chain
    )
  }

  async admit(input: SnapshotArchiveReaderRequest, signal?: AbortSignal): Promise<Readonly<SnapshotArchiveAdmission>> {
    this.requireReader()
    const request = parseSnapshotArchiveReaderRequest(input)
    return validateSnapshotArchiveAdmission(
      await this.call(
        this.contentRevision ? 'admitSnapshotContentArchive' : 'admitSnapshotArchive',
        { request },
        signal
      ),
      request
    )
  }

  async readerStatus(
    input: SnapshotArchiveReaderRequest,
    signal?: AbortSignal
  ): Promise<Readonly<SnapshotArchiveRequestReceipt>> {
    this.requireReader()
    const request = parseSnapshotArchiveReaderRequest(input)
    return validateSnapshotArchiveRequestReceipt(
      await this.call('getSnapshotArchiveStatus', { requestId: request.requestId }, signal),
      request
    )
  }

  async cancelRequest(input: SnapshotArchiveReaderRequest, signal?: AbortSignal): Promise<void> {
    this.requireReader()
    const request = parseSnapshotArchiveReaderRequest(input)
    validateSnapshotArchiveCancellation(
      await this.call('cancelSnapshotArchiveRequest', { request }, signal),
      request.requestId
    )
  }

  async directory(
    receipt: Readonly<SnapshotArchiveRequestReceipt>,
    offer: Readonly<SnapshotArchiveOffer>,
    now: number,
    signal?: AbortSignal
  ): Promise<VerifiedSnapshotArchiveDirectory> {
    if (receipt.state !== 'ready' || receipt.archiveId === undefined || receipt.digest === undefined)
      throw new TypeError('Snapshot archive is not ready')
    const archiveId = receipt.archiveId
    const digest = receipt.digest
    const expiresAt = receipt.expiresAt
    const sourceSchema = offer.sourceSchema
    const value = await this.call('getSnapshotArchiveDirectory', { archiveId }, signal)
    const verified = verifySnapshotArchiveDirectory(
      value,
      {
        identityKey: this.identityKey,
        chain: this.chain,
        sourceStorageIdentityKey: this.sourceStorageIdentityKey,
        archiveId,
        digest,
        sourceSchema,
        ...(this.contentRevision ? { contentRevision: true as const } : {})
      },
      now
    )
    if (verified.manifest.expiresAt !== expiresAt) throw new TypeError('Snapshot archive expiry changed')
    return verified
  }

  async page(directory: VerifiedSnapshotArchiveDirectory, sequence: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= directory.receipts.length)
      throw new TypeError('Invalid snapshot archive page sequence')
    const receipt = directory.receipts[sequence]
    const value = await this.call(
      'readSnapshotArchivePage',
      { archiveId: directory.manifest.archiveId, sequence },
      signal
    )
    return verifySnapshotArchivePage(value, receipt)
  }

  async cancel(requestId: string, signal?: AbortSignal): Promise<void> {
    if ((await this.call('cancelSnapshotArchive', { requestId }, signal)) !== true)
      throw new TypeError('Invalid snapshot archive cancellation receipt')
  }
}
