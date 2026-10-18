import { DEFAULTS } from '../types.js'
import type { PubKeyHex } from '../types.js'
import { monotonicNow } from './budget.js'

/**
 * What a payee allows from peers that dial it by identity key (spec §6). Each sender may
 * also have only one inbound session at a time; that is not configurable.
 */
export interface InboundLimits {
  /** Most inbound sessions open at once, handshake included. */
  maxConcurrent: number
  /** Most offers admitted from everyone per rolling minute. */
  offersPerMinute: number
  /** Most offers admitted from one sender per rolling minute. */
  offersPerMinutePerSender: number
  /** Largest message accepted from an inbound peer once it has authenticated, in bytes. */
  maxMessageBytes: number
  /** An inbound session with no traffic for this long is closed, in milliseconds. */
  idleTimeoutMs: number
  /**
   * An inbound session whose peer has sent nothing this long after the handshake is closed,
   * in milliseconds (the idle timeout applies from its first message on). It is the payer's
   * window to create, broadcast and send the payment after `connect` resolves.
   */
  firstMessageTimeoutMs: number
  /** An inbound session is closed this long after the handshake, however busy, in ms. */
  maxSessionMs: number
}

/**
 * 3 sessions (1 per sender), 10 offers a minute (3 per sender), 16 MiB messages, 60 s idle
 * timeout, 60 s for the first message, 2 minutes per session. The first-message window is
 * that long because a payer connects before it spends: creating and broadcasting the
 * transaction (permission prompts included) happens inside it (Ruling 33).
 */
export const DEFAULT_INBOUND_LIMITS: Readonly<InboundLimits> = Object.freeze({
  maxConcurrent: 3,
  offersPerMinute: 10,
  offersPerMinutePerSender: 3,
  maxMessageBytes: DEFAULTS.inboundMaxMessageBytes,
  idleTimeoutMs: 60000,
  firstMessageTimeoutMs: 60000,
  maxSessionMs: 120000
})

/**
 * Why an offer is refused: `sender` for that sender's own limits (it already has a session,
 * or has used its offers for the minute), `busy` for the payee's overall limits.
 */
export type InboundRefusal = 'sender' | 'busy'

const WINDOW_MS = 60000
/** Longest delay `setTimeout` honours; anything larger fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Admission control for inbound offers. An offer is admitted when its sender has no
 * session and has had fewer than its per-minute offers admitted in the last 60 s, and then
 * when a session slot is free and the overall offers in the last 60 s are below their
 * limit; it then takes a slot (and the sender's one session) until {@link release}. The
 * sender's limits are checked first, and refused offers count against nothing, so a sender
 * that keeps being refused cannot use up anyone else's budget.
 *
 * Times are read from `clock`, by default one that never steps backwards
 * (`performance.now()` where there is one), so setting the wall clock back cannot hold the
 * window shut.
 */
export class InboundLimiter {
  private readonly limits: InboundLimits
  private readonly clock: () => number
  private active = 0
  /** Senders with a session open. */
  private readonly sessions = new Set<PubKeyHex>()
  /** Admission times within the window, oldest first. */
  private readonly admitted: number[] = []
  private readonly bySender = new Map<PubKeyHex, number[]>()

  /**
   * @param clock - Milliseconds; only differences between readings matter.
   * @throws `RangeError` for a limit that is not a positive integer (or timer length).
   */
  constructor(l: InboundLimits, clock: () => number = monotonicNow) {
    for (const name of ['maxConcurrent', 'offersPerMinute', 'offersPerMinutePerSender'] as const) {
      if (!Number.isSafeInteger(l[name]) || l[name] < 1) {
        throw new RangeError(`${name} must be a positive integer`)
      }
    }
    if (!Number.isSafeInteger(l.maxMessageBytes) || l.maxMessageBytes < 1) {
      throw new RangeError('maxMessageBytes must be a positive integer')
    }
    for (const name of ['idleTimeoutMs', 'firstMessageTimeoutMs', 'maxSessionMs'] as const) {
      if (!isTimerMs(l[name])) {
        throw new RangeError(`${name} must be a positive number up to ${MAX_TIMER_MS}`)
      }
    }
    this.limits = { ...l }
    this.clock = clock
  }

  /** Why an offer from `sender` at `now` (on the clock) would be refused, or `undefined`. */
  refusal(sender: PubKeyHex, now: number = this.clock()): InboundRefusal | undefined {
    this.prune(now)
    if (
      this.sessions.has(sender) ||
      (this.bySender.get(sender)?.length ?? 0) >= this.limits.offersPerMinutePerSender
    ) {
      return 'sender'
    }
    if (
      this.active >= this.limits.maxConcurrent ||
      this.admitted.length >= this.limits.offersPerMinute
    ) {
      return 'busy'
    }
    return undefined
  }

  /** Admit an offer from `sender` at `now` (on the clock) and take a session slot, or refuse it. */
  tryAdmit(sender: PubKeyHex, now: number = this.clock()): boolean {
    if (this.refusal(sender, now) !== undefined) return false
    this.active++
    this.sessions.add(sender)
    this.admitted.push(now)
    const fromSender = this.bySender.get(sender) ?? []
    fromSender.push(now)
    this.bySender.set(sender, fromSender)
    return true
  }

  /** Give back the slot `sender`'s admitted offer took, when its session ends. */
  release(sender: PubKeyHex): void {
    if (this.sessions.delete(sender) && this.active > 0) this.active--
  }

  private prune(now: number): void {
    while (this.admitted.length > 0 && now - this.admitted[0] >= WINDOW_MS) this.admitted.shift()
    for (const [sender, times] of this.bySender) {
      while (times.length > 0 && now - times[0] >= WINDOW_MS) times.shift()
      if (times.length === 0) this.bySender.delete(sender)
    }
  }
}

/** A positive number of milliseconds that `setTimeout` can wait for. */
function isTimerMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIMER_MS
}
