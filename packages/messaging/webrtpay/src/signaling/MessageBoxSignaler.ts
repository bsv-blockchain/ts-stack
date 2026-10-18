import { DEFAULTS, SIGNALS_MESSAGEBOX } from '../types.js'
import type { PubKeyHex } from '../types.js'
import { WebRTPayError } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import { isSignalEnvelope } from './envelope.js'
import type { SignalEnvelope, Signaler } from './types.js'

/**
 * The `MessageBoxClient` (`@bsv/message-box-client`) methods this signaler uses,
 * typed structurally so the package does not depend on it.
 */
export interface MessageBoxLike {
  sendMessage(
    a: { recipient: string; messageBox: string; body: string },
    overrideHost?: string
  ): Promise<unknown>
  /**
   * The signaler asks for one bounded page (`limit`, `pageSize`, `maxPages`) and no payment
   * handling (`acceptPayments: false`); a client that ignores these still works, because the
   * signaler handles at most 100 new messages per poll whatever it is given.
   */
  listMessages(a: {
    messageBox: string
    host?: string
    limit?: number
    pageSize?: number
    maxPages?: number
    acceptPayments?: boolean
  }): Promise<Array<{ messageId: string; sender: string; body: string | Record<string, unknown> }>>
  acknowledgeMessage(a: { messageIds: string[]; host?: string }): Promise<unknown>
}

export interface MessageBoxSignalerOptions {
  /** Box that carries the envelopes; defaults to `webrtpay_signals`. */
  messageBox?: string
  /** Poll interval while no dial is in progress; defaults to 2500 ms. */
  idlePollMs?: number
  /** Poll interval while `setActive(true)`; defaults to 1000 ms. */
  activePollMs?: number
  /**
   * MessageBox host to list and acknowledge on. Sending always resolves the
   * recipient's own host, so payer and payee may use different servers.
   */
  host?: string
}

/** Longest wait between polls after consecutive errors. */
const MAX_BACKOFF_MS = 30000
/** Most new messages handled per poll, and the page size asked of the server. */
const MAX_MESSAGES_PER_POLL = 100
/**
 * Most message IDs per `acknowledgeMessage` call: servers cap it (500 on a small ts-stack
 * MessageBox profile), and one refused batch must not hold back the others.
 */
const MAX_ACK_IDS = 100
/** A poll (list, delivery and acks) still running after this long is abandoned. */
const POLL_DEADLINE_MS = 10000
/** Message IDs remembered for dedupe. */
const MAX_SEEN_IDS = 10000

/**
 * Carries signal envelopes through MessageBox. `send` posts over HTTP to the
 * recipient's host. Listening polls `listMessages` for one page of at most 100
 * messages, delivers each new envelope once and acknowledges every message it reads,
 * including ones that are not envelopes, so nothing lingers on the server; at most 100
 * new messages are handled per poll, the rest wait for the next. Acks go in batches of
 * 100; a batch that fails is retried on the next poll. One poll loop serves all listeners
 * and runs while at least one is subscribed; a failed listing or a poll that takes more
 * than 10 s doubles the wait (up to 30 s), and errors never escape the loop.
 */
export class MessageBoxSignaler implements Signaler {
  private readonly messageBox: string
  private readonly idlePollMs: number
  private readonly activePollMs: number
  private readonly host: string | undefined
  private readonly subs = new Set<SignalSubscription>()
  /** messageId → whether the server has confirmed its acknowledgement; oldest first. */
  private readonly seen = new Map<string, boolean>()
  private active = false
  private polling = false
  /** The poll in progress; a poll that is no longer current stops at its next step. */
  private current: object | undefined
  private failures = 0
  private lastPollAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly client: MessageBoxLike,
    o: MessageBoxSignalerOptions = {}
  ) {
    this.messageBox = o.messageBox ?? SIGNALS_MESSAGEBOX
    this.idlePollMs = pollInterval(o.idlePollMs, DEFAULTS.payeePollMs, 'idlePollMs')
    this.activePollMs = pollInterval(o.activePollMs, DEFAULTS.payerPollMs, 'activePollMs')
    this.host = o.host
  }

  /** Post `e` to `to`'s box; any failure rejects `WebRTPayError('peer_unreachable')`. */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    const body = JSON.stringify({ v: e.v, sid: e.sid, ciphertext: e.ciphertext })
    try {
      await this.client.sendMessage({ recipient: to, messageBox: this.messageBox, body })
    } catch (cause) {
      throw new WebRTPayError('peer_unreachable', 'MessageBox could not deliver the signal', {
        cause
      })
    }
  }

  /** Subscribe; the first subscription polls at once and starts the loop. */
  listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>> {
    const sub: SignalSubscription = { fn }
    this.subs.add(sub)
    if (this.timer === undefined && !this.polling) this.poll()
    return Promise.resolve(() => {
      if (this.subs.delete(sub) && this.subs.size === 0) this.clearTimer()
      return Promise.resolve()
    })
  }

  /** Poll every `activePollMs` while true (a dial is waiting for its answer). */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.schedule()
  }

  private poll(): void {
    this.polling = true
    const run = {}
    this.current = run
    let deadline: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Poll timed out')), POLL_DEADLINE_MS)
    })
    Promise.race([this.pollOnce(run), stalled]).then(
      () => this.finishPoll(deadline, true),
      () => this.finishPoll(deadline, false)
    )
  }

  /** Count the poll's outcome, then schedule the next one. */
  private finishPoll(deadline: ReturnType<typeof setTimeout> | undefined, ok: boolean): void {
    if (ok) this.failures = 0
    else this.failures++
    clearTimeout(deadline)
    // A stalled call may still return; it must not deliver or ack anything then.
    this.current = undefined
    this.polling = false
    this.lastPollAt = Date.now()
    this.schedule()
  }

  /** (Re)arm the timer for the next poll, measured from the end of the last one. */
  private schedule(): void {
    this.clearTimer()
    if (this.subs.size === 0 || this.polling) return
    const base = this.active ? this.activePollMs : this.idlePollMs
    const wait = Math.min(base * 2 ** this.failures, Math.max(base, MAX_BACKOFF_MS))
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.poll()
      },
      Math.max(0, this.lastPollAt + wait - Date.now())
    )
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** One poll; `run` identifies it, and it stops once it is no longer the current one. */
  private async pollOnce(run: object): Promise<void> {
    const page = {
      messageBox: this.messageBox,
      limit: MAX_MESSAGES_PER_POLL,
      pageSize: MAX_MESSAGES_PER_POLL,
      maxPages: 1,
      acceptPayments: false
    }
    const listed: unknown = await this.client.listMessages(
      this.host === undefined ? page : { ...page, host: this.host }
    )
    if (this.current !== run) return
    if (!Array.isArray(listed)) throw new TypeError('listMessages did not return an array')

    const state: PollState = { handled: 0, toAck: new Set<string>() }
    for (const m of listed as unknown[]) {
      // Nobody is listening any more: leave the rest on the server for the next listener.
      if (this.subs.size === 0) break
      this.take(m, state)
    }
    await this.acknowledge([...state.toAck], 0, run)
    while (this.seen.size > MAX_SEEN_IDS) {
      this.seen.delete(this.seen.keys().next().value as string)
    }
  }

  /**
   * Deliver `m` if it is new and within the per-poll budget, and note its ID for acking
   * unless the server has already confirmed that.
   */
  private take(m: unknown, state: PollState): void {
    if (typeof m !== 'object' || m === null) return
    const { messageId, sender, body } = m as Record<string, unknown>
    if (typeof messageId !== 'string') return
    const acked = this.seen.get(messageId)
    if (acked === undefined) {
      // Over the per-poll budget: neither read nor acked, so a later poll handles it.
      if (state.handled >= MAX_MESSAGES_PER_POLL) return
      state.handled++
      this.seen.set(messageId, false)
      const e = envelopeOf(body)
      if (e !== undefined && typeof sender === 'string') dispatchSignal(this.subs, sender, e)
    }
    if (acked !== true) state.toAck.add(messageId)
  }

  /** Ack `ids` from `from` on, one batch at a time, while `run` is the current poll. */
  private async acknowledge(ids: string[], from: number, run: object): Promise<void> {
    if (from >= ids.length || this.current !== run) return
    const messageIds = ids.slice(from, from + MAX_ACK_IDS)
    if (await this.acknowledgeBatch(messageIds)) {
      for (const id of messageIds) this.seen.set(id, true)
    }
    return this.acknowledge(ids, from + MAX_ACK_IDS, run)
  }

  /** Whether the server confirmed acking `messageIds`; a failed batch is acked again next poll. */
  private async acknowledgeBatch(messageIds: string[]): Promise<boolean> {
    try {
      await this.client.acknowledgeMessage(
        this.host === undefined ? { messageIds } : { messageIds, host: this.host }
      )
      return true
    } catch {
      return false
    }
  }
}

/** What one poll has read so far: new messages handled, and IDs to acknowledge. */
interface PollState {
  handled: number
  toAck: Set<string>
}

/** The envelope in a message body (JSON text or an object the client already parsed). */
function envelopeOf(body: unknown): SignalEnvelope | undefined {
  let value = body
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  return isSignalEnvelope(value) ? value : undefined
}

function pollInterval(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback
  if (!Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds`)
  }
  return v
}
