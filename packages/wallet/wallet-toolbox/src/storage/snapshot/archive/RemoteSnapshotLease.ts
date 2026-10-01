import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { isSnapshotArchiveTransportFailure, retrySnapshotArchiveOperation } from './SnapshotArchiveTransportFailure'
import type { WalletReadSnapshotOptions } from '../WalletReadSnapshot'
import { parseSnapshotArchiveReaderRequest, type SnapshotArchiveReaderRequest } from './SnapshotArchiveReaderRequest'
import type { SnapshotArchiveTransport } from './SnapshotArchiveTransport'

/** Owns one opening/read operation and one expiry timer until remote cleanup settles. */
export class RemoteSnapshotLease {
  readonly lifetimeMs: number
  readonly expiresAt: number
  readonly closed: Promise<void>
  private readonly startedAt = performance.now()
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private request: Readonly<SnapshotArchiveReaderRequest> | undefined
  private serverTime: number | undefined
  private reason: WERR_INVALID_OPERATION | undefined
  private closing: Promise<void> | undefined
  private resolveClosed!: () => void
  private rejectClosed!: (error: unknown) => void

  constructor(
    private readonly transport: SnapshotArchiveTransport,
    options: WalletReadSnapshotOptions
  ) {
    this.lifetimeMs = options.lifetimeMs ?? 300000
    if (!Number.isSafeInteger(this.lifetimeMs) || this.lifetimeMs < 1 || this.lifetimeMs > 3600000)
      throw new WERR_INVALID_PARAMETER('lifetimeMs', 'an integer from 1 to 3600000')
    this.expiresAt = Date.now() + this.lifetimeMs
    this.signal = options.signal
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closed.catch(() => undefined)
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted === true) this.abort()
    else
      this.timer = setTimeout(() => {
        void this.close(new SnapshotResourceLimitError('Remote snapshot expired')).catch(() => undefined)
      }, this.lifetimeMs)
  }

  private readonly abort = (): void => {
    void this.close(new SnapshotCancelledError('Remote snapshot was cancelled')).catch(() => undefined)
  }

  get isOpen(): boolean {
    try {
      this.assertOpen()
      return true
    } catch {
      return false
    }
  }

  assertOpen(): void {
    if (Date.now() >= this.expiresAt || performance.now() - this.startedAt >= this.lifetimeMs)
      void this.close(new SnapshotResourceLimitError('Remote snapshot expired')).catch(() => undefined)
    if (this.reason !== undefined) throw this.reason
  }

  bindServerTime(serverTime: number): void {
    this.assertOpen()
    if (this.serverTime !== undefined) throw new WERR_INVALID_OPERATION('Remote snapshot clock is already bound')
    this.serverTime = serverTime
  }

  /** Includes the entire offer RTT conservatively; retries never renew this basis. */
  now(): number {
    this.assertOpen()
    if (this.serverTime === undefined) throw new WERR_INVALID_OPERATION('Remote snapshot clock is not bound')
    return Math.ceil(this.serverTime + performance.now() - this.startedAt)
  }

  own(request: SnapshotArchiveReaderRequest): void {
    this.assertOpen()
    if (this.request !== undefined) throw new WERR_INVALID_OPERATION('Remote snapshot request is already owned')
    this.request = parseSnapshotArchiveReaderRequest(request)
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.pending !== undefined)
      throw new WERR_INVALID_OPERATION('Remote snapshot already has an operation in flight')
    const pending = Promise.resolve().then(async () => {
      this.assertOpen()
      return await operation(this.controller.signal)
    })
    // Own settlement immediately, separately from the result returned to the
    // caller. Cleanup drains failures without replacing their public identity.
    this.pending = pending.then(
      () => undefined,
      () => undefined
    )
    try {
      const value = await pending
      this.assertOpen()
      return value
    } catch (error) {
      // Only a local transport cancellation may be explained by our abort.
      // Authentication, framing and cleanup failures retain their own identity.
      if (
        this.reason !== undefined &&
        (error instanceof SnapshotCancelledError || isSnapshotArchiveTransportFailure(error))
      )
        throw this.reason
      throw error
    } finally {
      this.pending = undefined
    }
  }

  /** Keep one operation slot and the fixed lease across a single connection-loss retry. */
  async runIdempotent<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return await this.run(async signal =>
      retrySnapshotArchiveOperation(async () => {
        this.assertOpen()
        return await operation(signal)
      })
    )
  }

  async wait(milliseconds: number): Promise<void> {
    await this.run(
      async signal =>
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => {
            signal.removeEventListener('abort', abort)
            resolve()
          }
          const timer = setTimeout(finish, milliseconds)
          const abort = (): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            // Only close() aborts this private signal, after setting its reason.
            reject(this.reason)
          }
          // run() asserted openness immediately before this synchronous setup.
          signal.addEventListener('abort', abort, { once: true })
        })
    )
  }

  close(reason = new WERR_INVALID_OPERATION('Remote snapshot is closed')): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.reason = reason
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.signal?.removeEventListener('abort', this.abort)
    const pending = this.pending
    // Fence first, then drain the network operation before releasing its shared receipt.
    this.closing = Promise.resolve().then(async () => {
      await pending
      const request = this.request
      if (request !== undefined) await retrySnapshotArchiveOperation(async () => this.transport.cancelRequest(request))
    })
    void this.closing.then(this.resolveClosed, this.rejectClosed)
    this.controller.abort()
    return this.closing
  }
}
