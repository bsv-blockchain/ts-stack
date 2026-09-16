import { DeliveryFailed, GroupMessagingError, isPermanent } from '../../errors.js'
import type { IdentityKey, Unsubscribe, WirePayload } from '../../types.js'
import type { TransportBackend } from '../backend.js'
import { decodeBody, encodeBody, UnparsableBodyError } from './message-box-body.js'

/**
 * The MessageBox client surface this backend needs — a structural subset of
 * `@bsv/message-box-client`, so that package satisfies it without being a
 * dependency here.
 *
 * `listMessages`'s `body` is `string | Record<string, unknown>` because the
 * real client pre-parses JSON bodies before handing them back (its own
 * `tryParse`), so what this backend sends as a string comes back as an
 * object; see {@link decodeBody} for both forms.
 *
 * Every member is a function-typed property rather than a method. TypeScript
 * compares method parameters bivariantly, so a signature that drifted apart
 * from the real client's would still be accepted here; properties are checked
 * contravariantly under `strictFunctionTypes`, which is the whole point of
 * having a conformance check.
 */
export interface MessageBoxClientLike {
  sendMessage: (args: { recipient: string; messageBox: string; body: string }) => Promise<unknown>
  listMessages: (args: { messageBox: string; acceptPayments?: boolean; host?: string }) => Promise<
    Array<{
      messageId: string
      sender: string
      created_at: string
      body: string | Record<string, unknown>
    }>
  >
  acknowledgeMessage: (args: { messageIds: string[]; host?: string }) => Promise<unknown>
  /**
   * The live half, optional because a client older than 2.5.0 does not have a
   * usable one and a host may pass whatever it already has. Absent members are
   * caught at `start` and reported, not at compile time in the host.
   */
  initializeConnection?: (overrideHost?: string) => Promise<void>
  listenForLiveMessages?: (args: {
    messageBox: string
    onMessage: (message: InboxMessage) => void
  }) => Promise<void>
  leaveRoom?: (messageBox: string) => Promise<void>
  disconnectWebSocket?: () => Promise<void>
  getJoinedRooms?: () => Set<string>
  /**
   * Send over the socket, falling back to HTTP itself when it cannot.
   *
   * Needed because the relay is driven by the *sender*: an HTTP `sendMessage`
   * stores the message in the recipient's box but does not broadcast it into
   * their room, so a live subscriber with nothing sending live hears nothing.
   */
  sendLiveMessage?: (args: {
    recipient: string
    messageBox: string
    body: string
  }) => Promise<unknown>
}

/** What the live socket is doing, for a host that wants to show or log it. */
export interface LiveStatus {
  phase:
    'connecting' | 'subscribed' | 'delivered' | 'strike' | 'reconnecting' | 'abandoned' | 'closed'
  /** Which producer carried a delivery. */
  source?: 'socket' | 'poll'
  detail?: string
}

/** Raised when `live` was asked for and the socket could not carry it. */
export class LiveDeliveryUnavailable extends GroupMessagingError {
  override name = 'LiveDeliveryUnavailable'
}

/** The host Nexus uses. A string for the caller's client, not a connection. */
export const DEFAULT_MESSAGE_BOX_HOST = 'https://gmb.bsvblockchain.tech'
export const DEFAULT_MESSAGE_BOX = 'group_messaging'
export const DEFAULT_POLL_INTERVAL_MS = 5000
export const DEFAULT_MAX_ATTEMPTS = 3
/**
 * How many message ids the backend remembers, in each of its three ledgers.
 *
 * Both are pruned only on the happy path. Handled ids go when the
 * acknowledgement succeeds, and the real `acknowledgeMessage` throws whenever
 * no host accepts; attempt counts go when the message is finally given up on
 * or gets through, and a message that fails once and never returns never
 * reaches either. Both would otherwise grow for the life of the process.
 *
 * A thousand is far past any real backlog at a five-second poll. Forgetting a
 * handled id costs one duplicate delivery, which MLS rejects as a replay;
 * forgetting an attempt count costs a message one extra try. Both are cheaper
 * than unbounded memory.
 */
export const MAX_REMEMBERED_MESSAGES = 1000

export interface MessageBoxTransportOptions {
  /** Which box to send to and read. Default `group_messaging`. */
  messageBox?: string
  /** How often to read it, in milliseconds. Default 5000. */
  pollIntervalMs?: number
  /**
   * Delivery attempts a message gets before it is given up on: acknowledged
   * and reported rather than retried forever. Default 3.
   */
  maxAttempts?: number
  /**
   * Also subscribe to the live socket, with polling kept on underneath as a
   * backstop. Default false.
   *
   * Additive rather than an alternative, because the socket cannot be a sole
   * source: `joinRoom` replays no backlog, so anything sent while it was down
   * is only ever seen by a poll. When on, the poll slows to
   * {@link LIVE_BACKSTOP_INTERVAL_MS}.
   *
   * The transport owns the socket's lifecycle while this is set — it connects
   * on `start` and disconnects on `close`. A host sharing one
   * `MessageBoxClient` with other consumers of the same socket should know
   * that before turning this on.
   */
  live?: boolean
}

/** How often the poll still reads the box when the live socket is carrying it. */
export const LIVE_BACKSTOP_INTERVAL_MS = 30_000

/**
 * Backstop polls that find messages the socket did not, before the socket is
 * treated as deaf.
 *
 * One is not evidence: a message can legitimately land in a poll that was
 * already in flight when the push arrived. Two in a row, with nothing at all
 * delivered over the socket in between, is — and the cost of being wrong is one
 * reconnect.
 */
export const LIVE_DEAF_STRIKES = 2

/**
 * Reconnects attempted before live delivery is abandoned for the session.
 *
 * `listenForLiveMessages` registers a handler it offers no way to remove, so
 * each attempt that fails to help leaves one behind. Bounded here rather than
 * retried forever.
 */
export const LIVE_MAX_RESUBSCRIBES = 2

/**
 * The host a client was built with, if it will tell us.
 *
 * Naming the host on a read or an acknowledgement skips an overlay lookup per
 * call — the client otherwise resolves advertised hosts first, which is what
 * a *sender* needs and a reader of its own box never does. `host` is
 * `private` in `@bsv/message-box-client`'s types, so it is not part of that
 * package's contract and is read here rather than required in
 * {@link MessageBoxClientLike}: if a future version stops exposing it, this
 * returns `undefined` and the calls behave exactly as they did before.
 */
const readHost = (client: MessageBoxClientLike): string | undefined => {
  const host = (client as { host?: unknown }).host
  return typeof host === 'string' && host.trim() !== '' ? host : undefined
}

/**
 * The `host` argument to spread onto a `listMessages` or `acknowledgeMessage`
 * call, present only when {@link readHost} finds one — never guessed at,
 * since a wrong guess would read a different box than the one this client
 * sends to.
 */
const hostArg = (client: MessageBoxClientLike): { host: string } | Record<string, never> => {
  const host = readHost(client)
  return host !== undefined ? { host } : {}
}

/** One message as MessageBox hands it over. */
interface InboxMessage {
  messageId: string
  sender: IdentityKey
  /** The server's arrival time, and the only ordering this backend can trust. */
  created_at: string
  body: string | Record<string, unknown>
}

/**
 * Where inbound messages come from. Private on purpose: polling is the only
 * producer in v1, and a live socket arrives later as `delivery?: "poll" | "live"`
 * rather than as a plugin surface. A caller who needs a different producer
 * implements {@link TransportBackend} instead.
 */
interface MessageBoxSource {
  start(deliver: (messages: InboxMessage[]) => Promise<void>): Promise<void>
  close(): Promise<void>
}

/**
 * Read the box on a timer.
 *
 * A tick that overlaps the previous one is skipped rather than queued: `deliver`
 * resolves only once the batch is acknowledged, and a slow batch behind a fast
 * interval would otherwise deliver the same messages twice.
 */
class PollingSource implements MessageBoxSource {
  #timer: ReturnType<typeof setInterval> | undefined
  #inFlight: Promise<void> | undefined

  constructor(
    private readonly client: MessageBoxClientLike,
    private readonly messageBox: string,
    private intervalMs: number,
    private readonly onError: (error: Error) => void
  ) {}

  #deliver: ((messages: InboxMessage[]) => Promise<void>) | undefined

  /** Re-arm at a new cadence, used when live delivery is given up on. */
  retune(intervalMs: number): void {
    if (this.#timer === undefined || this.#deliver === undefined) return
    this.intervalMs = intervalMs
    clearInterval(this.#timer)
    this.#timer = undefined
    void this.start(this.#deliver)
  }

  async start(deliver: (messages: InboxMessage[]) => Promise<void>): Promise<void> {
    if (this.#timer !== undefined) return
    this.#deliver = deliver
    const tick = async (): Promise<void> => {
      try {
        const messages = await this.client.listMessages({
          messageBox: this.messageBox,
          // This transport moves ciphertext, never money. The client's default
          // is true, which would internalize any payment an unauthenticated
          // sender dropped in the box — through the user's wallet, every poll.
          acceptPayments: false,
          ...hostArg(this.client)
        })
        if (messages.length > 0) await deliver(messages)
      } catch (cause) {
        this.onError(toError(cause))
      }
    }
    this.#timer = setInterval(() => {
      if (this.#inFlight !== undefined) return
      const running = tick().finally(() => {
        if (this.#inFlight === running) this.#inFlight = undefined
      })
      this.#inFlight = running
    }, this.intervalMs)
  }

  /**
   * Stops the timer and waits for a tick already running.
   *
   * Waiting is the load-bearing half. A caller closes the transport and then
   * drops its handlers; a tick still in flight would deliver into whatever is
   * left of them and acknowledge the batch as processed.
   */
  async close(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#inFlight
  }
}

/** The live half of the client, once every member is known to be present. */
type LiveCapableClient = MessageBoxClientLike &
  Required<
    Pick<
      MessageBoxClientLike,
      'initializeConnection' | 'listenForLiveMessages' | 'leaveRoom' | 'disconnectWebSocket'
    >
  >

const liveCapable = (client: MessageBoxClientLike): LiveCapableClient | undefined =>
  typeof client.initializeConnection === 'function' &&
  typeof client.listenForLiveMessages === 'function' &&
  typeof client.leaveRoom === 'function' &&
  typeof client.disconnectWebSocket === 'function'
    ? (client as LiveCapableClient)
    : undefined

/**
 * Take messages as the socket pushes them.
 *
 * Never the only source: `joinRoom` replays no backlog, so anything sent while
 * the socket was down reaches this device only through a poll.
 */
class LiveSource implements MessageBoxSource {
  #closed = false
  #deliver: ((messages: InboxMessage[]) => Promise<void>) | undefined
  readonly #inFlight = new Set<Promise<void>>()

  constructor(
    private readonly client: LiveCapableClient,
    private readonly messageBox: string,
    private readonly onError: (error: Error) => void,
    private readonly onStatus: (status: LiveStatus) => void
  ) {}

  async start(deliver: (messages: InboxMessage[]) => Promise<void>): Promise<void> {
    this.#deliver = deliver
    await this.bringUp()
  }

  async bringUp(): Promise<void> {
    this.onStatus({ phase: 'connecting' })
    await this.client.initializeConnection()
    await this.client.listenForLiveMessages({
      messageBox: this.messageBox,
      onMessage: message => this.#onPush(message)
    })
    this.onStatus({ phase: 'subscribed' })
  }

  /**
   * Leave the room first, and only then disconnect.
   *
   * `leaveRoom` is the only thing that clears the client's `joinedRooms`, and
   * it refuses to do so once the socket is gone. Disconnecting first therefore
   * strands the entry, and the next `joinRoom` returns early without rejoining
   * — a socket that is connected, believes it is subscribed, and receives
   * nothing.
   */
  async tearDown(): Promise<void> {
    await this.client.leaveRoom(this.messageBox)
    // `leaveRoom` is the only thing that clears the client's `joinedRooms`,
    // and it returns early once the socket is gone — which is exactly the case
    // a disconnect leaves behind. Unrepaired, the next `joinRoom` sees the
    // stale entry and never re-emits, so the reconnect rejoins nothing.
    const rooms = this.client.getJoinedRooms?.()
    if (rooms !== undefined) {
      for (const room of rooms) {
        if (room.endsWith(`-${this.messageBox}`)) rooms.delete(room)
      }
    }
    await this.client.disconnectWebSocket()
  }

  /**
   * Drop the socket without waiting for deliveries already in flight.
   *
   * `close` waits for them; this cannot, because it is called from inside the
   * delivery chain those deliveries are queued on — waiting would be a cycle.
   * They stay queued and are delivered normally; only the socket goes.
   */
  abandon(): void {
    this.#closed = true
    void this.tearDown().catch(cause => this.onError(toError(cause)))
  }

  /**
   * `listenForLiveMessages` hands back no way to unregister, so a push can
   * arrive after close. Dropping it here is what stops it being delivered into
   * handlers the caller has already taken down, and acknowledged on the way.
   */
  #onPush(message: InboxMessage): void {
    const deliver = this.#deliver
    if (this.#closed || deliver === undefined) return
    const running: Promise<void> = deliver([message])
      .catch(cause => this.onError(toError(cause)))
      .finally(() => this.#inFlight.delete(running))
    this.#inFlight.add(running)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.onStatus({ phase: 'closed' })
    await Promise.all(this.#inFlight)
    try {
      await this.tearDown()
    } catch (cause) {
      this.onError(toError(cause))
    }
  }
}

/**
 * Delivery over BRC-33 PeerServ / MessageBox.
 *
 * The client is the host's: this class never constructs one, so the library
 * still opens no connection of its own. Acknowledgement is the load-bearing
 * part — a message is acknowledged only once every handler has processed it
 * without throwing, so a crash between arrival and the durable write leaves the
 * message in the box rather than losing it.
 */
export class MessageBoxTransport implements TransportBackend {
  readonly messageBox: string
  readonly #handlers = new Set<(from: IdentityKey, payload: Uint8Array) => void | Promise<void>>()
  /** Reported on `start`, so a caller that asked for live hears it went unserved. */
  #liveRefused: LiveDeliveryUnavailable | undefined
  readonly #errorHandlers = new Set<(error: Error) => void>()
  readonly #liveStatusHandlers = new Set<(status: LiveStatus) => void>()
  readonly #poll: PollingSource
  #live: LiveSource | undefined
  readonly #pollIntervalMs: number
  /** Serialises every source, so two pushes cannot both pass the handled check. */
  #chain: Promise<unknown> = Promise.resolve()
  #deafStrikes = 0
  #resubscribes = 0
  /**
   * Failed delivery attempts per message id, capped the same way as the
   * handled set. An entry is cleared when the message gets through or is
   * given up on; a message that fails once and never comes back would
   * otherwise leave one behind forever.
   */
  readonly #attempts = new Map<string, number>()
  /**
   * Message ids already processed and awaiting acknowledgement, kept until
   * the acknowledgement is known to have succeeded. Membership means "do not
   * deliver again, but keep acknowledging" rather than "ignore" — a message
   * still in this set is re-added to the outgoing `acknowledge` batch every
   * cycle, so a box that returns it again before the ack lands is not
   * delivered twice, and a failed `acknowledgeMessage` call is retried
   * rather than abandoned. Pruned on ack success, and capped at
   * {@link MAX_REMEMBERED_MESSAGES} for the case where the ack never succeeds:
   * an id lingering past its ack risks nothing worse than a duplicate
   * delivery, which MLS itself rejects as a replay, whereas retaining every id
   * for the life of the process is unbounded growth.
   */
  readonly #handled = new Set<string>()
  /**
   * Ids that have been delivered, or given up on, and must not be delivered
   * again. Distinct from {@link MessageBoxTransport.#handled}, which is only
   * the wait for an acknowledgement and is emptied once that succeeds: a
   * message pushed twice over the socket arrives after that, and a message
   * whose handler threw must stay eligible for the retry it is owed.
   */
  readonly #seen = new Set<string>()
  readonly #maxAttempts: number

  constructor(
    private readonly client: MessageBoxClientLike,
    options: MessageBoxTransportOptions = {}
  ) {
    this.messageBox = options.messageBox ?? DEFAULT_MESSAGE_BOX
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const live = options.live === true ? liveCapable(client) : undefined
    if (options.live === true && live === undefined) {
      this.#liveRefused = new LiveDeliveryUnavailable(
        'This MessageBoxClient has no live socket methods; delivery falls back to polling. ' +
          '@bsv/message-box-client 2.5.0 or newer is needed for live delivery.'
      )
    }
    // Polling keeps running underneath a live socket, just slower: the socket
    // is never a sole source, so the poll is what makes the gap recoverable.
    this.#pollIntervalMs = pollIntervalMs
    this.#poll = new PollingSource(
      client,
      this.messageBox,
      live === undefined ? pollIntervalMs : Math.max(pollIntervalMs, LIVE_BACKSTOP_INTERVAL_MS),
      error => this.#report(error)
    )
    this.#live =
      live === undefined
        ? undefined
        : new LiveSource(
            live,
            this.messageBox,
            error => this.#report(error),
            status => this.#status(status)
          )
  }

  /**
   * What the live socket is doing. Nothing is reported when `live` is off.
   *
   * The one question a host cannot otherwise answer is which producer carried a
   * message: a socket that connects, subscribes and then silently relays
   * nothing looks exactly like a healthy one from out here.
   */
  onLiveStatus(handler: (status: LiveStatus) => void): Unsubscribe {
    this.#liveStatusHandlers.add(handler)
    return () => {
      this.#liveStatusHandlers.delete(handler)
    }
  }

  #status(status: LiveStatus): void {
    for (const handler of this.#liveStatusHandlers) {
      try {
        handler(status)
      } catch (cause) {
        this.#report(toError(cause))
      }
    }
  }

  /**
   * Send, over the socket while one is carrying.
   *
   * The relay is driven by the sender: an HTTP `sendMessage` files the message
   * in the recipient's box without broadcasting it to their room, so a live
   * subscriber on the other side would never be pushed anything. The client's
   * own `sendLiveMessage` falls back to HTTP when the socket cannot take it.
   */
  async send(recipient: IdentityKey, payload: WirePayload): Promise<void> {
    const body = encodeBody(payload)
    const sendLive = this.#live !== undefined ? this.client.sendLiveMessage : undefined
    if (sendLive !== undefined) {
      await sendLive.call(this.client, { recipient, messageBox: this.messageBox, body })
      return
    }
    await this.client.sendMessage({ recipient, messageBox: this.messageBox, body })
  }

  onMessage(
    handler: (from: IdentityKey, payload: Uint8Array) => void | Promise<void>
  ): Unsubscribe {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    this.#errorHandlers.add(handler)
    return () => {
      this.#errorHandlers.delete(handler)
    }
  }

  async start(): Promise<void> {
    if (this.#liveRefused !== undefined) this.#report(this.#liveRefused)
    await this.#poll.start(async messages => this.#enqueue(messages, 'poll'))
    const live = this.#live
    if (live === undefined) return
    try {
      await live.start(async messages => this.#enqueue(messages, 'live'))
    } catch (cause) {
      // `initializeConnection` may well have built the socket before the
      // failure, and the client auto-reconnects whatever it built.
      await live.close()
      this.#abandonLive(
        new LiveDeliveryUnavailable(`Live delivery could not start: ${toError(cause).message}`)
      )
    }
  }

  async close(): Promise<void> {
    await this.#poll.close()
    await this.#live?.close()
  }

  /**
   * Deliver one batch, and report how much of it was seen for the first time.
   *
   * Serialised because two live pushes of the same message would otherwise both
   * pass the `#handled` check before either recorded it — a race polling never
   * had, since its ticks never overlap.
   */
  async #enqueue(messages: InboxMessage[], origin: 'poll' | 'live'): Promise<void> {
    const next = this.#chain.then(async () => {
      const fresh = await this.#deliver(messages)
      if (this.#live !== undefined && messages.length > 0) {
        this.#status({
          phase: 'delivered',
          source: origin === 'live' ? 'socket' : 'poll',
          detail: `${messages.length} message(s), ${fresh} new`
        })
      }
      if (this.#live === undefined) return
      if (origin === 'live') {
        // Proof the socket works, even for a message the poll already carried:
        // a push that loses the race still arrived.
        this.#deafStrikes = 0
        this.#resubscribes = 0
        return
      }
      if (fresh === 0) return
      this.#deafStrikes += 1
      this.#status({
        phase: 'strike',
        detail: `the backstop carried what the socket did not (${this.#deafStrikes} of ${LIVE_DEAF_STRIKES})`
      })
      if (this.#deafStrikes < LIVE_DEAF_STRIKES) return
      this.#deafStrikes = 0
      await this.#recoverLive()
    })
    this.#chain = next.catch(() => undefined)
    await next
  }

  /**
   * The backstop has carried real traffic twice running with nothing arriving
   * over the socket. Rebuild it, or stop pretending it works.
   */
  async #recoverLive(): Promise<void> {
    const live = this.#live
    if (live === undefined) return
    if (this.#resubscribes >= LIVE_MAX_RESUBSCRIBES) {
      this.#abandonLive(
        new LiveDeliveryUnavailable(
          'The live socket stopped delivering and reconnecting did not restore it; ' +
            'polling carries delivery from here.'
        )
      )
      live.abandon()
      return
    }
    this.#resubscribes += 1
    this.#status({
      phase: 'reconnecting',
      detail: `attempt ${this.#resubscribes} of ${LIVE_MAX_RESUBSCRIBES}`
    })
    try {
      await live.tearDown()
      await live.bringUp()
    } catch (cause) {
      this.#report(toError(cause))
    }
  }

  /** Drop live delivery, say so, and give the poll its own cadence back. */
  #abandonLive(error: LiveDeliveryUnavailable): void {
    this.#live = undefined
    this.#status({ phase: 'abandoned', detail: error.message })
    this.#report(error)
    this.#poll.retune(this.#pollIntervalMs)
  }

  async #deliver(messages: InboxMessage[]): Promise<number> {
    // Nobody is subscribed, so nothing can have been processed. Delivering to
    // an empty set completes without throwing, which would acknowledge the
    // whole batch on the way out and destroy it.
    if (this.#handlers.size === 0) return 0
    const acknowledge: string[] = []
    let fresh = 0
    for (const message of [...messages].sort(byArrival)) {
      if (this.#handled.has(message.messageId)) {
        acknowledge.push(message.messageId)
        continue
      }
      // Finished with, but the box is still handing it back: acknowledge it
      // again rather than skip it, or a message whose acknowledgement never
      // took is re-listed on every poll for the life of the process.
      if (this.#seen.has(message.messageId)) {
        acknowledge.push(message.messageId)
        continue
      }
      // Only a message seen for the first time says anything about the socket.
      // A retry is one the socket may well have delivered already.
      if (!this.#attempts.has(message.messageId)) fresh += 1

      let payload: Uint8Array
      try {
        payload = decodeBody(message.body)
      } catch (cause) {
        const error = toError(cause)
        if (error instanceof UnparsableBodyError) {
          this.#failed(message.messageId, error, acknowledge)
        } else {
          this.#report(error)
          this.#give(message.messageId, acknowledge)
        }
        continue
      }

      // Per handler, not per batch: `onMessage` takes any number of
      // subscribers, so one that throws must not skip the rest. In the normal
      // wiring TransportService is the only subscriber and has already reported
      // its own, which is why its aggregate is not reported again here.
      const failures: Error[] = []
      for (const handler of this.#handlers) {
        try {
          await handler(message.sender, payload)
        } catch (cause) {
          const error = toError(cause)
          if (!(error instanceof DeliveryFailed)) this.#report(error)
          failures.push(error)
        }
      }
      if (failures.length === 0) this.#give(message.messageId, acknowledge)
      else
        this.#failed(message.messageId, new DeliveryFailed(message.sender, failures), acknowledge)
    }
    this.#forget()
    if (acknowledge.length > 0) {
      await this.client.acknowledgeMessage({ messageIds: acknowledge, ...hostArg(this.client) })
      for (const messageId of acknowledge) this.#handled.delete(messageId)
    }
    return fresh
  }

  /**
   * Count one failed attempt and decide whether the message gets another.
   *
   * Shared by a handler that threw and by a body that never parsed, because
   * the response is the same in both cases: report, leave it in the box, and
   * give up only once the attempt cap is reached — unless the failure is
   * {@link isPermanent}, in which case one attempt is all it will ever get.
   * A {@link DeliveryFailed} aggregate is permanent only if every handler
   * inside it failed permanently; one transient failure means the next poll
   * might still get that handler through.
   */
  #failed(messageId: string, error: Error, acknowledge: string[]): void {
    // TransportService reports each handler failure before summarizing them as
    // DeliveryFailed, and its own error channel forwards whatever this backend
    // reports straight back to the same subscribers. Reporting the summary too
    // would multiply one fault into a stream of processingFailed events — and,
    // with no error handler registered, one uncaught exception per event.
    if (!(error instanceof DeliveryFailed)) this.#report(error)
    if (isPermanent(error)) {
      this.#give(messageId, acknowledge)
      return
    }
    const attempts = (this.#attempts.get(messageId) ?? 0) + 1
    this.#attempts.set(messageId, attempts)
    if (attempts < this.#maxAttempts) return
    this.#report(
      new GroupMessagingError(`Giving up on message ${messageId} after ${attempts} attempts`)
    )
    this.#give(messageId, acknowledge)
  }

  /**
   * Mark a message finished: acknowledged on the wire, and never delivered
   * again even if the box returns it before the acknowledgement lands.
   */
  #give(messageId: string, acknowledge: string[]): void {
    this.#handled.add(messageId)
    this.#seen.add(messageId)
    this.#attempts.delete(messageId)
    acknowledge.push(messageId)
  }

  /**
   * Drop the oldest remembered ids from both ledgers down to the cap.
   *
   * Between batches, never inside one. Evicting mid-batch would forget an id
   * the same loop is about to look up, so one eviction would cascade into
   * redelivering the whole batch instead of the single oldest message.
   */
  #forget(): void {
    // Sets and Maps iterate in insertion order, so the first entry is oldest.
    for (const ledger of [this.#handled, this.#seen, this.#attempts]) {
      while (ledger.size > MAX_REMEMBERED_MESSAGES) {
        const oldest = ledger.keys().next()
        if (oldest.done === true) break
        ledger.delete(oldest.value)
      }
    }
  }

  #report(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error)
  }
}

/**
 * Oldest first, by the server's own timestamp.
 *
 * The real client merges every host's messages into a Map and then sorts on
 * `timestamp`, a field its own `PeerMessage` does not declare, so the batch
 * arrives in an order nobody chose. MLS needs the Commit before the messages
 * in its epoch; the reorder buffer can absorb a stray, but it should not have
 * to. `created_at` is a string, so it is compared as a date and falls back to
 * a plain string comparison for anything not date-shaped. Sorting is stable,
 * which leaves same-instant messages in the order the host gave them.
 */
const byArrival = (left: InboxMessage, right: InboxMessage): number => {
  const at = Date.parse(left.created_at)
  const to = Date.parse(right.created_at)
  if (!Number.isNaN(at) && !Number.isNaN(to)) return at - to
  if (left.created_at === right.created_at) return 0
  return left.created_at < right.created_at ? -1 : 1
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
