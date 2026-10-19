import { PeerLink } from '../channel/PeerLink.js'
import type { PeerLinkOptions, RtcOptions } from '../channel/PeerLink.js'
import { decodeCode, encodeAnswerCode, encodeOfferCode } from '../codec/codes.js'
import type { OfferCode } from '../codec/codes.js'
import { paymentKey } from '../payments/accept.js'
import { normalizePaymentRequest, verifyPaymentRequestProof } from '../payments/requests.js'
import {
  MAX_DIRECT_TRANSACTION_BYTES,
  decodePayment,
  encodePayment,
  validatePaymentToken
} from '../payments/wire.js'
import type {
  ErrorWire,
  PaymentAck,
  PaymentWire,
  RequestWire,
  WireMessage
} from '../payments/wire.js'
import type { AuthenticatedPeer } from '../session/AuthenticatedPeer.js'
import { PRE_AUTH_MAX_MESSAGE_BYTES, authenticate } from '../session/handshake.js'
import { ReplayCache, isSignalChain, openSignal, sealSignal } from '../signaling/envelope.js'
import type { SignalEnvelope, SignalKind, SignalPlaintext, Signaler } from '../signaling/types.js'
import { DEFAULTS, isIdentityKey } from '../types.js'
import type {
  IncomingPayment,
  IncomingPaymentRequest,
  PaymentRequestMessage,
  PaymentTokenInput,
  PubKeyHex,
  WalletLike
} from '../types.js'
import { equalBytes, randomBytes, toBase64Url } from '../util/bytes.js'
import { compareCodeUnits } from '../util/compare.js'
import { WebRTPayError } from '../util/errors.js'
import { KeyedBuckets, TokenBucket } from './budget.js'
import { DialClock, DialSettler, ReplyQueue } from './dial.js'
import type { DialTimeouts } from './dial.js'
import { DEFAULT_INBOUND_LIMITS, InboundLimiter } from './limits.js'
import type { InboundLimits } from './limits.js'

/** What the app decides about one received payment; it becomes the `payment.ack` status. */
export type PaymentDecision = 'accepted' | 'received' | { status: 'rejected'; reason: string }

/** How a receiving client hands sessions, payments and requests to the app. */
export interface ReceiveHandlers {
  /**
   * Take custody of a payment from an authenticated peer (usually with
   * `acceptDirectPayment`). `p.sender` is the peer's proven identity key and `p.messageId`
   * the payment id. Resolve `accepted` once it is in the wallet, `received` when it is kept
   * for a local retry, or `rejected` with a reason for the payer. A handler that throws
   * makes the ack `rejected`: with the message of a `WebRTPayError` (such as
   * `invalid_payment`), with a generic reason otherwise.
   */
  onPayment(p: IncomingPayment, ctx: { note?: string; txid: string }): Promise<PaymentDecision>
  /**
   * A payment request from the peer, already bound to its identity, with whether its proof
   * verifies for this wallet. `messageId` is generated locally. Cancellations are not passed
   * on, nor is anything when this handler is absent.
   */
  onPaymentRequest?(r: IncomingPaymentRequest & { proofValid: boolean }): Promise<void>
  /**
   * Failures of inbound sessions and handlers; never thrown back into the client. Signals
   * that cannot be opened (`invalid_signal`: a wallet that will not decrypt, a clock more
   * than 120 s off, junk) are reported too, at most one every 10 s.
   */
  onError?(e: unknown): void
  /** A peer finished the identity handshake and its session is being served. */
  onSession?(peerIdentityKey: PubKeyHex): void
}

export interface DirectPayClientOptions {
  wallet: WalletLike
  /** Passed to every wallet call. */
  originator?: string
  /** Carries offers and answers for {@link DirectPayClient.connect} and receiving. */
  signaler?: Signaler
  /** How links build their `RTCPeerConnection` (STUN/TURN servers, implementation). */
  rtc?: RtcOptions
  /**
   * Extra STUN/TURN servers, asked for before every ICE gather: dialing, answering an
   * offer, creating an offer code and answering one. Suits short-lived TURN credentials:
   * with a relay, pass `RelaySignaler.turnProvider()`, which reuses them. They are used
   * together with `rtc.iceServers`; where both list the same urls, the provider's entry
   * wins. A provider that throws, rejects, resolves to something other than an array or
   * has not resolved after 5 s is passed over (see `onIceServersProviderError`), as are
   * entries that are not ICE servers: the gather goes ahead with `rtc.iceServers` alone.
   */
  iceServersProvider?: () => Promise<RTCIceServer[]>
  /**
   * Called when `iceServersProvider` is passed over, with why: what it threw or rejected
   * with, a `TypeError` when it resolved to something other than an array, or a `timeout`
   * `WebRTPayError` when it had not answered after 5 s. The gather has gone ahead without
   * its servers; anything this throws is ignored.
   */
  onIceServersProviderError?: (e: unknown) => void
  /**
   * The network this wallet is on, such as `'main'` or `'test'`: 1 to 16 characters from
   * `a-z` and `0-9`. Offer codes carry it, and answered offer codes must name it unless
   * `expectedChain` says otherwise. Dials are bound to it too: offers and answers name it, an
   * inbound offer that names another network or none is refused with a sealed `reject`
   * (`wrong_network`, no ICE gathered), and {@link DirectPayClient.connect} refuses an answer
   * that names another network or none before applying it. Without it, signals name no
   * network and nothing is checked (peers that set one refuse this client). The constructor
   * throws `TypeError` for anything else, on a client that only exchanges codes too.
   */
  chain?: string
  /** Inbound limits; unset fields keep {@link DEFAULT_INBOUND_LIMITS}. */
  limits?: Partial<InboundLimits>
  /**
   * `connectMs`: an inbound session's connect plus handshake, and the cap on a whole dial
   * (30 s); `presenceMs`: a dial's wait for the recipient's first reply (2 s); `dialMs`: a
   * dial's time from that reply to an authenticated session (6 s); `ackMs`: wait for a
   * payment's ack (45 s).
   */
  timeouts?: { connectMs?: number; ackMs?: number; presenceMs?: number; dialMs?: number }
  /** Largest message accepted from a peer this client pays; defaults to 32 MiB. */
  maxMessageBytes?: number
}

/** Options for {@link DirectPayClient.createOfferCode}. */
export interface OfferCodeOptions {
  /** Network named in the code; defaults to the client's `chain`, one of them is required. */
  chain?: string
  /** Requested amount in satoshis. */
  amount?: number
  /** The code stops being valid this long from now; no expiry when absent. */
  expiresInMs?: number
  /** Serve the session with these instead of the active receive handlers. */
  handlers?: ReceiveHandlers
}

/** A payee's offer code waiting for the payer's answer code. */
export interface OfferHandle {
  /** The `webrtpay1:` offer code to show. */
  code: string
  /** The session id, base64url. */
  sid: string
  /**
   * Apply the payer's answer code, authenticate the payer and serve the session with the
   * receive handlers. Answer codes do not name the payer: whoever answered proves its key
   * in the handshake, and the returned session's `peerIdentityKey` is that key. A code that
   * is not an answer to this offer rejects `invalid_code` and leaves the offer usable; once
   * the offer has expired it rejects `invalid_code`; without handlers it rejects
   * `unsupported`.
   */
  complete(answerCode: string): Promise<AuthenticatedPeer>
  /** Close the offer's link; a pending `complete` rejects `closed`. */
  cancel(): void
}

/** A payer's answer to an offer code. */
export interface AnswerHandle {
  /** The decoded offer: payee identity, network, amount. */
  offer: OfferCode
  /** The `webrtpay1:` answer code to show the payee. */
  answerCode: string
  /**
   * Resolves once the payee applied the answer and proved the identity in the offer. Its
   * clock started when `answerOfferCode` was called: ICE checks toward the payee run from
   * then, a Chromium answerer gives up after about 15 s without the payee, and `connected`
   * rejects after `connectMs` (30 s) at the latest. Show the answer code at once.
   */
  connected: Promise<AuthenticatedPeer>
  /** Close the link; `connected` rejects `closed`. */
  cancel(): void
}

/**
 * Signals opened (decrypted) per second from everyone, at most, with bursts of up to 40.
 * Bounds the wallet work junk can cause, and the replay cache: a sid is kept at most 300 s,
 * so 20/s keeps it within its 10000 entries.
 */
const INTAKE_PER_SECOND = 20
const INTAKE_BURST = 40
/** Signals opened per minute from one sender, at most, with bursts of up to 10. */
const SENDER_INTAKE_PER_MINUTE = 10
const SENDER_INTAKE_BURST = 10
/** Each refusal costs an encryption and a send: at most one per second is answered. */
const REJECTS_PER_SECOND = 1
/**
 * Rings answered per second, at most, with bursts as large: a budget of their own, so a
 * refusal now and then cannot silence back-to-back dials.
 */
const RINGS_PER_SECOND = 20
/** Longest wait for a payment an old session is still acknowledging before superseding it. */
const SUPERSEDE_WAIT_MS = 1000
/** Limiter check that lets a sender's new offer replace its own open session. */
const SUPERSEDING = { superseding: true } as const
/** Signals that could not be opened are reported to `onError` at most this often. */
const UNOPENED_REPORT_MS = 10000
/** Longest reject reason from a peer passed on in an error message. */
const MAX_REJECT_REASON_CHARS = 200
/** Longest reason a `payment.ack` may carry. */
const MAX_ACK_REASON_CHARS = 500
/** Most messages from one inbound peer waiting to be handled before the session is closed. */
const MAX_PENDING_MESSAGES = 8
/** Longest wait for `iceServersProvider` before gathering without its servers. */
const ICE_SERVERS_PROVIDER_MS = 5000
/** Ack reason when the handler failed in a way the payer should not see the details of. */
const NOT_PROCESSED = 'The payee could not process the payment'
const MAX_TIMER_MS = 2 ** 31 - 1
const SID_BYTES = 16

/** Options for {@link DirectPayClient.connect}. */
export interface DialOptions {
  /**
   * Cap on the whole dial; defaults to the client's `connectMs` (30 s). Running out before
   * the recipient replied is `peer_unreachable`, after it `timeout`.
   */
  timeoutMs?: number
  /**
   * Wait for the recipient's first reply, from the carrier taking the knock; defaults to the
   * client's `presenceMs` (2 s).
   */
  presenceTimeoutMs?: number
  /**
   * Time from the recipient's first reply to an open, authenticated session; defaults to the
   * client's `dialMs` (6 s).
   */
  dialTimeoutMs?: number
  /** Cancels this dial (it rejects `closed`, `Dial cancelled`); nothing else is touched. */
  signal?: AbortSignal
}

/** One dial in progress, as {@link DirectPayClient.connect} runs it. */
interface DialRun {
  sid: string
  recipient: PubKeyHex
  signaler: Signaler
  timeouts: DialTimeouts
  replies: ReplyQueue
  /** Why the dial ended, once it has. */
  failure: WebRTPayError | undefined
  /** The dial's link, once gathered. */
  link: PeerLink | undefined
  /** End the dial now with `e` (does nothing once it has ended). */
  fail(e: WebRTPayError): void
  /** The carrier took the knock: presence starts. */
  posted(): void
}

/** An admitted inbound offer's session, as a later offer from the same sender sees it. */
interface InboundSession {
  /** Its link, once created. */
  link: PeerLink | undefined
  /** Payments it is handling whose ack has not been sent yet. */
  paying: number
  /** Settles once the session has ended and its slot is back. */
  ended: Promise<void>
  /** True once its slot is back (it ended, or was superseded). */
  released: boolean
  /** Give its slot back (once). */
  release(): void
}

/** One dial waiting for replies, keyed by sid. */
interface Dial {
  recipient: PubKeyHex
  /** The peer's ring, answer or reject arrived. */
  reply(p: SignalPlaintext): void
  /** End the dial now (budget spent, client closed). */
  fail(e: WebRTPayError): void
}

/**
 * Direct wallet-to-wallet payments over WebRTC.
 *
 * Payer: {@link connect} dials a payee by identity key through the signaler (or
 * {@link answerOfferCode} answers a payee's offer code), then {@link sendPayment} delivers
 * a `PaymentToken` and returns the payee's ack. Connect before creating the transaction:
 * if the payee cannot be reached nothing has been spent. A payee that answered a dial
 * closes the session unless the payment (or any message) arrives within its
 * first-message timeout, 60 s by default, of the connection: prepare the transaction
 * promptly after `connect` (or connect only once the user has confirmed), check
 * `peer.isOpen` before broadcasting and send right after.
 *
 * Payee: {@link startReceiving} answers offers that arrive through the signaler, within
 * the inbound limits, and serves each authenticated session with the handlers;
 * {@link createOfferCode} serves one session set up by exchanging codes, no signaler
 * needed.
 *
 * The signaler is subscribed only while receiving or while a dial waits for its answer,
 * so a client that does not receive is unreachable between payments. Before a signal is
 * decrypted it is budgeted on the sender the carrier reports (10 a minute per sender, 20 a
 * second overall); replies to a dial in progress are always opened. Every link starts
 * with a 64 KiB message cap that rises once the peer has authenticated.
 */
export class DirectPayClient {
  private readonly wallet: WalletLike
  private readonly originator: string | undefined
  private readonly signaler: Signaler | undefined
  private readonly chain: string | undefined
  private rtc: RtcOptions
  private readonly iceServersProvider: (() => Promise<RTCIceServer[]>) | undefined
  private readonly onIceServersProviderError: ((e: unknown) => void) | undefined
  private readonly limits: InboundLimits
  private readonly limiter: InboundLimiter
  private readonly connectMs: number
  private readonly presenceMs: number
  private readonly dialMs: number
  private readonly ackMs: number
  private readonly maxMessageBytes: number
  private readonly replay = new ReplayCache()
  private readonly intake = new TokenBucket(INTAKE_BURST, 1000 / INTAKE_PER_SECOND)
  private readonly senderIntake = new KeyedBuckets(
    SENDER_INTAKE_BURST,
    60000 / SENDER_INTAKE_PER_MINUTE
  )
  private readonly rejects = new TokenBucket(1, 1000 / REJECTS_PER_SECOND)
  private readonly rings = new TokenBucket(RINGS_PER_SECOND, 1000 / RINGS_PER_SECOND)
  private readonly unopenedReports = new TokenBucket(1, UNOPENED_REPORT_MS)
  /** Payment decisions in progress by `paymentKey`, so concurrent deliveries share one. */
  private readonly deciding = new Map<string, Promise<PaymentDecision>>()
  private readonly dials = new Map<string, Dial>()
  private readonly links = new Set<PeerLink>()
  /** Inbound sessions holding a slot, by the sender the carrier vouched for. */
  private readonly inbound = new Map<PubKeyHex, InboundSession>()
  private identity: Promise<PubKeyHex> | undefined
  private handlers: ReceiveHandlers | undefined
  private dialCount = 0
  private unlisten: (() => Promise<void>) | undefined
  /** Tail of the subscribe/unsubscribe queue; never rejects. */
  private listenOps: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined

  /**
   * @throws `RangeError` for an invalid limit, timeout or message cap; `TypeError` for a
   * `chain` that is not 1 to 16 characters from `a-z` and `0-9`.
   */
  constructor(o: DirectPayClientOptions) {
    if (o.chain !== undefined && !isSignalChain(o.chain)) {
      throw new TypeError('chain must be 1 to 16 characters from a-z and 0-9')
    }
    this.wallet = o.wallet
    this.originator = o.originator
    this.signaler = o.signaler
    this.chain = o.chain
    this.rtc = { ...o.rtc }
    this.iceServersProvider = o.iceServersProvider
    this.onIceServersProviderError = o.onIceServersProviderError
    this.limits = { ...DEFAULT_INBOUND_LIMITS, ...definedFields(o.limits) }
    this.limiter = new InboundLimiter(this.limits)
    this.connectMs = timerMs(o.timeouts?.connectMs, DEFAULTS.connectTimeoutMs, 'connectMs')
    this.presenceMs = timerMs(o.timeouts?.presenceMs, DEFAULTS.presenceTimeoutMs, 'presenceMs')
    this.dialMs = timerMs(o.timeouts?.dialMs, DEFAULTS.dialTimeoutMs, 'dialMs')
    this.ackMs = timerMs(o.timeouts?.ackMs, DEFAULTS.ackTimeoutMs, 'ackMs')
    this.maxMessageBytes = o.maxMessageBytes ?? DEFAULTS.maxMessageBytes
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) {
      throw new RangeError('maxMessageBytes must be a positive integer')
    }
  }

  /** True between {@link startReceiving} and {@link stopReceiving} (or {@link close}). */
  get receiving(): boolean {
    return this.handlers !== undefined
  }

  /** This wallet's identity key (asked once, then remembered). */
  getIdentityKey(): Promise<PubKeyHex> {
    if (this.identity === undefined) {
      const asked = this.wallet
        .getPublicKey({ identityKey: true }, this.originator)
        .then(r => r.publicKey)
      this.identity = asked
      asked.catch(() => {
        if (this.identity === asked) this.identity = undefined
      })
    }
    return this.identity
  }

  /**
   * Answer offers from peers through the signaler, within the inbound limits, and serve
   * each session with `h`. Calling it again replaces the handlers for new sessions.
   *
   * Offers beyond the limits get no ICE gathering (no address disclosed). A sender has one
   * session at a time: its new offer supersedes its open session (closed after up to 1 s if it
   * is still acknowledging a payment). One from a sender that has used its offers for the
   * minute gets no reply; with the client's `chain` set, one that names another network or none gets a
   * sealed `reject` (`wrong_network`); one refused because the payee is busy gets a sealed
   * `reject` (`busy`). Refusals are answered at most once a second and the rest go
   * unanswered. A session must open and authenticate within `connectMs` of its answer being
   * sent, send its first message within `firstMessageTimeoutMs` (60 s by default: the payer
   * creates and broadcasts the transaction in that window), and ends after `maxSessionMs`
   * regardless.
   *
   * @throws `WebRTPayError('unsupported')` without a signaler; `closed` after
   * {@link close}; whatever the signaler's `listen` throws (receiving is then off).
   */
  async startReceiving(h: ReceiveHandlers): Promise<void> {
    if (this.closing !== undefined) throw closedError()
    if (this.signaler === undefined) {
      throw new WebRTPayError('unsupported', 'Receiving by identity key needs a signaler')
    }
    if (typeof h?.onPayment !== 'function') throw new TypeError('onPayment must be a function')
    const previous = this.handlers
    this.handlers = h
    try {
      await this.syncListening()
    } catch (e) {
      if (this.handlers === h) this.handlers = previous
      throw e
    }
  }

  /**
   * Stop answering new offers; offers that still arrive while a dial is in progress are
   * refused with `not_receiving`. Sessions already open run until the peer says bye, closes
   * or goes idle.
   */
  async stopReceiving(): Promise<void> {
    this.handlers = undefined
    await this.syncListening()
  }

  /**
   * Dial `recipient` through the signaler and authenticate it. A sealed `knock` goes out
   * first, while the offer is gathered (for at most 1.5 s); a receiving peer replies `ring`
   * at once, and only then is the offer sent, its answer applied, the channel opened and the
   * handshake run pinned to `recipient`. A peer that is not there is known within
   * `presenceTimeoutMs` (2 s) of the carrier taking the knock; one that replied has
   * `dialTimeoutMs` (6 s) from its reply to finish. 0.1.0 peers do not answer knocks, so they
   * look offline.
   *
   * The payee then waits for the first message only for its `firstMessageTimeoutMs` (60 s
   * by default) before it closes the session: create the transaction right after this
   * resolves, check `peer.isOpen` before broadcasting it, and send it at once (see
   * {@link sendPayment}).
   *
   * With the client's `chain` set, the knock and offer name it and an answer must name the
   * same network: one that names another or none is refused before it is applied
   * (`rejected`, `wrong_network`), as the payee refuses a knock or offer from another
   * network.
   *
   * @throws `WebRTPayError`: `unsupported` without a signaler; whatever the signaler's
   * `send` rejects with when it cannot post the knock (`peer_unreachable` from the memory
   * hub or a relay, `unavailable` from MessageBox, `rate_limited` when the carrier refuses
   * for its limits); `peer_unreachable` when no reply arrives within `presenceTimeoutMs`
   * (default `presenceMs`, 2 s) or `timeoutMs`; `rejected` when the recipient refused, with
   * its reason (at most 200 characters; none when it gave none) on `error.reason` and in
   * the message: `busy`, `not_receiving`, or `wrong_network` when the recipient's wallet is
   * on another network than this client's `chain` (or one of the two names none); `timeout`
   * when the recipient replied but the channel and handshake did not finish within
   * `dialTimeoutMs` (default `dialMs`, 6 s) of its reply, or within `timeoutMs` (default
   * `connectMs`, 30 s) of the start; `auth_failed`, `closed` or `protocol` from the channel
   * and handshake; `closed` when `o.signal` aborts (`Dial cancelled`) or the client closes
   * first. `TypeError` for a recipient that is not an identity key, `RangeError` for an
   * invalid timeout.
   */
  connect(recipient: PubKeyHex, o: DialOptions = {}): Promise<AuthenticatedPeer> {
    if (this.closing !== undefined) return Promise.reject(closedError())
    const signaler = this.signaler
    if (signaler === undefined) {
      return Promise.reject(
        new WebRTPayError('unsupported', 'Dialing by identity key needs a signaler')
      )
    }
    if (!isIdentityKey(recipient)) {
      return Promise.reject(new TypeError('recipient must be an identity key'))
    }
    let timeouts: DialTimeouts
    try {
      timeouts = this.dialTimeouts(o)
    } catch (e) {
      return Promise.reject(e)
    }
    if (o.signal?.aborted === true) return Promise.reject(cancelledError())
    return this.startDial(
      {
        sid: newId(),
        recipient,
        signaler,
        timeouts,
        replies: new ReplyQueue(),
        failure: undefined,
        link: undefined,
        fail: noop,
        posted: noop
      },
      o.signal
    )
  }

  /** Run dial `d` under its clocks until it settles; `signal` cancels it. */
  private startDial(d: DialRun, signal: AbortSignal | undefined): Promise<AuthenticatedPeer> {
    return new Promise<AuthenticatedPeer>((resolve, reject) => {
      const settler = new DialSettler<AuthenticatedPeer>(resolve, reject, () => {
        clock.stop()
        signal?.removeEventListener('abort', onAbort)
        this.dials.delete(d.sid)
        this.endDial()
      })
      const fail = (e: WebRTPayError): void => {
        if (d.failure !== undefined) return
        d.failure = e
        d.replies.fail(e)
        d.link?.close(e)
        settler.reject(e)
      }
      const onAbort = (): void => fail(cancelledError())
      const clock = new DialClock(d.timeouts, fail)
      d.fail = fail
      d.posted = () => clock.posted()
      this.dials.set(d.sid, {
        recipient: d.recipient,
        reply: p => {
          clock.heard()
          d.replies.push(p)
        },
        fail
      })
      this.beginDial()
      clock.start()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.runDial(d).then(
        peer => {
          if (!settler.resolve(peer)) peer.close(d.failure)
        },
        (e: unknown) => {
          // A link still being gathered is closed when it arrives.
          d.failure ??= asError(e) ?? new WebRTPayError('closed', 'Dial failed')
          d.link?.close(asError(e))
          settler.reject(e)
        }
      )
    })
  }

  /**
   * Send `token` as a `payment` and wait for the matching `payment.ack`. Once the ack is
   * in, the session is ended (bye, then close); a `rejected` ack resolves like any other,
   * the caller decides. A failure after sending closes the session too.
   *
   * Before anything is sent, the token is checked with `validatePaymentToken` and against
   * `MAX_DIRECT_TRANSACTION_BYTES`, and the session must still be open; these failures leave
   * the session as it was. A payee that answered the dial closes the session when no message
   * comes within its first-message timeout (60 s by default) of `connect` resolving, so
   * prepare the payment promptly, check `peer.isOpen` before broadcasting, and send right
   * after.
   *
   * Keep the token until the ack is `accepted` or `received`. When this throws after the
   * transaction was broadcast, or the ack is `rejected` with a `txid`, the payee may hold an
   * output it cannot find without the derivation values: deliver the same token again
   * (directly or through MessageBox) rather than paying again; a payee acknowledges a
   * payment it already has without taking it twice.
   *
   * @throws `WebRTPayError`: `invalid_payment` for a token the payee would refuse;
   * `too_large` for a transaction over `MAX_DIRECT_TRANSACTION_BYTES`, or when the payee
   * answers that the message is over its cap; `closed` when the session has already closed
   * or closes before the ack (or the close reason); `timeout` after `timeoutMs` (default
   * `ackMs`, 45 s). `RangeError` for an invalid `timeoutMs`.
   */
  async sendPayment(
    peer: AuthenticatedPeer,
    token: PaymentTokenInput,
    o: { note?: string; timeoutMs?: number } = {}
  ): Promise<PaymentAck> {
    const timeoutMs = timerMs(o.timeoutMs, this.ackMs, 'timeoutMs')
    // Size first: a junk megabyte array should not be parsed to be refused.
    const transaction: unknown = (token as { transaction?: unknown } | null)?.transaction
    if (
      (Array.isArray(transaction) || transaction instanceof Uint8Array) &&
      transaction.length > MAX_DIRECT_TRANSACTION_BYTES
    ) {
      throw new WebRTPayError(
        'too_large',
        `The transaction is ${transaction.length} bytes; a direct payment carries at most ` +
          `${MAX_DIRECT_TRANSACTION_BYTES}`
      )
    }
    validatePaymentToken(token, o.note)
    if (!peer.isOpen) {
      throw new WebRTPayError('closed', 'The session has closed; connect again to send')
    }
    const id = newId()
    const wire = encodePayment(id, token, o.note)
    // An `error` from the payee ends the wait: it is about to close the session.
    const acked = peer.waitFor((m): m is PaymentAck => {
      if (m.t === 'error') throw peerReported(m)
      return m.t === 'payment.ack' && m.id === id
    }, timeoutMs)
    let ack: PaymentAck
    try {
      ;[, ack] = await Promise.all([peer.send(wire), acked])
    } catch (e) {
      peer.close(asError(e))
      throw e
    }
    // The payee keeps the session until it hears this, so the ack can never be cut short.
    await peer.send({ t: 'bye' }).catch(noop)
    peer.close()
    return ack
  }

  /**
   * Start a face-to-face session as the payee: gather an offer and wrap it in a
   * `webrtpay1:` offer code naming this identity, the network and the optional amount.
   * The handlers come from `o.handlers`, else the active receive handlers when
   * {@link OfferHandle.complete} runs. The session does not count against inbound limits.
   * With `expiresInMs`, the offer is good until the expiry written in the code (to the
   * second, rounded down): `complete` refuses it after that, and its link is closed then
   * unless a `complete` has started.
   *
   * @throws `TypeError` when neither `o.chain` nor the client's `chain` is set;
   * `RangeError` for an invalid amount or expiry; `WebRTPayError('too_large')` when the
   * SDP does not fit a code; `closed` after {@link close}.
   */
  async createOfferCode(o: OfferCodeOptions = {}): Promise<OfferHandle> {
    if (this.closing !== undefined) throw closedError()
    const chain = o.chain ?? this.chain
    if (typeof chain !== 'string') {
      throw new TypeError('An offer code names its network: pass chain here or to the client')
    }
    if (o.amount !== undefined && !(Number.isSafeInteger(o.amount) && o.amount >= 1)) {
      throw new RangeError('amount must be a positive safe integer number of satoshis')
    }
    const expiresAt =
      o.expiresInMs === undefined
        ? undefined
        : Date.now() + timerMs(o.expiresInMs, 0, 'expiresInMs')
    const me = await this.getIdentityKey()
    const sid = randomBytes(SID_BYTES)
    const { link, sdp } = await PeerLink.createOffer(await this.linkOptions())
    this.adopt(link)
    let code: string
    try {
      code = encodeOfferCode({ sid, identityKey: me, chain, amount: o.amount, expiresAt, sdp })
    } catch (e) {
      link.close()
      throw e
    }
    // The payer sees the expiry the code carries, in whole seconds; keep to the same moment.
    const expiry = expiresAt === undefined ? undefined : Math.floor(expiresAt / 1000) * 1000
    const expiryTimer =
      expiry === undefined
        ? undefined
        : setTimeout(
            () => link.close(new WebRTPayError('timeout', 'Offer code expired')),
            Math.max(0, expiry - Date.now())
          )
    link.onClose(() => clearTimeout(expiryTimer))

    let answered = false
    const complete = async (answerCode: string): Promise<AuthenticatedPeer> => {
      if (answered) throw new WebRTPayError('protocol', 'This offer was already answered')
      if (expiry !== undefined && Date.now() >= expiry) {
        throw new WebRTPayError('invalid_code', 'This offer code has expired')
      }
      const answer = decodeCode(answerCode)
      if (answer.kind !== 'answer') {
        throw new WebRTPayError('invalid_code', 'This is an offer code, not an answer code')
      }
      if (!equalBytes(answer.sid, sid)) {
        throw new WebRTPayError('invalid_code', 'This answer code is for another offer')
      }
      const handlers = o.handlers ?? this.handlers
      if (handlers === undefined) {
        throw new WebRTPayError('unsupported', 'No receive handlers to serve this session')
      }
      answered = true
      clearTimeout(expiryTimer)
      // Anyone may answer an offer shown in public; the handshake proves who did.
      const session = authenticate(link, {
        wallet: this.wallet,
        originator: this.originator,
        timeoutMs: this.connectMs,
        maxMessageBytes: this.limits.maxMessageBytes
      })
      session.catch(noop)
      try {
        await link.acceptAnswer(answer.sdp)
      } catch (e) {
        link.close(asError(e))
        throw e
      }
      const peer = await session
      this.serve(peer, handlers, noop)
      return peer
    }

    return {
      code,
      sid: toBase64Url(sid),
      complete,
      cancel: () => {
        clearTimeout(expiryTimer)
        link.close(new WebRTPayError('closed', 'Offer cancelled'))
      }
    }
  }

  /**
   * Answer a payee's offer code as the payer: decode it, gather the answer and wrap it in
   * an answer code to show the payee (it does not name this identity; the handshake proves
   * it). `connected` authenticates the payee against the identity in the offer.
   *
   * Gathering, the ICE checks toward the payee and the `connectMs` timer of `connected` all
   * start when this is called, and a Chromium answerer gives up after about 15 s if the
   * payee has not applied the answer. So let the user review the payee and amount first,
   * with `decodeCode(code, { expectedChain })`, and call this only once they have confirmed;
   * then show the answer code at once. Call `cancel()` if the payment is abandoned.
   *
   * @throws `WebRTPayError('invalid_code')` for a malformed or expired code, an answer
   * code, or an offer for another network than `expectedChain` (default: the client's
   * `chain`; no check when neither is set); `closed` after {@link close}.
   */
  async answerOfferCode(code: string, o: { expectedChain?: string } = {}): Promise<AnswerHandle> {
    if (this.closing !== undefined) throw closedError()
    const offer = decodeCode(code, { expectedChain: o.expectedChain ?? this.chain })
    if (offer.kind !== 'offer') {
      throw new WebRTPayError('invalid_code', 'This is an answer code, not an offer code')
    }
    const { link, sdp } = await PeerLink.acceptOffer(offer.sdp, await this.linkOptions())
    this.adopt(link)
    const connected = authenticate(link, {
      wallet: this.wallet,
      originator: this.originator,
      expectedPeer: offer.identityKey,
      timeoutMs: this.connectMs,
      maxMessageBytes: this.maxMessageBytes
    })
    connected.catch(noop)
    let answerCode: string
    try {
      answerCode = encodeAnswerCode({ sid: offer.sid, sdp })
    } catch (e) {
      link.close()
      throw e
    }
    return {
      offer,
      answerCode,
      connected,
      cancel: () => link.close(new WebRTPayError('closed', 'Answer cancelled'))
    }
  }

  /** Use these RTC options for links created from now on (new ICE servers, say). */
  updateRtc(rtc: RtcOptions): void {
    this.rtc = { ...rtc }
  }

  /**
   * Stop receiving, end pending dials with `closed`, close every link and session this
   * client opened and unsubscribe from the signaler (which stays open; it belongs to the
   * caller). Later calls to other methods reject `closed`.
   */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.handlers = undefined
      const reason = closedError()
      for (const dial of Array.from(this.dials.values())) dial.fail(reason)
      for (const link of Array.from(this.links)) link.close(reason)
      this.closing = this.syncListening().catch(noop)
    }
    return this.closing
  }

  // ------------------------------------------------------------ signaling

  /** Subscribe while receiving or dialing, unsubscribe otherwise; one change at a time. */
  private syncListening(): Promise<void> {
    const op = this.listenOps.then(() => this.applyListening())
    this.listenOps = op.catch(noop)
    return op
  }

  private async applyListening(): Promise<void> {
    const want = this.closing === undefined && (this.handlers !== undefined || this.dialCount > 0)
    if (want && this.unlisten === undefined && this.signaler !== undefined) {
      this.unlisten = await this.signaler.listen((from, e) => this.onSignal(from, e))
    } else if (!want && this.unlisten !== undefined) {
      const stop = this.unlisten
      this.unlisten = undefined
      await stop()
    }
  }

  private beginDial(): void {
    if (++this.dialCount === 1) this.hintActive(true)
  }

  private endDial(): void {
    if (--this.dialCount === 0) this.hintActive(false)
    this.syncListening().catch(noop)
  }

  private hintActive(active: boolean): void {
    try {
      this.signaler?.setActive?.(active)
    } catch {
      // only a polling hint
    }
  }

  /** The clocks of a dial: per-call options, else the client's, else the defaults. */
  private dialTimeouts(o: DialOptions): DialTimeouts {
    return {
      presenceMs: timerMs(o.presenceTimeoutMs, this.presenceMs, 'presenceTimeoutMs'),
      dialMs: timerMs(o.dialTimeoutMs, this.dialMs, 'dialTimeoutMs'),
      totalMs: timerMs(o.timeoutMs, this.connectMs, 'timeoutMs')
    }
  }

  /**
   * One dial: knock while the offer is gathered (for at most `dialGatherTimeoutMs`), send
   * the offer once the recipient rings, then apply its answer and authenticate it. A reject
   * or an answer that arrives instead of the ring is acted on at once.
   */
  private async runDial(d: DialRun): Promise<AuthenticatedPeer> {
    await this.syncListening()
    const me = await this.getIdentityKey()
    throwIfFailed(d)
    const prepared = this.prepareDialLink(d)
    // A link that cannot be made (no WebRTC, say) ends the dial at once, reply or not.
    prepared.catch((e: unknown) => {
      if (e instanceof WebRTPayError) d.fail(e)
    })
    const knock = await this.seal('knock', d.sid, me, d.recipient, { chain: this.chain })
    throwIfFailed(d)
    await d.signaler.send(d.recipient, knock)
    d.posted()
    let p = await d.replies.next()
    if (p.kind === 'ring') {
      const { sdp } = await prepared
      const offer = await this.seal('offer', d.sid, me, d.recipient, { sdp, chain: this.chain })
      throwIfFailed(d)
      await d.signaler.send(d.recipient, offer)
      p = await d.replies.next()
    }
    if (p.kind === 'reject') throw rejectedBy(p)
    if (p.sdp === undefined) throw new WebRTPayError('protocol', 'Answer carries no SDP')
    // Bound to a network: an answer from another one (or none) is never applied.
    if (this.chain !== undefined && p.chain !== this.chain) {
      throw wrongNetwork(this.chain, p.chain)
    }
    const { link } = await prepared
    // Listen on the link before the channel can open, so the peer's hello is not missed.
    const session = authenticate(link, {
      wallet: this.wallet,
      originator: this.originator,
      expectedPeer: d.recipient,
      timeoutMs: d.timeouts.dialMs,
      maxMessageBytes: this.maxMessageBytes
    })
    session.catch(noop)
    await link.acceptAnswer(p.sdp)
    return await session
  }

  /** The dial's offer and link; a link that arrives after the dial ended is closed. */
  private async prepareDialLink(d: DialRun): Promise<{ link: PeerLink; sdp: string }> {
    const options = await this.linkOptions(DEFAULTS.dialGatherTimeoutMs)
    // a dial that has already failed spends no TURN credentials
    throwIfFailed(d)
    const offered = await PeerLink.createOffer(options)
    this.adopt(offered.link)
    if (d.failure !== undefined) {
      offered.link.close(d.failure)
      throw d.failure
    }
    d.link = offered.link
    return offered
  }

  private onSignal(from: PubKeyHex, e: SignalEnvelope): void {
    if (this.closing !== undefined || !this.admitSignal(from, e)) return
    this.handleSignal(from, e).catch(error => this.report(this.handlers, error))
  }

  /**
   * Decide, before anything is decrypted, whether a signal gets opened at all, on what the
   * carrier asserts. A reply to a dial in progress from that dial's recipient always does.
   * Anything else is dropped unanswered when its sender is over its own inbound limits or
   * its own intake budget (checked first, so one sender cannot spend everyone's), or when
   * the overall intake budget is spent.
   */
  private admitSignal(from: PubKeyHex, e: SignalEnvelope): boolean {
    if (this.dials.get(e.sid)?.recipient === from) return true
    // A sender with a session open may supersede it, so only its offer rate silences it here.
    if (this.limiter.refusal(from, undefined, SUPERSEDING) === 'sender') return false
    // Spent overall: drop before keeping any per-sender state for it.
    if (!this.intake.has()) return false
    return this.senderIntake.take(from) && this.intake.take()
  }

  private async handleSignal(from: PubKeyHex, e: SignalEnvelope): Promise<void> {
    const me = await this.getIdentityKey()
    let p: SignalPlaintext
    try {
      p = await openSignal(this.wallet, from, e, {
        me,
        replay: this.replay,
        originator: this.originator,
        // A ring, answer or reject counts only for a dial in progress to its sender. Anything
        // else must not record its sid: a forged answer with a sid seen in the clear would
        // otherwise make the genuine answer look like a replay.
        wanted: s => isInbound(s.kind) || this.dials.get(s.sid)?.recipient === s.from
      })
    } catch (error) {
      // Undecryptable, stale, replayed, misaddressed or unwanted: dropped. A wallet that
      // cannot decrypt would otherwise drop every offer silently, so it is reported, but
      // rarely enough that junk cannot flood the app.
      if (this.unopenedReports.take()) this.report(this.handlers, error)
      return
    }
    if (this.closing !== undefined) return
    if (p.kind === 'offer') {
      await this.answerOffer(p, me)
      return
    }
    if (p.kind === 'knock') {
      await this.answerKnock(p, me)
      return
    }
    const dial = this.dials.get(p.sid)
    if (dial?.recipient === p.from) dial.reply(p)
  }

  /** Answer an inbound offer, or refuse it without gathering ICE (no address disclosed). */
  private async answerOffer(p: SignalPlaintext, me: PubKeyHex): Promise<void> {
    const handlers = this.handlers
    if (handlers === undefined) return this.refuse(p, me, 'not_receiving')
    if (p.sdp === undefined) return
    const entry = await this.admitOffer(p, me)
    if (entry === undefined) return
    // The slot is the sender the carrier vouched for; the handshake runs without a pin.
    const sender = p.from
    try {
      const accepted = await PeerLink.acceptOffer(
        p.sdp,
        await this.linkOptions(DEFAULTS.dialGatherTimeoutMs)
      )
      // Superseded while gathering: its slot is gone, so it must not answer or be served.
      if (entry.released) {
        accepted.link.close(supersededError())
        return
      }
      entry.link = accepted.link
      this.adopt(accepted.link)
      // The answer must go out within the connect budget; carriers like MessageBox can take
      // seconds, so open and handshake get a budget of their own once it has.
      const sent = withDeadline(
        this.seal('answer', p.sid, me, sender, { sdp: accepted.sdp, chain: this.chain }).then(
          envelope => this.signaler!.send(sender, envelope)
        ),
        this.connectMs,
        'The answer could not be sent in time'
      )
      sent.catch(noop)
      // Listen on the link before the answer goes out, so the peer's hello is not missed.
      const session = authenticate(accepted.link, {
        wallet: this.wallet,
        originator: this.originator,
        timeoutMs: this.connectMs,
        maxMessageBytes: this.limits.maxMessageBytes,
        startAfter: sent
      })
      session.catch(noop)
      const peer = await session
      if (entry.released) {
        peer.close(supersededError())
        return
      }
      this.serve(peer, handlers, entry.release, {
        firstMessageMs: this.limits.firstMessageTimeoutMs,
        lifetimeMs: this.limits.maxSessionMs,
        inbound: entry
      })
    } catch (e) {
      // A session closed because it was superseded is expected, not an error to report.
      const superseded = entry.released
      entry.link?.close(asError(e))
      entry.release()
      if (!superseded) this.report(handlers, e)
    }
  }

  /**
   * Admit an offer and take its session slot, or refuse it (a sealed reject, or nothing for
   * a sender over its own limits). An offer from a sender whose previous session is still
   * open supersedes that session: the old one is ended and its slot released first, after
   * waiting up to 1 s for a payment it is still acknowledging.
   */
  private async admitOffer(p: SignalPlaintext, me: PubKeyHex): Promise<InboundSession | undefined> {
    const sender = p.from
    const refusal = this.limiter.refusal(sender, undefined, SUPERSEDING)
    // A sender over its own limits gets no answer, so it cannot spend the reject budget.
    if (refusal === 'sender') return undefined
    // Bound to a network: an offer from another one (or none, fail closed) holds no slot.
    if (this.chain !== undefined && p.chain !== this.chain) {
      await this.refuse(p, me, 'wrong_network')
      return undefined
    }
    if (refusal !== 'busy') await this.supersede(sender)
    if (refusal === 'busy' || !this.limiter.tryAdmit(sender)) {
      await this.refuse(p, me, 'busy')
      return undefined
    }
    const entry = inboundSession(() => {
      this.limiter.release(sender)
      if (this.inbound.get(sender) === entry) this.inbound.delete(sender)
    })
    this.inbound.set(sender, entry)
    return entry
  }

  /**
   * End `sender`'s open inbound session, if any, for a new one from the same sender. One
   * still deciding a payment gets up to 1 s to ack it and hear the payer's bye.
   */
  private async supersede(sender: PubKeyHex): Promise<void> {
    const old = this.inbound.get(sender)
    if (old === undefined) return
    if (old.paying > 0) {
      await withDeadline(old.ended, SUPERSEDE_WAIT_MS, 'Payment still in progress').catch(noop)
    }
    // Ended meanwhile, or the payee filled up while waiting: leave the old session be (the
    // new offer is then refused busy rather than costing the old one).
    if (old.released || this.limiter.refusal(sender, undefined, SUPERSEDING) !== undefined) return
    // Released first, so an old offer still gathering sees it and stops.
    old.release()
    old.link?.close(supersededError())
  }

  /**
   * Answer a knock at once, before any ICE is gathered and without taking a session slot:
   * `ring` when an offer from this sender would be considered, else the sealed refusal the
   * offer would get (`not_receiving`, `wrong_network`, `busy`), or nothing for a sender over
   * its own limits. Rings have a budget of their own, 20 a second.
   */
  private async answerKnock(p: SignalPlaintext, me: PubKeyHex): Promise<void> {
    if (this.handlers === undefined) return this.refuse(p, me, 'not_receiving')
    // A sender's own open session does not stop it ringing: its offer will supersede it.
    const refusal = this.limiter.refusal(p.from, undefined, SUPERSEDING)
    if (refusal === 'sender') return
    if (this.chain !== undefined && p.chain !== this.chain) {
      return this.refuse(p, me, 'wrong_network')
    }
    if (refusal === 'busy') return this.refuse(p, me, 'busy')
    if (!this.rings.take()) return
    const envelope = await this.seal('ring', p.sid, me, p.from, { chain: this.chain })
    await this.signaler!.send(p.from, envelope)
  }

  /** Send a sealed reject, unless the reject budget is spent (then the sender hears nothing). */
  private async refuse(p: SignalPlaintext, me: PubKeyHex, reason: string): Promise<void> {
    if (!this.rejects.take()) return
    const envelope = await this.seal('reject', p.sid, me, p.from, { reason })
    await this.signaler!.send(p.from, envelope)
  }

  private seal(
    kind: SignalKind,
    sid: string,
    from: PubKeyHex,
    to: PubKeyHex,
    extra: { sdp?: string; reason?: string; chain?: string }
  ): Promise<SignalEnvelope> {
    const p: SignalPlaintext = { v: 1, kind, sid, from, to, ts: Date.now(), purpose: 'payment' }
    if (extra.sdp !== undefined) p.sdp = extra.sdp
    if (extra.reason !== undefined) p.reason = extra.reason
    if (extra.chain !== undefined) p.chain = extra.chain
    return sealSignal(this.wallet, p, this.originator)
  }

  // ------------------------------------------------------------ inbound sessions

  /**
   * Serve an authenticated inbound session: handle its messages one at a time, close it
   * after `idleTimeoutMs` without traffic or on `bye`/`error`, call `release` when it ends.
   * With `o.firstMessageMs` the first message must come that soon (or within the idle
   * timeout, if shorter); with `o.lifetimeMs` the session ends that long after it started.
   */
  private serve(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    release: () => void,
    o: { firstMessageMs?: number; lifetimeMs?: number; inbound?: InboundSession } = {}
  ): void {
    const idleMs = this.limits.idleTimeoutMs
    let ended = false
    let heard = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      clearTimeout(idle)
      if (ended) return
      idle =
        heard || o.firstMessageMs === undefined
          ? setTimeout(() => peer.close(new WebRTPayError('timeout', 'Session was idle')), idleMs)
          : setTimeout(
              () => peer.close(new WebRTPayError('timeout', 'Peer sent nothing after connecting')),
              Math.min(o.firstMessageMs, idleMs)
            )
    }
    const lifetime =
      o.lifetimeMs === undefined
        ? undefined
        : setTimeout(
            () => peer.close(new WebRTPayError('timeout', 'Session reached its time limit')),
            o.lifetimeMs
          )
    peer.onClose(() => {
      ended = true
      clearTimeout(idle)
      clearTimeout(lifetime)
      release()
    })
    touch()

    let pending = 0
    let queue = Promise.resolve()
    peer.onMessage(m => {
      if (ended) return
      heard = true
      touch()
      if (++pending > MAX_PENDING_MESSAGES) {
        peer.close(new WebRTPayError('rate_limited', 'Peer sent too many messages at once'))
        return
      }
      const handled = startPayment(o.inbound, m)
      queue = queue
        .then(() => this.handleMessage(peer, h, m))
        .catch(e => this.report(h, e))
        .then(() => {
          pending--
          handled()
          touch()
        })
    })
    try {
      h.onSession?.(peer.peerIdentityKey)
    } catch (e) {
      this.report(h, e)
    }
  }

  private async handleMessage(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    m: WireMessage
  ): Promise<void> {
    switch (m.t) {
      case 'payment':
        return this.receivePayment(peer, h, m)
      case 'request':
        return this.receiveRequest(peer, h, m)
      case 'bye':
        peer.close()
        return
      case 'error':
        peer.close(new WebRTPayError('closed', `Peer reported an error: ${m.code}`))
        return
      default:
        // acks and responses mean nothing to the payee (the session refuses handshake ones)
        return
    }
  }

  private async receivePayment(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    w: PaymentWire
  ): Promise<void> {
    let decoded: ReturnType<typeof decodePayment>
    try {
      decoded = decodePayment(w)
    } catch (e) {
      await peer.send(ackOf(w.id, undefined, { status: 'rejected', reason: messageOf(e) }))
      return
    }
    const payment: IncomingPayment = {
      messageId: decoded.id,
      sender: peer.peerIdentityKey,
      token: decoded.token
    }
    const ctx =
      decoded.note === undefined
        ? { txid: decoded.txid }
        : { note: decoded.note, txid: decoded.txid }
    // The same payment on two sessions at once (a payer retrying over a second connection)
    // is decided once; the later delivery gets the same answer.
    const { derivationPrefix, derivationSuffix } = decoded.token.customInstructions
    const key = paymentKey(
      decoded.txid,
      decoded.token.outputIndex ?? 0,
      derivationPrefix,
      derivationSuffix
    )
    let decision = this.deciding.get(key)
    if (decision === undefined) {
      const deciding = this.decide(h, payment, ctx)
      this.deciding.set(key, deciding)
      void deciding.then(() => this.deciding.delete(key))
      decision = deciding
    }
    await peer.send(ackOf(decoded.id, decoded.txid, await decision))
  }

  /** The handler's decision on a payment; a handler that throws rejects it. Never rejects. */
  private async decide(
    h: ReceiveHandlers,
    payment: IncomingPayment,
    ctx: { note?: string; txid: string }
  ): Promise<PaymentDecision> {
    try {
      return await h.onPayment(payment, ctx)
    } catch (e) {
      this.report(h, e)
      return { status: 'rejected', reason: messageOf(e) }
    }
  }

  private async receiveRequest(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    w: RequestWire
  ): Promise<void> {
    let request: PaymentRequestMessage
    try {
      request = normalizePaymentRequest(w.request, peer.peerIdentityKey)
    } catch (cause) {
      // An authenticated peer speaking for another identity is not to be trusted further.
      const error = new WebRTPayError('protocol', 'Payment request names another sender', {
        cause
      })
      await peer.send({ t: 'error', code: 'protocol', message: error.message }).catch(noop)
      peer.close(error)
      return
    }
    if (request.cancelled === true || h.onPaymentRequest === undefined) return
    const proofValid = await verifyPaymentRequestProof(
      this.wallet,
      request,
      peer.localIdentityKey,
      peer.peerIdentityKey,
      this.originator
    )
    await h.onPaymentRequest({
      messageId: newId(),
      sender: peer.peerIdentityKey,
      requestId: request.requestId,
      amount: request.amount,
      description: request.description,
      expiresAt: request.expiresAt,
      proofValid
    })
  }

  // ------------------------------------------------------------ helpers

  /**
   * Options for a new link: the RTC options with the provider's ICE servers merged in, the
   * gather capped at `gatherCapMs` when it is given (dials by identity key), and
   * messages capped at 64 KiB until the peer has authenticated. `authenticate`, which every
   * path runs before the peer can connect, applies the same cap first thing and raises it
   * when the peer's `auth` verifies; creating the link with it too leaves no moment between
   * the two when a link accepts more.
   */
  private async linkOptions(gatherCapMs?: number): Promise<PeerLinkOptions> {
    const provided = await this.providedIceServers()
    const rtc = this.rtc
    const iceServers =
      provided.length === 0 ? rtc.iceServers : mergeIceServers(rtc.iceServers ?? [], provided)
    const options: PeerLinkOptions = {
      ...rtc,
      iceServers,
      maxMessageBytes: PRE_AUTH_MAX_MESSAGE_BYTES
    }
    if (gatherCapMs !== undefined) {
      options.gatherTimeoutMs = Math.min(rtc.gatherTimeoutMs ?? gatherCapMs, gatherCapMs)
    }
    return options
  }

  /**
   * The ICE servers `iceServersProvider` offers now; none when it is absent or fails, in
   * which case the gather goes ahead with `rtc.iceServers` alone: a dial never fails for this.
   */
  private async providedIceServers(): Promise<RTCIceServer[]> {
    const provider = this.iceServersProvider
    if (provider === undefined) return []
    let servers: unknown
    try {
      servers = await withDeadline(
        Promise.resolve().then(provider),
        ICE_SERVERS_PROVIDER_MS,
        'The ICE servers provider did not answer in time'
      )
    } catch (e) {
      this.providerFailed(e)
      return []
    }
    if (Array.isArray(servers)) return servers.filter(isIceServer)
    this.providerFailed(new TypeError('The ICE servers provider did not resolve to an array'))
    return []
  }

  private providerFailed(e: unknown): void {
    try {
      this.onIceServersProviderError?.(e)
    } catch {
      // a hook that throws must not stop the gather
    }
  }

  /** Track a new link so {@link close} reaches it; a link made after close is closed. */
  private adopt(link: PeerLink): void {
    if (this.closing !== undefined) {
      const reason = closedError()
      link.close(reason)
      throw reason
    }
    this.links.add(link)
    link.onClose(() => this.links.delete(link))
  }

  private report(h: ReceiveHandlers | undefined, e: unknown): void {
    try {
      h?.onError?.(e)
    } catch {
      // an error hook that throws must not break the client
    }
  }
}

function noop(): void {}

/**
 * Count a payment message as in progress on `s` until the returned function is called (its
 * ack has been sent), so a new offer from the same peer waits briefly before superseding it.
 */
function startPayment(s: InboundSession | undefined, m: WireMessage): () => void {
  if (s === undefined || m.t !== 'payment') return noop
  s.paying++
  return () => {
    s.paying--
  }
}

/** Kinds a peer sends unprompted: a dial's knock and offer. */
function isInbound(kind: SignalKind): boolean {
  return kind === 'offer' || kind === 'knock'
}

function closedError(): WebRTPayError {
  return new WebRTPayError('closed', 'Client is closed')
}

function supersededError(): WebRTPayError {
  return new WebRTPayError('closed', 'Superseded by a new session from the same peer')
}

/** A new inbound session's state; `onRelease` runs once, on the first `release()`. */
function inboundSession(onRelease: () => void): InboundSession {
  let ended: () => void = noop
  const s: InboundSession = {
    link: undefined,
    paying: 0,
    ended: new Promise<void>(resolve => {
      ended = resolve
    }),
    released: false,
    release: () => {
      if (s.released) return
      s.released = true
      onRelease()
      ended()
    }
  }
  return s
}

function cancelledError(): WebRTPayError {
  return new WebRTPayError('closed', 'Dial cancelled')
}

/** Stop a dial's run once the dial has ended. */
function throwIfFailed(d: DialRun): void {
  if (d.failure !== undefined) throw d.failure
}

/** The dialer's error for a recipient's sealed reject; `reason` is only what the peer said. */
function rejectedBy(p: SignalPlaintext): WebRTPayError {
  const reason = p.reason === undefined ? undefined : truncate(p.reason, MAX_REJECT_REASON_CHARS)
  return new WebRTPayError(
    'rejected',
    `Recipient refused the connection: ${reason ?? 'no reason given'}`,
    { reason }
  )
}

/** The dialer's refusal of an answer that names another network than `ours`, or none. */
function wrongNetwork(ours: string, theirs: string | undefined): WebRTPayError {
  const where = theirs === undefined ? 'names no network' : `is on ${theirs}`
  return new WebRTPayError(
    'rejected',
    `The recipient's wallet ${where}, this one is on ${ours}: wrong_network`,
    { reason: 'wrong_network' }
  )
}

/** 16 random bytes, base64url: payment ids and signaling session ids (Ruling 18). */
function newId(): string {
  return toBase64Url(randomBytes(SID_BYTES))
}

/** `p`, or a `timeout` rejection with `message` if it has not settled within `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WebRTPayError('timeout', message)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/**
 * `base` then `extra`, one entry per set of urls: an entry replaces an earlier one with
 * the same urls (in any order), so `extra` wins over `base`.
 */
function mergeIceServers(base: RTCIceServer[], extra: RTCIceServer[]): RTCIceServer[] {
  const byUrls = new Map<string, RTCIceServer>()
  for (const server of [...base, ...extra]) {
    const urls = typeof server.urls === 'string' ? [server.urls] : [...server.urls]
    urls.sort(compareCodeUnits)
    const key = JSON.stringify(urls)
    byUrls.delete(key)
    byUrls.set(key, server)
  }
  return [...byUrls.values()]
}

/** True for an `RTCIceServer`: string urls (one or more), and string credentials if any. */
function isIceServer(x: unknown): x is RTCIceServer {
  if (typeof x !== 'object' || x === null) return false
  const { urls, username, credential } = x as Record<string, unknown>
  const urlsOk =
    typeof urls === 'string' ||
    (Array.isArray(urls) && urls.length > 0 && urls.every(u => typeof u === 'string'))
  return (
    urlsOk &&
    (username === undefined || typeof username === 'string') &&
    (credential === undefined || typeof credential === 'string')
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function asError(e: unknown): WebRTPayError | undefined {
  return e instanceof WebRTPayError ? e : undefined
}

/** What a payee's `error` message means to the payer waiting for its ack. */
function peerReported(m: ErrorWire): WebRTPayError {
  const detail = m.message === undefined ? m.code : `${m.code}: ${m.message}`
  return m.code === 'too_large'
    ? new WebRTPayError('too_large', `The payee refused the message as too large (${detail})`)
    : new WebRTPayError('closed', `The payee reported an error: ${detail}`)
}

/** A reason safe to show the peer: our own error messages only. */
function messageOf(e: unknown): string {
  return e instanceof WebRTPayError ? e.message : NOT_PROCESSED
}

function ackOf(id: string, txid: string | undefined, d: PaymentDecision): PaymentAck {
  const withTxid = txid === undefined ? {} : { txid }
  if (d === 'accepted' || d === 'received') return { t: 'payment.ack', id, status: d, ...withTxid }
  const reason =
    typeof d === 'object' && d !== null && d.status === 'rejected' && typeof d.reason === 'string'
      ? d.reason
      : NOT_PROCESSED
  return {
    t: 'payment.ack',
    id,
    status: 'rejected',
    ...withTxid,
    reason: truncate(reason, MAX_ACK_REASON_CHARS)
  }
}

/** `v`, or `fallback` when undefined; a positive number of ms `setTimeout` can wait for. */
function timerMs(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive number of milliseconds up to ${MAX_TIMER_MS}`)
  }
  return v
}

/** The fields of a partial object that are not `undefined`. */
function definedFields<T extends object>(o: Partial<T> | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (o === undefined) return out
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
