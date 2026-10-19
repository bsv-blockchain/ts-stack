/**
 * The clocks and reply queue of one dial by identity key. Internal: not exported from the
 * package.
 */
import type { SignalPlaintext } from '../signaling/types.js'
import { WebRTPayError } from '../util/errors.js'

/** How long one dial may take, in milliseconds. */
export interface DialTimeouts {
  /** From the knock being posted to the recipient's first reply (ring, answer or reject). */
  presenceMs: number
  /** From the first reply to an open, authenticated session. */
  dialMs: number
  /** The whole dial, whatever the stage. */
  totalMs: number
}

/**
 * The timers of one dial. The total budget runs from the start; presence runs from when the
 * carrier has taken the knock, so a slow carrier does not make an online peer look offline.
 * Before the recipient replies, either ends the dial `peer_unreachable`; the first reply stops
 * presence and starts the dial budget, and from then on running out ends it `timeout`.
 */
export class DialClock {
  private replied = false
  private stopped = false
  private presence: ReturnType<typeof setTimeout> | undefined
  private dial: ReturnType<typeof setTimeout> | undefined
  private total: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly t: DialTimeouts,
    private readonly expire: (e: WebRTPayError) => void
  ) {}

  /** Start the total clock. */
  start(): void {
    this.total = setTimeout(() => {
      this.expire(
        this.replied
          ? new WebRTPayError('timeout', `Connection not established within ${this.t.totalMs} ms`)
          : unreachable(this.t.totalMs)
      )
    }, this.t.totalMs)
  }

  /** The knock is posted: start the presence clock, unless the recipient has replied already. */
  posted(): void {
    if (this.stopped || this.replied || this.presence !== undefined) return
    this.presence = setTimeout(() => this.expire(unreachable(this.t.presenceMs)), this.t.presenceMs)
  }

  /** The recipient replied: stop presence and start the dial clock (once). */
  heard(): void {
    if (this.stopped || this.replied) return
    this.replied = true
    clearTimeout(this.presence)
    this.dial = setTimeout(() => {
      this.expire(
        new WebRTPayError(
          'timeout',
          `Connection not established within ${this.t.dialMs} ms of the recipient's reply`
        )
      )
    }, this.t.dialMs)
  }

  /** Clear every timer; later calls start none. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.presence)
    clearTimeout(this.dial)
    clearTimeout(this.total)
  }
}

/**
 * Settles a dial's promise once: the first `resolve` or `reject` wins and runs `cleanup`
 * before settling; later calls do nothing and return false.
 */
export class DialSettler<T> {
  private settled = false

  constructor(
    private readonly onResolve: (v: T) => void,
    private readonly onReject: (e: unknown) => void,
    private readonly cleanup: () => void
  ) {}

  /** Resolve with `v`; false when the dial had already settled. */
  resolve(v: T): boolean {
    if (!this.settle()) return false
    this.onResolve(v)
    return true
  }

  /** Reject with `e`; false when the dial had already settled. */
  reject(e: unknown): boolean {
    if (!this.settle()) return false
    this.onReject(e)
    return true
  }

  private settle(): boolean {
    if (this.settled) return false
    this.settled = true
    this.cleanup()
    return true
  }
}

/** The signals a dial receives from its recipient, taken one at a time in order. */
export class ReplyQueue {
  private readonly items: SignalPlaintext[] = []
  private waiter: ((p: SignalPlaintext) => void) | undefined
  private failure: WebRTPayError | undefined
  private onFailure: ((e: WebRTPayError) => void) | undefined

  push(p: SignalPlaintext): void {
    if (this.failure !== undefined) return
    const waiter = this.waiter
    if (waiter === undefined) {
      this.items.push(p)
      return
    }
    this.waiter = undefined
    this.onFailure = undefined
    waiter(p)
  }

  /** End the queue: a pending and every later {@link next} rejects with `e`. */
  fail(e: WebRTPayError): void {
    if (this.failure !== undefined) return
    this.failure = e
    const reject = this.onFailure
    this.waiter = undefined
    this.onFailure = undefined
    reject?.(e)
  }

  /** The next reply, waiting for it if none has arrived; one caller at a time. */
  next(): Promise<SignalPlaintext> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const ready = this.items.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise<SignalPlaintext>((resolve, reject) => {
      this.waiter = resolve
      this.onFailure = reject
    })
  }
}

function unreachable(ms: number): WebRTPayError {
  return new WebRTPayError('peer_unreachable', `No answer from the recipient in ${ms} ms`)
}
