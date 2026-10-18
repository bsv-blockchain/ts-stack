import { RELAY_PROTOCOL_ID } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { toHex, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import type { WebRTPayErrorCode } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import { isSignalEnvelope } from './envelope.js'
import type { SignalEnvelope, Signaler } from './types.js'

/** Domain separation for the relay authentication message. */
export const RELAY_AUTH_PREFIX = 'webrtpay-relay/1|'

/**
 * Why the relay refused a frame or a socket. `unavailable` answers a `turn` request the
 * relay's TURN provider could not serve just then.
 */
export type RelayErrorCode =
  'offline' | 'rate_limited' | 'too_large' | 'bad_request' | 'auth_failed' | 'unavailable'

/**
 * Where the relay connection stands: being opened and authenticated, `online`
 * (authenticated), or `offline` (none, or waiting to reconnect).
 */
export type RelayConnectionState = 'connecting' | 'online' | 'offline'

/** An ICE server as the relay hands it out. */
export interface RelayIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** JSON text frames a client sends to the relay. */
export type RelayClientFrame =
  /** Answer to the challenge: a hex DER signature by `identityKey` over {@link relayAuthData}. */
  | { t: 'auth'; identityKey: PubKeyHex; signature: string }
  | { t: 'signal'; to: PubKeyHex; envelope: SignalEnvelope }
  /** Ask for TURN credentials; answered with `ice` or `error`. */
  | { t: 'turn' }

/**
 * JSON text frames the relay sends to a client. Every client frame after `auth`
 * gets exactly one reply, in the order the frames were sent: `sent` or `error` for
 * a `signal`, `ice` or `error` for a `turn`. `ref` is the envelope sid when the
 * frame carried a well-formed envelope. `ice` also follows `ready` unasked, with
 * STUN servers only. An `ice` with TURN servers carries `expiresAt`, when their
 * credentials stop working (Unix milliseconds).
 */
export type RelayServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready'; identityKey: PubKeyHex }
  | { t: 'ice'; iceServers: RelayIceServer[]; expiresAt?: number }
  | { t: 'signal'; from: PubKeyHex; envelope: SignalEnvelope }
  | { t: 'sent'; ref?: string }
  | { t: 'error'; code: RelayErrorCode; ref?: string }

/** `url` without trailing slashes, the form both ends sign and verify. */
export function normalizeRelayUrl(url: string): string {
  let end = url.length
  while (end > 0 && url.codePointAt(end - 1) === 47) end--
  return url.slice(0, end)
}

/**
 * The bytes a client signs to authenticate to the relay at `url`:
 * UTF-8 of `"webrtpay-relay/1|" + url + "|" + nonce`, with the url normalized.
 */
export function relayAuthData(url: string, nonce: string): number[] {
  return Array.from(utf8Encode(RELAY_AUTH_PREFIX + normalizeRelayUrl(url) + '|' + nonce))
}

export interface RelaySignalerOptions {
  /** Relay WebSocket URL (`ws:` or `wss:`); it is signed without trailing slashes. */
  url: string
  /** Signs the relay's challenge with the identity key. */
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  originator?: string
  /** WebSocket constructor; defaults to the global one (browsers, Node 22 and later). */
  WebSocket?: typeof WebSocket
  /** Called with the ICE servers the relay hands out on every (re)connection and `requestTurn`. */
  onIceServers?: (servers: RTCIceServer[]) => void
  /**
   * Called whenever the connection state changes; see {@link RelayConnectionState}. Going
   * `offline` because the connection or the attempt to open it failed passes the error that
   * ended it (such as `auth_failed` when the relay expects another url, or `peer_unreachable`
   * when it cannot be reached), so an app can show why; going `offline` because nothing
   * needs the connection any more, or after `close()`, passes none.
   */
  onStateChange?: (state: RelayConnectionState, error?: WebRTPayError) => void
  /**
   * Called with what `onIceServers` or `onStateChange` threw. Such a throw never reaches the
   * connection: signaling goes on as if the callback had returned. Anything this throws is
   * ignored.
   */
  onCallbackError?: (e: unknown) => void
  /** Source of reconnect jitter, uniform in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

/** Time allowed to open, authenticate and receive ICE servers. */
const CONNECT_TIMEOUT_MS = 15000
/** Time the relay has to confirm a signal before the connection is dropped. */
const SEND_TIMEOUT_MS = 10000
/** Time `close()` waits for the closing handshake. */
const CLOSE_WAIT_MS = 2000
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
/** Time a connection must stay authenticated before the reconnect backoff starts over. */
const STABLE_MS = 30000
/** Longest challenge nonce accepted (it becomes a BRC-43 key ID). */
const MAX_NONCE_CHARS = 256
const CLOSED = 3
const RELAY_URL_RE = /^wss?:\/\/[^/?#\s]+/i
/** A coturn REST username, `<unix expiry seconds>:<user>`. */
const TURN_REST_USERNAME_RE = /^(\d{1,15}):/
/**
 * TURN credentials this close to their expiry count as expired: the gather and the
 * connection that use them have to fit before the TURN server refuses them.
 */
const TURN_EXPIRY_MARGIN_MS = 30000

const RELAY_ERRORS: Record<RelayErrorCode, [WebRTPayErrorCode, string]> = {
  offline: ['peer_unreachable', 'Peer is not connected to the relay'],
  rate_limited: ['rate_limited', 'Relay rate limit reached'],
  too_large: ['too_large', 'Signal envelope is too large for the relay'],
  bad_request: ['protocol', 'Relay rejected the frame as malformed'],
  auth_failed: ['auth_failed', 'Relay authentication failed'],
  unavailable: ['unavailable', 'Relay could not get TURN credentials; try again later']
}

/** ICE servers as one `ice` frame listed them. */
interface IceList {
  servers: RTCIceServer[]
  /** When the TURN servers' credentials stop working (Unix milliseconds), if the relay said. */
  expiresAt: number | undefined
}

/**
 * Carries signal envelopes through a `@bsv/webrtpay/server` relay over one
 * authenticated WebSocket.
 *
 * The socket is held only while it is needed: while at least one `listen`
 * subscription exists, while a `send` is in flight, or after an explicit
 * `connect()`. Otherwise it is closed, so the relay reports this identity as
 * offline and a peer's `send` fails fast with `peer_unreachable`. While
 * listening, a connection that could not be opened or dropped is reopened after a
 * random delay below a cap (full jitter, so clients that lost the relay together
 * do not return together). The cap is 1 s after a connection that stayed
 * authenticated for 30 s, and doubles per attempt that failed or dropped sooner,
 * up to 30 s. `onStateChange` follows it.
 *
 * Failures reject `WebRTPayError`: `peer_unreachable` (relay unreachable, the
 * connection dropped, or the peer is offline), `auth_failed`, `rate_limited`
 * (also for too many sockets for this identity), `too_large`, `unavailable` (the
 * relay's TURN provider could not issue credentials), `protocol` (also for a reply
 * that does not match its request, which ends the connection) and, after
 * `close()`, `closed`.
 */
export class RelaySignaler implements Signaler {
  private readonly url: string
  private readonly wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  private readonly originator: string | undefined
  private readonly WS: typeof WebSocket
  private readonly onIceServers: ((servers: RTCIceServer[]) => void) | undefined
  private readonly onStateChange:
    ((state: RelayConnectionState, error?: WebRTPayError) => void) | undefined
  private readonly onCallbackError: ((e: unknown) => void) | undefined
  private readonly random: () => number
  private readonly subs = new Set<SignalSubscription>()
  private conn: RelayConnection | undefined
  private ice: IceList | undefined
  /** The servers of the last successful `requestTurn`, kept across connections. */
  private turn: IceList | undefined
  /** The `requestTurn` that `turnProvider` callers are waiting for. */
  private turnRequest: Promise<RTCIceServer[]> | undefined
  private explicit = false
  /** `send` and `requestTurn` calls in progress; each holds the connection open. */
  private inFlight = 0
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> | undefined
  private state: RelayConnectionState = 'offline'

  constructor(o: RelaySignalerOptions) {
    if (typeof o.url !== 'string' || !RELAY_URL_RE.test(o.url)) {
      throw new TypeError('Relay url must be a ws: or wss: URL')
    }
    const WS = o.WebSocket ?? globalThis.WebSocket
    if (typeof WS !== 'function') {
      throw new WebRTPayError('unsupported', 'No WebSocket implementation is available')
    }
    this.url = o.url
    this.wallet = o.wallet
    this.originator = o.originator
    this.WS = WS
    this.onIceServers = o.onIceServers
    this.onStateChange = o.onStateChange
    this.onCallbackError = o.onCallbackError
    this.random = o.random ?? Math.random
  }

  /** Open and authenticate now, and keep the connection until `close()`. */
  async connect(): Promise<void> {
    this.explicit = true
    await this.open()
  }

  /** Close the connection for good; later calls reject `closed`. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.clearTimer()
      this.subs.clear()
      const conn = this.conn
      this.conn = undefined
      this.setState('offline')
      this.closing = conn?.close(closedError()) ?? Promise.resolve()
    }
    return this.closing
  }

  /**
   * The ICE servers the relay handed out most recently, on connecting (STUN only) or
   * on `requestTurn`, without TURN servers whose credentials expire within 30 s; undefined
   * before the first connection. The expiry is the `expiresAt` the relay sent with them
   * or, from a relay that sends none, the Unix seconds before the `:` of a coturn REST
   * username. Every new connection resets it to the relay's STUN servers;
   * {@link turnProvider} keeps TURN servers across connections.
   */
  iceServers(): RTCIceServer[] | undefined {
    return this.ice === undefined ? undefined : liveIceServers(this.ice, Date.now())
  }

  /** Forward `e` to every socket of `to`; resolves once the relay confirms. */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    this.inFlight++
    try {
      const conn = await this.open()
      await conn.send(to, e)
    } finally {
      this.inFlight--
      void this.release()
    }
  }

  /**
   * Ask the relay for TURN credentials. Resolves with its full ICE server list
   * (STUN, then TURN), which `iceServers()` returns until the next connection; a relay
   * without TURN answers with its STUN servers only. It rejects `rate_limited` when the
   * relay's hourly budget for this address, or in total, is spent, and `unavailable` when
   * the relay's TURN provider could not issue credentials just then. Every call spends
   * one of this address's credentials (6 an hour by default): for
   * `DirectPayClient`'s `iceServersProvider` use {@link turnProvider}, which reuses them.
   */
  async requestTurn(): Promise<RTCIceServer[]> {
    this.inFlight++
    try {
      const conn = await this.open()
      const list = await conn.requestTurn()
      this.turn = list
      return copyIceServers(list.servers)
    } finally {
      this.inFlight--
      void this.release()
    }
  }

  /**
   * The recommended `iceServersProvider` for a `DirectPayClient` that signals through this
   * relay. The function it returns resolves with the servers of the last `requestTurn`
   * (STUN, then TURN) while one of their TURN servers has more than 30 s left, and calls
   * `requestTurn` only otherwise; calls made while a request is in flight share it, and a
   * failed request is not remembered. A payee gathers for every inbound offer it admits and
   * identities are free, so a provider that asked the relay each time would let strangers
   * spend this address's TURN budget. A relay without TURN answers with STUN only, which
   * leaves nothing to reuse: each call then asks again (one frame, no budget). After
   * `close()` it rejects `closed`.
   */
  turnProvider(): () => Promise<RTCIceServer[]> {
    return () => this.heldTurn()
  }

  /**
   * Subscribe. Resolves once the connection is authenticated or, when the relay
   * cannot be reached or refuses it, once that attempt has failed: the subscription
   * stays, and the connection is retried in the background until it opens or the
   * last subscription ends (see `onStateChange`). While a retry is already waiting,
   * it resolves at once. Rejects only `closed`, after `close()`.
   */
  async listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>> {
    if (this.closing !== undefined) throw closedError()
    const sub: SignalSubscription = { fn }
    this.subs.add(sub)
    if (this.timer === undefined) {
      try {
        await this.open()
      } catch {
        // retried in the background while subscribed
      }
    }
    if (this.closing !== undefined) throw closedError()
    return async () => {
      if (this.subs.delete(sub)) await this.release()
    }
  }

  private heldTurn(): Promise<RTCIceServer[]> {
    if (this.closing !== undefined) return Promise.reject(closedError())
    if (this.turn !== undefined) {
      const live = liveIceServers(this.turn, Date.now())
      if (live.some(isTurnServer)) return Promise.resolve(live)
    }
    this.turnRequest ??= this.requestTurn().finally(() => {
      this.turnRequest = undefined
    })
    return this.turnRequest.then(copyIceServers)
  }

  private open(): Promise<RelayConnection> {
    if (this.closing !== undefined) return Promise.reject(closedError())
    const conn = this.conn ?? this.start()
    return conn.ready.then(() => conn)
  }

  private start(): RelayConnection {
    this.clearTimer()
    const conn = new RelayConnection({
      url: this.url,
      WS: this.WS,
      wallet: this.wallet,
      originator: this.originator,
      onSignal: (from, e) => dispatchSignal(this.subs, from, e),
      onIce: list => {
        this.ice = list
        const callback = this.onIceServers
        if (callback !== undefined) this.callback(() => callback(copyIceServers(list.servers)))
      },
      onOpen: () => {
        if (this.conn === conn) this.setState('online')
      },
      onEnd: (openedAt, err) => this.ended(conn, openedAt, err)
    })
    this.conn = conn
    this.setState('connecting')
    conn.open()
    return conn
  }

  /**
   * The current connection ended with `err`; reconnect while anyone is listening. Only a
   * connection that stayed authenticated for 30 s resets the backoff, so a relay or
   * proxy that drops sockets right after the handshake does not get hit every second.
   */
  private ended(conn: RelayConnection, openedAt: number | undefined, err: WebRTPayError): void {
    if (this.conn !== conn) return
    this.conn = undefined
    this.setState('offline', err)
    if (openedAt !== undefined && Date.now() - openedAt >= STABLE_MS) this.failures = 0
    else this.failures++
    if (this.closing !== undefined || this.subs.size === 0) return
    const cap = Math.min(MIN_BACKOFF_MS * 2 ** this.failures, MAX_BACKOFF_MS)
    const delay = this.random() * cap
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.conn === undefined && this.closing === undefined && this.subs.size > 0) {
        this.start()
      }
    }, delay)
  }

  /** Close the connection when nothing holds it any more. */
  private release(): Promise<void> {
    if (this.subs.size === 0) this.clearTimer()
    if (this.subs.size > 0 || this.inFlight > 0 || this.explicit) return Promise.resolve()
    const conn = this.conn
    this.conn = undefined
    if (conn === undefined) return Promise.resolve()
    this.setState('offline')
    return conn.close(new WebRTPayError('closed', 'Relay connection is no longer needed'))
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private setState(state: RelayConnectionState, error?: WebRTPayError): void {
    if (this.state === state) return
    this.state = state
    const callback = this.onStateChange
    if (callback !== undefined) this.callback(() => callback(state, error))
  }

  /**
   * Run an app callback. A faulty one must not break signaling: what it throws would
   * otherwise leave the handshake (or a `turn` request) unfinished and escape into the
   * socket's event handler, an uncaught exception in Node. It goes to `onCallbackError`.
   */
  private callback(run: () => void): void {
    try {
      run()
    } catch (e) {
      try {
        this.onCallbackError?.(e)
      } catch {
        // an error hook that throws changes nothing
      }
    }
  }
}

interface ConnectionHooks {
  url: string
  WS: typeof WebSocket
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  originator: string | undefined
  onSignal(from: PubKeyHex, e: SignalEnvelope): void
  onIce(list: IceList): void
  /** Called once when the handshake has completed. */
  onOpen(): void
  /**
   * Called once when the connection ends, with the time (Unix milliseconds) its
   * handshake completed, or undefined when it never did, and the error that ended it.
   */
  onEnd(openedAt: number | undefined, err: WebRTPayError): void
}

/**
 * A frame awaiting its reply. The relay answers frames in order, so a reply of the
 * wrong kind for the head of the queue, or one with nothing queued, ends the
 * connection rather than being matched to a later frame.
 */
interface Pending {
  /** The reply that completes it; `error` rejects either kind. */
  expects: 'sent' | 'ice'
  resolve(list: IceList | undefined): void
  reject(err: WebRTPayError): void
}

/** One WebSocket to the relay: challenge, auth, ready, ice, then signals. */
class RelayConnection {
  readonly ready: Promise<void>
  private settle!: (err?: WebRTPayError) => void
  private ws: WebSocket | undefined
  private stage: 'challenge' | 'signing' | 'auth' | 'ice' | 'open' | 'ended' = 'challenge'
  private identityKey: PubKeyHex | undefined
  private openedAt: number | undefined
  private readonly pending: Pending[] = []
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly socketClosed: Promise<void>
  private markSocketClosed!: () => void

  constructor(private readonly h: ConnectionHooks) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = err => (err === undefined ? resolve() : reject(err))
    })
    this.socketClosed = new Promise<void>(resolve => {
      this.markSocketClosed = resolve
    })
  }

  /** Connect and start the handshake; called once, right after construction. */
  open(): void {
    // Rejections are delivered to whoever awaits `ready`; a reconnect may have no one.
    this.ready.catch(() => {})
    this.handshakeTimer = setTimeout(
      () => this.end(new WebRTPayError('peer_unreachable', 'Relay handshake timed out')),
      CONNECT_TIMEOUT_MS
    )
    let ws: WebSocket
    try {
      ws = new this.h.WS(this.h.url)
    } catch (cause) {
      this.markSocketClosed()
      this.end(new WebRTPayError('peer_unreachable', 'Could not open the relay socket', { cause }))
      return
    }
    this.ws = ws
    ws.addEventListener('message', ev => this.onMessage(ev.data))
    ws.addEventListener('close', () => {
      this.markSocketClosed()
      this.end(
        new WebRTPayError(
          'peer_unreachable',
          this.stage === 'open' ? 'Relay connection closed' : 'Could not connect to the relay'
        )
      )
    })
    // A failed socket always fires close next; that is where it is handled.
    ws.addEventListener('error', () => {})
  }

  /** Send a signal frame and wait for the relay's reply to it. */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    const envelope = { v: e.v, sid: e.sid, ciphertext: e.ciphertext }
    await this.request({ t: 'signal', to, envelope }, 'sent')
  }

  /** Ask for TURN credentials and wait for the relay's `ice` reply. */
  async requestTurn(): Promise<IceList> {
    return (await this.request({ t: 'turn' }, 'ice')) ?? { servers: [], expiresAt: undefined }
  }

  /**
   * Write `frame` and wait for its reply. A relay that does not answer in time is
   * dropped, so a late reply can never be matched to a later frame.
   */
  private request(
    frame: RelayClientFrame,
    expects: Pending['expects']
  ): Promise<IceList | undefined> {
    if (this.stage !== 'open') {
      return Promise.reject(new WebRTPayError('peer_unreachable', 'Relay connection closed'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.end(new WebRTPayError('peer_unreachable', 'Relay did not answer in time')),
        SEND_TIMEOUT_MS
      )
      this.pending.push({
        expects,
        resolve: list => {
          clearTimeout(timer)
          resolve(list)
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        }
      })
      this.write(frame)
    })
  }

  /** End with `err` and wait (briefly) for the socket's closing handshake. */
  close(err: WebRTPayError): Promise<void> {
    this.end(err)
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS)
      void this.socketClosed.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private onMessage(data: unknown): void {
    if (this.stage === 'ended' || typeof data !== 'string') return
    let f: unknown
    try {
      f = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(f)) return
    switch (f.t) {
      case 'challenge':
        if (this.stage === 'challenge') this.answer(f.nonce)
        return
      case 'ready':
        this.onReady(f)
        return
      case 'ice':
        this.onIce(f)
        return
      case 'signal':
        this.onSignal(f)
        return
      case 'sent':
        if (this.stage === 'open' && this.replyMatches('sent')) {
          this.pending.shift()?.resolve(undefined)
        }
        return
      case 'error':
        this.onError(f)
        return
    }
  }

  private onReady(f: Record<string, unknown>): void {
    if (this.stage !== 'auth') return
    if (f.identityKey !== this.identityKey) {
      this.end(new WebRTPayError('protocol', 'Relay confirmed a different identity'))
      return
    }
    this.stage = 'ice'
  }

  /** The `ice` that completes the handshake, or that answers a `turn` request after it. */
  private onIce(f: Record<string, unknown>): void {
    if (this.stage !== 'ice' && this.stage !== 'open') return
    // after the handshake an `ice` only ever answers a `turn` request
    if (this.stage === 'open' && !this.replyMatches('ice')) return
    const list = iceListOf(f)
    if (list === undefined) {
      // fails the handshake or the turn request it answers
      const err = new WebRTPayError('protocol', 'Relay sent bad ICE servers')
      if (this.stage === 'ice') this.end(err)
      else this.pending.shift()?.reject(err)
      return
    }
    this.h.onIce(list)
    if (this.stage === 'open') {
      this.pending.shift()?.resolve(list)
      return
    }
    this.stage = 'open'
    this.openedAt = Date.now()
    clearTimeout(this.handshakeTimer)
    this.h.onOpen()
    this.settle()
  }

  private onSignal(f: Record<string, unknown>): void {
    if (this.stage === 'open' && typeof f.from === 'string' && isSignalEnvelope(f.envelope)) {
      this.h.onSignal(f.from, f.envelope)
    }
  }

  /** An `error` fails the handshake, or the oldest frame waiting for a reply. */
  private onError(f: Record<string, unknown>): void {
    const err = relayError(f.code)
    if (this.stage !== 'open') this.end(err)
    else if (this.replyMatches('error')) this.pending.shift()?.reject(err)
  }

  /**
   * Whether a reply of `kind` answers the oldest frame still waiting (an `error`
   * answers either kind). Otherwise the relay and this client disagree on which frame
   * a reply belongs to, so the connection ends with `protocol`.
   */
  private replyMatches(kind: 'sent' | 'ice' | 'error'): boolean {
    const head = this.pending[0]
    if (head !== undefined && (kind === 'error' || head.expects === kind)) return true
    this.end(new WebRTPayError('protocol', `Relay sent a '${kind}' reply out of order`))
    return false
  }

  private answer(nonce: unknown): void {
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE_CHARS) {
      this.end(new WebRTPayError('protocol', 'Relay sent a malformed challenge'))
      return
    }
    this.stage = 'signing'
    this.sign(nonce).then(
      frame => {
        if (this.stage !== 'signing') return
        this.stage = 'auth'
        this.write(frame)
      },
      cause =>
        this.end(new WebRTPayError('auth_failed', 'Could not sign the relay challenge', { cause }))
    )
  }

  private async sign(nonce: string): Promise<RelayClientFrame> {
    const { wallet, originator } = this.h
    const { publicKey } = await wallet.getPublicKey({ identityKey: true }, originator)
    const { signature } = await wallet.createSignature(
      {
        data: relayAuthData(this.h.url, nonce),
        protocolID: RELAY_PROTOCOL_ID,
        keyID: nonce,
        counterparty: 'anyone'
      },
      originator
    )
    this.identityKey = publicKey
    return { t: 'auth', identityKey: publicKey, signature: toHex(Uint8Array.from(signature)) }
  }

  private write(frame: RelayClientFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch (cause) {
      this.end(new WebRTPayError('peer_unreachable', 'Could not write to the relay', { cause }))
    }
  }

  private end(err: WebRTPayError): void {
    if (this.stage === 'ended') return
    this.stage = 'ended'
    clearTimeout(this.handshakeTimer)
    this.settle(err)
    for (const p of this.pending.splice(0)) p.reject(err)
    if (this.ws !== undefined && this.ws.readyState !== CLOSED) {
      try {
        this.ws.close(1000)
      } catch {
        // already closing
      }
    }
    this.h.onEnd(this.openedAt, err)
  }
}

function relayError(code: unknown): WebRTPayError {
  if (typeof code === 'string' && Object.hasOwn(RELAY_ERRORS, code)) {
    const [mapped, message] = RELAY_ERRORS[code as RelayErrorCode]
    return new WebRTPayError(mapped, message)
  }
  return new WebRTPayError('protocol', 'Relay sent an unknown error')
}

/** The ICE servers and expiry an `ice` frame carries, or undefined when either is malformed. */
function iceListOf(f: Record<string, unknown>): IceList | undefined {
  const servers = iceServersOf(f.iceServers)
  const { expiresAt } = f
  if (servers === undefined || (expiresAt !== undefined && !isTime(expiresAt))) return undefined
  return { servers, expiresAt }
}

/** A sanitized copy of the relay's ICE server list, or undefined when it is malformed. */
function iceServersOf(x: unknown): RTCIceServer[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out: RTCIceServer[] = []
  for (const s of x as unknown[]) {
    if (!isRecord(s)) return undefined
    const { urls, username, credential } = s
    const urlsOk =
      typeof urls === 'string' || (Array.isArray(urls) && urls.every(u => typeof u === 'string'))
    if (
      !urlsOk ||
      (username !== undefined && typeof username !== 'string') ||
      (credential !== undefined && typeof credential !== 'string')
    ) {
      return undefined
    }
    const server: RTCIceServer = { urls: typeof urls === 'string' ? urls : [...(urls as string[])] }
    if (username !== undefined) server.username = username as string
    if (credential !== undefined) server.credential = credential as string
    out.push(server)
  }
  return out
}

/** A copy of `list`'s servers without TURN servers whose credentials expire within 30 s of `now`. */
function liveIceServers(list: IceList, now: number): RTCIceServer[] {
  return copyIceServers(list.servers.filter(s => !turnExpiring(s, list.expiresAt, now)))
}

/**
 * True for a TURN server whose credentials expire within 30 s of `now`, or have expired;
 * the TURN server refuses them from then on. Their expiry is `expiresAt`, from the relay,
 * or else the one a coturn REST username starts with. Credentials with neither (a relay
 * that sends no `expiresAt`, with usernames of another form) never count as expiring.
 */
function turnExpiring(server: RTCIceServer, expiresAt: number | undefined, now: number): boolean {
  if (!isTurnServer(server)) return false
  const expiry = expiresAt ?? restUsernameExpiry(server.username)
  return expiry !== undefined && now + TURN_EXPIRY_MARGIN_MS >= expiry
}

/** The expiry a coturn REST username (`<unix seconds>:<user>`) names, in Unix milliseconds. */
function restUsernameExpiry(username: string | undefined): number | undefined {
  const expiry = TURN_REST_USERNAME_RE.exec(username ?? '')
  return expiry === null ? undefined : Number(expiry[1]) * 1000
}

/** A time the relay may send: whole Unix milliseconds after the epoch. */
function isTime(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x > 0
}

function isTurnServer(server: RTCIceServer): boolean {
  const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
  return urls.some(u => /^turns?:/i.test(u))
}

function copyIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.map(s => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }))
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function closedError(): WebRTPayError {
  return new WebRTPayError('closed', 'Relay signaler is closed')
}
