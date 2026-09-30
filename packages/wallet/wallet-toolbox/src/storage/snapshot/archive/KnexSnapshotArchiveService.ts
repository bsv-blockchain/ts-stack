import { WERR_INVALID_OPERATION, WERR_NOT_IMPLEMENTED } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotArchiveSourceCleanupError, type SnapshotArchiveSource } from './KnexSnapshotArchiveSource'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import {
  parseSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestReceipt
} from './SnapshotArchiveRequest'
import { snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import { assertSnapshotArchiveCaptureActive, captureSnapshotArchiveSource } from './captureSnapshotArchiveSource'

interface Capture {
  identityKey: string
  request: Readonly<SnapshotArchiveRequest>
  controller: AbortController
  terminal: 'closed' | 'failed'
  completion: Promise<SnapshotArchiveRequestReceipt>
}

/** Internal SQL controller. Authentication and bounded HTTP framing belong to its caller. */
export class KnexSnapshotArchiveService {
  private readonly requests: KnexSnapshotArchiveRequestStore
  private readonly archives: KnexSnapshotArchiveStore
  private active?: Capture
  private stopped = false
  private closing?: Promise<void>
  private cleanupFailure?: { error: unknown }

  constructor(private readonly storage: StorageKnex) {
    this.requests = new KnexSnapshotArchiveRequestStore(storage.knex)
    this.archives = new KnexSnapshotArchiveStore(storage.knex)
  }

  private assertOpen(): void {
    if (this.stopped) throw new WERR_INVALID_OPERATION('Snapshot archive service is closed')
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
    this.assertOpen()
    const request = parseSnapshotArchiveRequest(input)
    if (this.active !== undefined) {
      if (this.active.identityKey === identityKey && this.active.request.requestId === request.requestId)
        return this.active.completion
      throw new SnapshotResourceLimitError('Snapshot archive capture is opening or active')
    }
    const completion = Promise.resolve()
      .then(() => this.capture(job))
      .finally(() => {
        if (this.active === job) this.active = undefined
      })
    const job: Capture = {
      identityKey,
      request,
      controller: new AbortController(),
      terminal: 'failed',
      completion
    }
    this.active = job
    // Cancellation/shutdown can observe completion even after a caller disconnects.
    void completion.catch(() => undefined)
    return completion
  }

  private async capture(job: Capture): Promise<SnapshotArchiveRequestReceipt> {
    const { identityKey, request, controller } = job
    assertSnapshotArchiveCaptureActive(controller.signal)
    const claimed = await this.requests.claim(identityKey, request)
    if (claimed.owner === undefined) return claimed.receipt
    let source: SnapshotArchiveSource | undefined
    const cleanup = async (): Promise<void> => {
      try {
        // Keep the logical reservation through this process's physical cleanup.
        await source?.close()
        await this.requests.close(identityKey, request.requestId, job.terminal)
      } catch (error) {
        this.failedCleanup(error)
      }
    }
    try {
      assertSnapshotArchiveCaptureActive(controller.signal)
      const remaining = request.notAfter - (await snapshotArchiveDatabaseNow(this.storage.knex))
      if (remaining < 1) throw new SnapshotResourceLimitError('Snapshot archive request expired before capture')
      source = await this.storage.openSnapshotArchiveSource(identityKey, {
        signal: controller.signal,
        lifetimeMs: Math.min(300000, remaining)
      })
      if (source === undefined) throw new WERR_NOT_IMPLEMENTED('Snapshot archive capture requires SQLite WAL or MySQL')
      const owner = claimed.owner
      await captureSnapshotArchiveSource(
        source,
        {
          begin: binding => this.requests.begin(owner, binding),
          append: (writer, page) => this.archives.append(writer, page),
          seal: writer => this.requests.seal(owner, writer),
          close: cleanup
        },
        identityKey,
        this.storage.chain,
        { signal: controller.signal }
      )
      return await this.requests.status(identityKey, request.requestId)
    } catch (error) {
      if (error instanceof SnapshotArchiveSourceCleanupError) this.failedCleanup(error)
      await cleanup()
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

  private async stop(job: Capture): Promise<void> {
    job.terminal = 'closed'
    job.controller.abort()
    await job.completion.catch(() => undefined)
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure.error
  }

  async cancel(identityKey: string, requestId: string): Promise<void> {
    this.assertOpen()
    const job = this.active
    if (job?.identityKey === identityKey && job.request.requestId === requestId) await this.stop(job)
    await this.requests.close(identityKey, requestId)
  }

  /** Fence admission and drain the owned capture; completed archives survive shutdown. */
  close(): Promise<void> {
    this.stopped = true
    if (this.closing === undefined) {
      const job = this.active
      this.closing = job === undefined ? this.closedWithoutCapture() : this.stop(job)
    }
    return this.closing
  }

  private async closedWithoutCapture(): Promise<void> {
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure.error
  }
}
