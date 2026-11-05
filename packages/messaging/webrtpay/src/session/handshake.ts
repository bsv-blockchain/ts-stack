import type { PeerLink } from '../channel/PeerLink.js'
import { parseWireMessage } from '../payments/wire.js'
import type { Auth, Hello, WireMessage } from '../payments/wire.js'
import { CHANNEL_PROTOCOL_ID, DEFAULTS } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { fromHex, randomBytes, toBase64, toHex, utf8Encode } from '../util/bytes.js'
import { compareCodeUnits } from '../util/compare.js'
import { WebRTPayError } from '../util/errors.js'
import { AuthenticatedPeer, MAX_BACKLOG } from './AuthenticatedPeer.js'

/** First line of every channel-binding transcript. */
const BINDING_LABEL = 'webrtpay/1 channel-binding'
/**
 * Largest message accepted from the peer until its `auth` verifies (spec §4, Ruling 16):
 * handshake messages are tiny, and an unauthenticated peer gets no more than this.
 * `authenticate` applies it first thing, and `DirectPayClient` creates its links with it, so
 * there is no moment when a link of the client accepts more. The one definition; the package
 * entry does not export it.
 */
export const PRE_AUTH_MAX_MESSAGE_BYTES = 65536
const NONCE_BYTES = 32
/**
 * Most peer messages waiting while a handshake step awaits the wallet or the link, until
 * this side sends `ready`: a compliant peer has sent no more than hello, auth and ready.
 */
const MAX_INBOX_BEFORE_READY = 3
/**
 * The same once this side has sent `ready`: the peer's ready, then the start of its
 * session, which the session keeps up to its own backlog limit.
 */
const MAX_INBOX_AFTER_READY = 1 + MAX_BACKLOG

/** What one side signs, or checks the other side signed, for a channel. */
export interface BindingTranscriptInput {
  /** DTLS fingerprints (`"<alg> <lowercase hex>"`) from the signer's own SDP. */
  signerFingerprints: string[]
  /** DTLS fingerprints from the verifier's own SDP. */
  verifierFingerprints: string[]
  signerNonce: string
  verifierNonce: string
  signerKey: PubKeyHex
  verifierKey: PubKeyHex
}

/**
 * The bytes an identity signs to bind itself to one data channel. Exactly:
 *
 * ```
 * UTF-8( label "\n" signerFps "\n" verifierFps "\n" signerNonce "\n" verifierNonce
 *        "\n" signerKey "\n" verifierKey )
 * ```
 *
 * - `label` is the literal `webrtpay/1 channel-binding`.
 * - `signerFps` / `verifierFps`: every `a=fingerprint:` line of that side's own SDP
 *   (session or media level, any algorithm), each written `<alg> <hex>` with the algorithm
 *   in lower case and the hex in lower case without colons (`sdpFingerprints`), the list
 *   sorted by UTF-16 code unit (`Array.prototype.sort`'s order without a comparator, never
 *   a locale's) and joined by `,` with no spaces.
 *   The signer's list comes from its local SDP, the verifier's from the remote SDP as the
 *   signer received it (and the other way round when checking).
 * - Nonces are the standard padded base64 from the two `hello` messages (32 bytes each);
 *   keys are compressed public keys in lower-case hex.
 * - No trailing newline. No field contains `\n` (SDP is split into lines first), and in a
 *   valid SDP no list entry contains `,` (an `<alg>` is an RFC 4566 token, the hex is hex),
 *   so the seven fields, and each list's entries, can be recovered from the bytes.
 *
 * `test/handshake.test.ts` has a test vector (SDP lines in, transcript hex out). Both sides
 * compute the same bytes for a given signer only when they see the same DTLS certificates,
 * so a relay that terminates DTLS on each side cannot pass one side's signature to the
 * other.
 */
export function bindingTranscript(a: BindingTranscriptInput): number[] {
  const text = [
    BINDING_LABEL,
    [...a.signerFingerprints].sort(compareCodeUnits).join(','),
    [...a.verifierFingerprints].sort(compareCodeUnits).join(','),
    a.signerNonce,
    a.verifierNonce,
    a.signerKey,
    a.verifierKey
  ].join('\n')
  return Array.from(utf8Encode(text))
}

/** Options for {@link authenticate}. */
export interface AuthenticateOptions {
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature' | 'verifySignature'>
  /** Passed to every wallet call. */
  originator?: string
  /** Fail unless the peer proves this identity key (lowercase hex). */
  expectedPeer?: PubKeyHex
  /**
   * Time for the whole handshake, waiting for the channel to open included, counted from
   * when `startAfter` settles if it is given; defaults to 15 s.
   */
  timeoutMs?: number
  /**
   * Largest message accepted from the peer once it has authenticated; defaults to 32 MiB.
   * Until then the link accepts at most 65536 bytes, whatever cap it was created with.
   */
  maxMessageBytes?: number
  /**
   * Start the handshake (and its `timeoutMs`) only once this settles, such as when the SDP
   * answer has been sent: the peer cannot connect before it has the answer, so time spent
   * delivering it should not count. Peer messages are still taken in meanwhile. A
   * rejection fails the handshake with that error and closes the link.
   */
  startAfter?: Promise<unknown>
}

/**
 * Prove this wallet's identity key to the peer on `link` and check the peer's, bound to
 * the DTLS certificates of this connection (spec §4).
 *
 * Each side sends `hello` (identity key, fresh 32-byte nonce), then on the peer's hello an
 * `auth` signing {@link bindingTranscript} with `protocolID [2, 'webrtpay channel']`,
 * `keyID` its own nonce and `counterparty` the peer's key. The link's message cap is set
 * to 65536 bytes first thing; once the peer's `auth` verifies, it rises to
 * `maxMessageBytes` and this side sends `ready`. The session is handed over when this
 * side's check passed and the peer's `ready` arrived.
 *
 * Call it as soon as the link exists (before `waitOpen`), so the peer's hello cannot
 * arrive while nobody is listening.
 *
 * @throws `WebRTPayError('auth_failed')` — link closed — when the peer's signature does
 * not verify, its key is not `expectedPeer`, its hello is malformed (a non-canonical key,
 * say) or repeats this side's nonce, it sends anything out of turn, it sends more messages
 * than the handshake can have waiting (more than hello, auth and ready while this side is
 * still signing or verifying), or the wallet fails;
 * `WebRTPayError('timeout')` — link closed — after `timeoutMs`; the link's close reason
 * (or `closed`) when it closes first, such as `too_large` for a message over 65536 bytes
 * before the peer authenticated; `RangeError` for an invalid `maxMessageBytes`.
 */
export function authenticate(link: PeerLink, o: AuthenticateOptions): Promise<AuthenticatedPeer> {
  const cap = o.maxMessageBytes ?? DEFAULTS.maxMessageBytes
  if (!Number.isSafeInteger(cap) || cap < 0) {
    return Promise.reject(new RangeError(`Invalid message size cap: ${cap}`))
  }
  return new Promise((resolve, reject) => {
    new Handshake(link, o, cap, resolve, reject).begin()
  })
}

function authFailed(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('auth_failed', message, cause === undefined ? undefined : { cause })
}

/** One run of the handshake on one link; settles exactly once. */
class Handshake {
  /** The peer message expected next; they always come hello, auth, ready. */
  private expecting: 'hello' | 'auth' | 'ready' = 'hello'
  /** Peer messages not yet handled, oldest first. */
  private readonly inbox: unknown[] = []
  /** True while a step (or the setup) awaits the wallet or the link. */
  private busy = true
  private settled = false
  private localKey = ''
  private readonly localNonce = toBase64(randomBytes(NONCE_BYTES))
  private peer: Hello | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly offMessage: () => void
  private readonly offClose: () => void

  constructor(
    private readonly link: PeerLink,
    private readonly o: AuthenticateOptions,
    private readonly cap: number,
    private readonly resolve: (peer: AuthenticatedPeer) => void,
    private readonly reject: (error: unknown) => void
  ) {
    // Before anything can arrive: only an authenticated peer gets the full message size.
    link.setMaxMessageBytes(PRE_AUTH_MAX_MESSAGE_BYTES)
    // Listen before anything else: the link drops messages nobody is listening for.
    this.offMessage = link.onMessage(m => {
      // Messages wait here unchecked while a step is busy, so a peer that floods before it
      // has authenticated must not be able to grow the queue.
      const limit = this.expecting === 'ready' ? MAX_INBOX_AFTER_READY : MAX_INBOX_BEFORE_READY
      if (this.inbox.length >= limit) {
        this.fail(authFailed('Peer sent too many messages during the handshake'))
        return
      }
      this.inbox.push(m)
      this.pump()
    })
    this.offClose = link.onClose(reason => {
      this.fail(reason ?? new WebRTPayError('closed', 'Link closed during the handshake'))
    })
  }

  /** Start the clock (unless `startAfter` defers it) and the setup; called once, right after construction. */
  begin(): void {
    const timeoutMs = this.o.timeoutMs ?? DEFAULTS.handshakeTimeoutMs
    if (this.o.startAfter === undefined) this.startTimer(timeoutMs)
    this.run(this.start(timeoutMs))
  }

  private startTimer(timeoutMs: number): void {
    this.timer = setTimeout(() => {
      this.fail(new WebRTPayError('timeout', `Handshake not finished within ${timeoutMs} ms`))
    }, timeoutMs)
  }

  /** Learn our key, wait for `startAfter` and the channel, say hello. */
  private async start(timeoutMs: number): Promise<void> {
    const { publicKey } = await this.o.wallet.getPublicKey({ identityKey: true }, this.o.originator)
    this.localKey = publicKey
    if (this.o.startAfter !== undefined) {
      await this.o.startAfter
      if (this.settled) return
      this.startTimer(timeoutMs)
    }
    await this.link.waitOpen(timeoutMs)
    if (this.settled) return
    const hello: Hello = { t: 'hello', v: 1, identityKey: publicKey, nonce: this.localNonce }
    await this.link.send(hello)
  }

  /** Handle queued messages one at a time; a step that awaits holds the rest back. */
  private pump(): void {
    while (!this.busy && !this.settled && this.inbox.length > 0) {
      let step: Promise<void> | undefined
      try {
        step = this.step(this.inbox.shift())
      } catch (error) {
        this.fail(error)
        return
      }
      if (step) {
        this.busy = true
        this.run(step)
      }
    }
  }

  private run(step: Promise<void>): void {
    step.then(
      () => {
        this.busy = false
        this.pump()
      },
      error => this.fail(error)
    )
  }

  private step(raw: unknown): Promise<void> | undefined {
    let m: WireMessage
    try {
      m = parseWireMessage(raw)
    } catch (cause) {
      throw authFailed('Peer sent a malformed handshake message', cause)
    }
    if (m.t !== this.expecting) {
      throw authFailed(`Peer sent '${m.t}' while the handshake expected '${this.expecting}'`)
    }
    if (m.t === 'hello') return this.onHello(m)
    if (m.t === 'auth') return this.onAuth(m)
    this.finish()
    return undefined
  }

  private async onHello(hello: Hello): Promise<void> {
    if (this.o.expectedPeer !== undefined && hello.identityKey !== this.o.expectedPeer) {
      throw authFailed('Peer is not the identity this session expects')
    }
    if (hello.nonce === this.localNonce) throw authFailed('Peer repeated our nonce')
    this.peer = hello
    this.expecting = 'auth'
    const signerFingerprints = this.link.localFingerprints()
    const verifierFingerprints = this.link.remoteFingerprints()
    if (signerFingerprints.length === 0 || verifierFingerprints.length === 0) {
      throw authFailed('No DTLS fingerprint to bind the session to')
    }
    const data = bindingTranscript({
      signerFingerprints,
      verifierFingerprints,
      signerNonce: this.localNonce,
      verifierNonce: hello.nonce,
      signerKey: this.localKey,
      verifierKey: hello.identityKey
    })
    let signature: number[]
    try {
      const signed = await this.o.wallet.createSignature(
        {
          data,
          protocolID: CHANNEL_PROTOCOL_ID,
          keyID: this.localNonce,
          counterparty: hello.identityKey
        },
        this.o.originator
      )
      signature = signed.signature
    } catch (cause) {
      throw authFailed('Wallet could not sign the channel binding', cause)
    }
    if (this.settled) return
    const auth: Auth = { t: 'auth', signature: toHex(Uint8Array.from(signature)) }
    await this.link.send(auth)
  }

  private async onAuth(auth: Auth): Promise<void> {
    const peer = this.peer!
    const data = bindingTranscript({
      signerFingerprints: this.link.remoteFingerprints(),
      verifierFingerprints: this.link.localFingerprints(),
      signerNonce: peer.nonce,
      verifierNonce: this.localNonce,
      signerKey: peer.identityKey,
      verifierKey: this.localKey
    })
    let valid: boolean
    try {
      // Wallets throw (ERR_INVALID_SIGNATURE) rather than return { valid: false }.
      const checked = await this.o.wallet.verifySignature(
        {
          data,
          signature: Array.from(fromHex(auth.signature)),
          protocolID: CHANNEL_PROTOCOL_ID,
          keyID: peer.nonce,
          counterparty: peer.identityKey
        },
        this.o.originator
      )
      valid = checked.valid
    } catch (cause) {
      throw authFailed('Peer signature does not verify', cause)
    }
    if (valid !== true) throw authFailed('Peer signature does not verify')
    if (this.settled) return
    this.link.setMaxMessageBytes(this.cap)
    this.expecting = 'ready'
    await this.link.send({ t: 'ready' })
  }

  private finish(): void {
    this.settled = true
    clearTimeout(this.timer)
    // The session subscribes before the handshake lets go, so no message falls between.
    const session = new AuthenticatedPeer(
      this.link,
      { localIdentityKey: this.localKey, peerIdentityKey: this.peer!.identityKey },
      this.inbox.splice(0)
    )
    this.offMessage()
    this.offClose()
    this.resolve(session)
  }

  private fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.timer)
    this.offMessage()
    this.offClose()
    const reason = error instanceof WebRTPayError ? error : authFailed('Handshake failed', error)
    this.link.close(reason)
    this.reject(reason)
  }
}
