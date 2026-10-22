import { parseSnapshotJournalFieldArchiveReaderRequest } from '../journal/SnapshotJournalArchiveReaderRequest'
import { captureSnapshotJournalFieldArchiveSource } from '../journal/captureSnapshotJournalFieldArchiveSource'
import { closeSnapshotJournalSource } from '../journal/closeSnapshotJournalSource'
import { parseSnapshotJournalArchiveReaderRequest } from '../journal/SnapshotJournalArchiveReaderRequest'
import {
  parseSnapshotJournalArchivePosition,
  type SnapshotJournalArchivePosition
} from '../journal/SnapshotJournalReceiptData'
import type { SnapshotJournalReconciliationSource } from '../journal/SnapshotJournalProvider'
import { captureSnapshotJournalArchiveSource } from '../journal/captureSnapshotJournalArchiveSource'
import { readSnapshotJournalCaptureConfiguration } from '../journal/SnapshotJournalLifecycle'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { parseSnapshotArchiveReaderRequest, type SnapshotArchiveReaderRequest } from './SnapshotArchiveReaderRequest'
import { validateSnapshotArchiveReaderOptions, type SnapshotArchiveReaderOptions } from './SnapshotArchiveReaderOffer'
import { WERR_INVALID_OPERATION, WERR_NOT_IMPLEMENTED } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import type { Knex } from 'knex'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotArchiveAdmissionLimitError, type SnapshotArchiveAdmission } from './SnapshotArchiveAdmission'
import { SnapshotArchiveSourceCleanupError, type SnapshotArchiveSource } from './KnexSnapshotArchiveSource'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import {
  parseSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestReceipt,
  type SnapshotArchiveRequestOwner,
  type SnapshotArchiveTerminalState
} from './SnapshotArchiveRequest'
import { snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import { assertSnapshotArchiveCaptureActive, captureSnapshotArchiveSource } from './captureSnapshotArchiveSource'

interface Capture {
  identityKey: string
  content: boolean
  journal: boolean | 'fields'
  request: Readonly<
    | SnapshotArchiveRequest
    | SnapshotArchiveReaderRequest
    | import('../journal/SnapshotJournalArchiveReaderRequest').SnapshotJournalArchiveReaderRequest
    | import('../journal/SnapshotJournalArchiveReaderRequest').SnapshotJournalFieldArchiveReaderRequest
  >
  controller: AbortController
  terminal: Exclude<SnapshotArchiveTerminalState, 'expired'>
  accepted: Promise<SnapshotArchiveRequestReceipt>
  completion: Promise<SnapshotArchiveRequestReceipt>
}

/** Internal SQL controller. Authentication and bounded HTTP framing belong to its caller. */
export class KnexSnapshotArchiveService {
  private readonly requests: KnexSnapshotArchiveRequestStore
  private readonly archives: KnexSnapshotArchiveStore
  private readonly database: Knex
  private active?: Capture
  private stopped = false
  private closing?: Promise<void>
  private cleanupFailure?: { error: unknown }

  constructor(private readonly storage: StorageKnex) {
    this.database = storage.knex
    this.requests = new KnexSnapshotArchiveRequestStore(storage.knex, true, true)
    this.archives = new KnexSnapshotArchiveStore(storage.knex)
  }

  private assertOpen(): void {
    if (this.stopped) throw new WERR_INVALID_OPERATION('Snapshot archive service is closed')
    if (this.storage.knex !== this.database)
      throw new WERR_INVALID_OPERATION('Snapshot archive service provider changed')
  }

  private failedCleanup(error: unknown): never {
    this.cleanupFailure = { error }
    this.stopped = true
    throw error
  }

  /**
   * Admission is synchronous, before the first database or pool await. A retry
   * keeps its fixed request ID; another process can recover its durable receipt.
   * Completion waits for capture; status remains available while it runs.
   */
  create(identityKey: string, input: unknown): Promise<SnapshotArchiveRequestReceipt> {
    return this.admit(identityKey, input).completion
  }

  /** Return the durable admission promptly; poll status while the owned capture continues. */
  start(identityKey: string, input: unknown): Promise<SnapshotArchiveRequestReceipt> {
    return this.admit(identityKey, input).accepted
  }

  /** Only a pre-admission capacity refusal selects the transient outcome. */
  async admitRequest(identityKey: string, input: unknown): Promise<SnapshotArchiveAdmission> {
    const request = parseSnapshotArchiveRequest(input)
    try {
      return { version: 1, outcome: 'accepted', receipt: await this.start(identityKey, request) }
    } catch (error) {
      if (!(error instanceof SnapshotArchiveAdmissionLimitError)) throw error
      return { version: 1, outcome: 'resource-limited', requestId: request.requestId, expiresAt: request.notAfter }
    }
  }

  /** Offering retains metadata only; no SQL source or archive quota is acquired. */
  async offerReader(identityKey: string, input: SnapshotArchiveReaderOptions) {
    this.assertOpen()
    const options = validateSnapshotArchiveReaderOptions(input)
    return await this.offerCurrent(identityKey, () => this.requests.offer(identityKey, options))
  }

  async offerJournalReader(
    identityKey: string,
    input: SnapshotArchiveReaderOptions,
    position?: SnapshotJournalArchivePosition
  ) {
    this.assertOpen()
    const options = validateSnapshotArchiveReaderOptions(input),
      previous = parseSnapshotJournalArchivePosition(position === undefined ? null : position),
      configuration = await readSnapshotJournalCaptureConfiguration(this.database)
    if (options.lifetimeMs > configuration.receiptPolicy.receiptLifetimeMs)
      throw new WERR_INVALID_PARAMETER('lifetimeMs', 'within the current journal receipt policy')
    return await this.offerCurrent(identityKey, () => this.requests.offerJournal(identityKey, options, previous))
  }

  async offerJournalFieldsReader(
    identityKey: string,
    input: SnapshotArchiveReaderOptions,
    position?: SnapshotJournalArchivePosition
  ) {
    this.assertOpen()
    const options = validateSnapshotArchiveReaderOptions(input),
      previous = parseSnapshotJournalArchivePosition(position === undefined ? null : position),
      configuration = await readSnapshotJournalCaptureConfiguration(this.database)
    if (options.lifetimeMs > configuration.receiptPolicy.receiptLifetimeMs)
      throw new WERR_INVALID_PARAMETER('lifetimeMs', 'within the current journal receipt policy')
    return await this.offerCurrent(identityKey, () => this.requests.offerJournalFields(identityKey, options, previous))
  }

  private async offerCurrent<T extends { request: { requestId: string } }>(
    identityKey: string,
    issue: () => Promise<T | undefined>
  ): Promise<T | undefined> {
    this.assertOpen()
    if (this.active !== undefined) return undefined
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.reap()
    this.assertOpen()
    await this.archives.reap()
    this.assertOpen()
    const offer = await issue()
    if (this.stopped && offer !== undefined) await this.requests.close(identityKey, offer.request.requestId)
    this.assertOpen()
    return offer
  }

  async admitReader(identityKey: string, input: unknown, content = false): Promise<SnapshotArchiveAdmission> {
    const request = parseSnapshotArchiveReaderRequest(input)
    try {
      return {
        version: 1,
        outcome: 'accepted',
        receipt: await this.admit(identityKey, request, true, content).accepted
      }
    } catch (error) {
      if (!(error instanceof SnapshotArchiveAdmissionLimitError)) throw error
      return { version: 1, outcome: 'resource-limited', requestId: request.requestId, expiresAt: request.notAfter }
    }
  }

  async admitJournalReader(identityKey: string, input: unknown): Promise<SnapshotArchiveAdmission> {
    const request = parseSnapshotJournalArchiveReaderRequest(input)
    try {
      return {
        version: 1,
        outcome: 'accepted',
        receipt: await this.admit(identityKey, request, true, false, true).accepted
      }
    } catch (error) {
      if (!(error instanceof SnapshotArchiveAdmissionLimitError)) throw error
      return { version: 1, outcome: 'resource-limited', requestId: request.requestId, expiresAt: request.notAfter }
    }
  }

  async admitJournalFieldsReader(identityKey: string, input: unknown): Promise<SnapshotArchiveAdmission> {
    const request = parseSnapshotJournalFieldArchiveReaderRequest(input)
    try {
      return {
        version: 1,
        outcome: 'accepted',
        receipt: await this.admit(identityKey, request, true, false, 'fields').accepted
      }
    } catch (error) {
      if (!(error instanceof SnapshotArchiveAdmissionLimitError)) throw error
      return { version: 1, outcome: 'resource-limited', requestId: request.requestId, expiresAt: request.notAfter }
    }
  }

  private admit(
    identityKey: string,
    input: unknown,
    reader = false,
    content = false,
    journal: boolean | 'fields' = false
  ): Capture {
    this.assertOpen()
    const request =
      journal === 'fields'
        ? parseSnapshotJournalFieldArchiveReaderRequest(input)
        : journal
          ? parseSnapshotJournalArchiveReaderRequest(input)
          : reader
            ? parseSnapshotArchiveReaderRequest(input)
            : parseSnapshotArchiveRequest(input)
    if (this.active !== undefined) {
      if (this.active.identityKey === identityKey && this.active.request.requestId === request.requestId) {
        if (this.active.content !== content || this.active.journal !== journal)
          throw new WERR_INVALID_OPERATION('Snapshot reader capture mode changed')
        return this.active
      }
      throw new SnapshotArchiveAdmissionLimitError('Snapshot archive capture is opening or active')
    }
    const claim = Promise.resolve().then(async () => {
      assertSnapshotArchiveCaptureActive(job.controller.signal)
      // Reap outside the claim transaction, before reserving or opening a pool.
      await this.storage.recoverSnapshotArchiveSources()
      await this.requests.reap()
      await this.archives.reap()
      assertSnapshotArchiveCaptureActive(job.controller.signal)
      return journal === 'fields'
        ? await this.requests.claimJournalFieldsReader(identityKey, request)
        : journal
          ? await this.requests.claimJournalReader(identityKey, request)
          : reader
            ? await this.requests.claimReader(identityKey, request)
            : await this.requests.claim(identityKey, request)
    })
    const accepted = claim.then(result => Object.freeze({ ...result.receipt }))
    const completion = claim
      .then(result => this.capture(job, result))
      .finally(() => {
        if (this.active === job) this.active = undefined
      })
    const job: Capture = {
      identityKey,
      content,
      journal,
      request,
      controller: new AbortController(),
      terminal: 'failed',
      accepted,
      completion
    }
    this.active = job
    // Cancellation/shutdown can observe completion even after a caller disconnects.
    void completion.catch(() => undefined)
    void accepted.catch(() => undefined)
    return job
  }

  private async capture(
    job: Capture,
    claimed: { receipt: SnapshotArchiveRequestReceipt; owner?: SnapshotArchiveRequestOwner }
  ): Promise<SnapshotArchiveRequestReceipt> {
    const { identityKey, request, controller } = job
    if (claimed.owner === undefined) return claimed.receipt
    const owner = claimed.owner
    let source: SnapshotArchiveSource | undefined, journalSource: SnapshotJournalReconciliationSource | undefined
    const cleanup = async (error?: unknown): Promise<void> => {
      if (job.terminal !== 'closed' && error instanceof SnapshotResourceLimitError) job.terminal = 'resource-limited'
      try {
        // Keep the logical reservation through this process's physical cleanup.
        if (job.journal === 'fields' && source !== undefined)
          await closeSnapshotJournalSource(source, controller.signal)
        else await source?.close()
        await this.requests.sourceClosed(owner)
        await this.requests.close(identityKey, request.requestId, job.terminal)
      } catch (error) {
        this.failedCleanup(error)
      }
    }
    try {
      assertSnapshotArchiveCaptureActive(controller.signal)
      const remaining = request.notAfter - (await snapshotArchiveDatabaseNow(this.storage.knex))
      if (remaining < 1) throw new SnapshotResourceLimitError('Snapshot archive request expired before capture')
      const sourceOptions = { signal: controller.signal, lifetimeMs: Math.min(300000, remaining) }
      if (job.content || job.journal) {
        journalSource = await this.storage.openSnapshotSyncContentSource(identityKey, sourceOptions, owner)
        source = journalSource
      } else source = await this.storage.openSnapshotArchiveSource(identityKey, sourceOptions, owner)
      assertSnapshotArchiveCaptureActive(controller.signal)
      this.assertOpen()
      if (source === undefined) throw new WERR_NOT_IMPLEMENTED('Snapshot archive capture requires SQLite WAL or MySQL')
      if (job.journal === 'fields') {
        if (journalSource === undefined || request.version !== 4)
          throw new WERR_INVALID_OPERATION('Field capture requires its actual issued tuple')
        await captureSnapshotJournalFieldArchiveSource(
          journalSource,
          {
            beginJournalFields: binding => this.requests.beginJournalFields(owner, binding),
            appendJournalFields: (writer, page) => this.requests.appendJournalFields(owner, writer, page),
            sealJournalFields: async writer => {
              await this.requests.sourceClosed(owner)
              return await this.requests.sealJournalFields(owner, writer)
            },
            close: (_identityKey, _archiveId, error) => cleanup(error)
          },
          request.position ?? undefined,
          { signal: controller.signal }
        )
      } else if (job.journal) {
        if (journalSource === undefined || request.version !== 3)
          throw new WERR_INVALID_OPERATION('Journal capture requires its original issued journal tuple')
        await captureSnapshotJournalArchiveSource(
          journalSource,
          {
            beginJournal: binding => this.requests.beginJournal(owner, binding),
            appendJournal: (writer, page) => this.requests.appendJournal(owner, writer, page),
            sealJournal: async writer => {
              await this.requests.sourceClosed(owner)
              return await this.requests.sealJournal(owner, writer)
            },
            close: (_identityKey, _archiveId, error) => cleanup(error)
          },
          request.position ?? undefined,
          { signal: controller.signal }
        )
      } else
        await captureSnapshotArchiveSource(
          source,
          {
            begin: binding => this.requests.begin(owner, binding),
            append: (writer, page) => this.requests.append(owner, writer, page),
            seal: async writer => {
              await this.requests.sourceClosed(owner)
              return await this.requests.seal(owner, writer)
            },
            close: (_identityKey, _archiveId, error) => cleanup(error)
          },
          identityKey,
          this.storage.chain,
          { signal: controller.signal, contentRevision: job.content ? true : undefined }
        )
      return await this.requests.status(identityKey, request.requestId)
    } catch (error) {
      if (error instanceof SnapshotArchiveSourceCleanupError) this.failedCleanup(error)
      await cleanup(error)
      throw error
    }
  }

  async status(identityKey: string, requestId: string): Promise<SnapshotArchiveRequestReceipt> {
    this.assertOpen()
    return await this.requests.status(identityKey, requestId)
  }

  async directory(identityKey: string, archiveId: string) {
    this.assertOpen()
    return await this.archives.directory(identityKey, archiveId)
  }

  async read(identityKey: string, archiveId: string, sequence: number) {
    this.assertOpen()
    return await this.archives.read(identityKey, archiveId, sequence)
  }

  async journalStatus(identityKey: string, input: unknown) {
    this.assertOpen()
    return await this.requests.journalStatus(identityKey, input)
  }

  async journalDirectory(identityKey: string, archiveId: string) {
    this.assertOpen()
    return await this.archives.journalDirectory(identityKey, archiveId)
  }

  async readJournal(identityKey: string, archiveId: string, sequence: number) {
    this.assertOpen()
    return await this.archives.readJournal(identityKey, archiveId, sequence)
  }

  async cancelJournalReader(identityKey: string, input: unknown): Promise<void> {
    this.assertOpen()
    const request = parseSnapshotJournalArchiveReaderRequest(input)
    await this.requests.markJournalReaderCancellation(identityKey, request)
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === request.requestId) await this.stop(job)
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.close(identityKey, request.requestId)
  }

  async journalFieldsStatus(identityKey: string, input: unknown) {
    this.assertOpen()
    return await this.requests.journalFieldsStatus(identityKey, input)
  }

  async journalFieldsDirectory(identityKey: string, archiveId: string) {
    this.assertOpen()
    return await this.archives.journalFieldsDirectory(identityKey, archiveId)
  }

  async readJournalFields(identityKey: string, archiveId: string, sequence: number) {
    this.assertOpen()
    return await this.archives.readJournalFields(identityKey, archiveId, sequence)
  }

  async findJournalFieldsReader(identityKey: string, reference: unknown, readyOnly: boolean) {
    this.assertOpen()
    const found = await this.requests.findJournalFieldsCapture(identityKey, reference, readyOnly)
    this.assertOpen()
    return found
  }

  async cancelJournalFieldsReader(identityKey: string, input: unknown): Promise<void> {
    this.assertOpen()
    const request = parseSnapshotJournalFieldArchiveReaderRequest(input)
    await this.requests.markJournalFieldsReaderCancellation(identityKey, request)
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === request.requestId) await this.stop(job)
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.close(identityKey, request.requestId)
  }

  private async stop(job: Capture): Promise<void> {
    job.terminal = 'closed'
    job.controller.abort()
    await job.completion.catch(() => undefined)
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure.error
  }

  /** Fence the immutable request even if cancellation precedes its first claim. */
  async cancelRequest(identityKey: string, input: unknown): Promise<void> {
    this.assertOpen()
    const request = parseSnapshotArchiveRequest(input)
    await this.requests.markCancellation(identityKey, request)
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === request.requestId) await this.stop(job)
    // A different replica can fence the request, but only proved source cleanup
    // permits release. Its pending outcome must not be acknowledged as complete.
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.close(identityKey, request.requestId)
  }

  async cancelReader(identityKey: string, input: unknown): Promise<void> {
    this.assertOpen()
    const request = parseSnapshotArchiveReaderRequest(input)
    await this.requests.markReaderCancellation(identityKey, request)
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === request.requestId) await this.stop(job)
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.close(identityKey, request.requestId)
  }

  async cancel(identityKey: string, requestId: string): Promise<void> {
    this.assertOpen()
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === requestId) await this.stop(job)
    await this.storage.recoverSnapshotArchiveSources()
    await this.requests.close(identityKey, requestId)
  }

  /** Fence admission and drain the owned capture; completed archives survive shutdown. */
  close(): Promise<void> {
    this.stopped = true
    if (this.closing === undefined) {
      const job = this.active
      const capture = job === undefined ? this.closedWithoutCapture() : this.stop(job)
      this.closing = capture.finally(() => this.storage.awaitSnapshotArchiveRecovery())
    }
    return this.closing
  }

  private closedWithoutCapture(): Promise<void> {
    if (this.cleanupFailure !== undefined) return Promise.reject(this.cleanupFailure.error)
    return Promise.resolve()
  }
}
