import { DEFAULTS, SIGNALS_MESSAGEBOX } from '../types.js'
import type { PubKeyHex } from '../types.js'
import { WebRTPayError } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import { isSignalEnvelope } from './envelope.js'
import { RecipientHosts, sameOrigin } from './hosts.js'
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
  /**
   * The MessageBox host `identityKey` receives on (its advertised host, else the client's
   * own). Optional; without it nothing is sent live, since the socket reaches only the
   * client's own host.
   */
  resolveHostForRecipient?(identityKey: string): Promise<string>
  /** This client's identity key, to find its own host when the signaler has no `host`. */
  getIdentityKey?(): Promise<string>
  /**
   * Send over the live websocket, which reaches only the host the socket is connected to (it
   * may fall back to HTTP itself). Optional.
   */
  sendLiveMessage?(
    a: { recipient: string; messageBox: string; body: string },
    overrideHost?: string
  ): Promise<unknown>
  /** Join the box's live room and hand each message that arrives to `onMessage`. Optional. */
  listenForLiveMessages?(a: {
    messageBox: string
    onMessage: (m: LiveMessage) => void
    overrideHost?: string
  }): Promise<void>
  /** Join the box's live room again after {@link leaveRoom}. Optional. */
  joinRoom?(messageBox: string, overrideHost?: string): Promise<void>
  /** Leave the box's live room; called when the last listener unsubscribes. Optional. */
  leaveRoom?(messageBox: string): Promise<void>
}

/** A message as the live websocket hands it over (`PeerMessage`'s fields this uses). */
export interface LiveMessage {
  messageId: string
  sender: string
  body: string | Record<string, unknown>
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
  /**
   * Use the MessageBox live websocket, when the client has it: send with
   * `sendLiveMessage` to recipients on this client's own host (HTTP `sendMessage` otherwise,
   * or if that fails) and receive with `listenForLiveMessages` alongside polling. Defaults to
   * true.
   */
  live?: boolean
}

/** What a live send attempt came to (see `MessageBoxSignaler.sendLive`). */
type LiveOutcome = 'sent' | 'tried' | 'skipped'

/** Longest wait for the live websocket (host lookup included) before sending over HTTP. */
const LIVE_SEND_MS = 1500

/** Where live listening stands: not started, starting, in the room, or left the room. */
type LiveState = 'off' | 'starting' | 'on' | 'left'

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
 * Carries signal envelopes through MessageBox. `send` uses the live websocket
 * (`sendLiveMessage`) when the recipient's host (`resolveHostForRecipient`, remembered for 5
 * minutes) is the one this client's socket is on: the signaler's `host`, else the client's
 * own advertised host. Otherwise, or when the live send fails, it posts over HTTP, which
 * resolves the recipient's own host, so payer and payee may use different servers. With a live websocket, the first subscription also joins the box's live room and
 * envelopes are delivered as they arrive, once each by `messageId` (a poll listing the
 * same message later neither delivers it again nor acks it twice); live envelopes are
 * acknowledged with the next poll, and on the last unsubscribe the room is left. If live
 * listening fails, polling carries on alone. Listening polls `listMessages` for one page of at most 100
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
  private readonly live: boolean
  private liveState: LiveState = 'off'
  /** IDs of envelopes delivered live, acknowledged with the next poll. */
  private readonly liveAcks = new Set<string>()
  private readonly hosts: RecipientHosts | undefined
  /** This client's own host, once looked up (no `host` option). */
  private ownHost: Promise<string> | undefined

  constructor(
    private readonly client: MessageBoxLike,
    o: MessageBoxSignalerOptions = {}
  ) {
    this.messageBox = o.messageBox ?? SIGNALS_MESSAGEBOX
    this.idlePollMs = pollInterval(o.idlePollMs, DEFAULTS.payeePollMs, 'idlePollMs')
    this.activePollMs = pollInterval(o.activePollMs, DEFAULTS.payerPollMs, 'activePollMs')
    this.host = o.host
    this.live = o.live ?? true
    const resolve = client.resolveHostForRecipient
    this.hosts =
      resolve === undefined ? undefined : new RecipientHosts(k => resolve.call(client, k))
  }

  /**
   * Post `e` to `to`'s box, live when possible, else over HTTP. When neither gets it there
   * it rejects `WebRTPayError('unavailable')`: the sender could not reach MessageBox, which
   * says nothing about whether the peer is online.
   */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    const body = JSON.stringify({ v: e.v, sid: e.sid, ciphertext: e.ciphertext })
    const message = { recipient: to, messageBox: this.messageBox, body }
    const live = await this.sendLive(message)
    if (live === 'sent') return
    try {
      await this.client.sendMessage(message)
    } catch (cause) {
      // A live send that was slow, not lost: the server already holds the same message.
      if (live === 'tried' && isDuplicate(cause)) return
      throw new WebRTPayError('unavailable', 'MessageBox could not deliver the signal', {
        cause
      })
    }
  }

  /** Subscribe; the first subscription polls at once, starts the loop and listens live. */
  listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>> {
    const sub: SignalSubscription = { fn }
    this.subs.add(sub)
    if (this.subs.size === 1) this.startLive()
    if (this.timer === undefined && !this.polling) this.poll()
    return Promise.resolve(() => {
      if (this.subs.delete(sub) && this.subs.size === 0) {
        this.clearTimer()
        this.leaveLive()
      }
      return Promise.resolve()
    })
  }

  /** Poll every `activePollMs` while true (a dial is waiting for its answer). */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.schedule()
  }

  /**
   * Try the live websocket, for at most 1.5 s: `sent` when `sendLiveMessage` took the
   * message, `tried` when it was called but failed or did not answer in time (it may still
   * deliver), `skipped` when it was not called (no live send, or the recipient is on another
   * host or its host could not be found in time).
   */
  private async sendLive(message: {
    recipient: string
    messageBox: string
    body: string
  }): Promise<LiveOutcome> {
    const sendLiveMessage = this.client.sendLiveMessage
    if (!this.live || sendLiveMessage === undefined) return 'skipped'
    let called = false
    // Once the 1.5 s are up the caller sends over HTTP; a late host lookup must not then
    // send live as well, or HTTP would meet a duplicate it was never told to expect.
    let expired = false
    const attempt = (async (): Promise<LiveOutcome> => {
      if (!(await this.reachableLive(message.recipient)) || expired) return 'skipped'
      called = true
      await sendLiveMessage.call(this.client, message, this.host)
      return 'sent'
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>(resolve => {
      timer = setTimeout(() => {
        expired = true
        resolve(undefined)
      }, LIVE_SEND_MS)
    })
    try {
      return (await Promise.race([attempt, late])) ?? (called ? 'tried' : 'skipped')
    } catch {
      return called ? 'tried' : 'skipped'
    } finally {
      clearTimeout(timer)
      attempt.catch(noop)
    }
  }

  /** Whether `recipient` receives on the host this client's socket is on. */
  private async reachableLive(recipient: string): Promise<boolean> {
    if (this.hosts === undefined) return false
    const mine = await this.ownHostOf(this.hosts)
    if (mine === undefined) return false
    return sameOrigin(mine, await this.hosts.of(recipient))
  }

  /** The `host` option, else this client's own advertised host; undefined when unknown. */
  private ownHostOf(hosts: RecipientHosts): Promise<string | undefined> {
    if (this.host !== undefined) return Promise.resolve(this.host)
    const getIdentityKey = this.client.getIdentityKey
    if (getIdentityKey === undefined) return Promise.resolve(undefined)
    if (this.ownHost === undefined) {
      const lookup = getIdentityKey.call(this.client).then(k => hosts.of(k))
      this.ownHost = lookup
      lookup.catch(() => {
        if (this.ownHost === lookup) this.ownHost = undefined
      })
    }
    return this.ownHost
  }

  /** Join the live room: listen the first time, rejoin after leaving. Never throws. */
  private startLive(): void {
    const client = this.client
    const listen = client.listenForLiveMessages
    if (!this.live || listen === undefined) return
    const joinRoom = client.joinRoom
    if (this.liveState === 'left' && joinRoom !== undefined) {
      this.liveState = 'on'
      quietly(() => joinRoom.call(client, this.messageBox, this.host))
      return
    }
    if (this.liveState !== 'off') return
    this.liveState = 'starting'
    // Called on a later tick, so even a client that throws synchronously cannot escape.
    Promise.resolve()
      .then(() =>
        listen.call(client, {
          messageBox: this.messageBox,
          onMessage: m => this.onLive(m),
          overrideHost: this.host
        })
      )
      .then(
        () => {
          this.liveState = 'on'
          if (this.subs.size === 0) this.leaveLive()
        },
        () => {
          // Polling carries on; the next first subscription tries again.
          this.liveState = 'off'
        }
      )
  }

  /**
   * Leave the live room, if in it and the client can both leave and join again (so a later
   * subscription never registers a second live handler). Never throws.
   */
  private leaveLive(): void {
    const client = this.client
    const leaveRoom = client.leaveRoom
    if (this.liveState !== 'on' || leaveRoom === undefined || client.joinRoom === undefined) {
      return
    }
    this.liveState = 'left'
    quietly(() => leaveRoom.call(client, this.messageBox))
  }

  /**
   * A message from the live room: delivered like a polled one if it is a new envelope, and
   * acknowledged with the next poll. Anything else is left for polling to read.
   */
  private onLive(m: unknown): void {
    if (this.subs.size === 0 || typeof m !== 'object' || m === null) return
    if (envelopeOf((m as Record<string, unknown>).body) === undefined) return
    const state: PollState = { handled: 0, toAck: this.liveAcks }
    this.take(m, state)
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
    // Live ids a poll has confirmed in the meantime are not acked twice.
    for (const id of this.liveAcks) if (this.seen.get(id) !== true) state.toAck.add(id)
    this.liveAcks.clear()
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

function noop(): void {}

/** Run `fn` on a later tick and ignore how it ends, synchronous throws included. */
function quietly(fn: () => Promise<unknown>): void {
  Promise.resolve().then(fn).catch(noop)
}

/** Whether `e` is MessageBox refusing a message it already holds (`ERR_DUPLICATE_MESSAGE`). */
function isDuplicate(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const { code, message } = e as { code?: unknown; message?: unknown }
  return (
    code === 'ERR_DUPLICATE_MESSAGE' ||
    (typeof message === 'string' && message.includes('ERR_DUPLICATE_MESSAGE'))
  )
}

function pollInterval(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback
  if (!Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds`)
  }
  return v
}
