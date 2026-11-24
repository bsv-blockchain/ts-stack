import { sdpFingerprints } from '../codec/sdp.js'
import { CHANNEL_LABEL, DEFAULTS } from '../types.js'
import { Emitter } from '../util/emitter.js'
import { WebRTPayError } from '../util/errors.js'
import { FRAME_HEADER_BYTES, FrameDecoder, encodeMessage } from './frames.js'

/** How a link builds its `RTCPeerConnection`. */
export interface RtcOptions {
  /** Constructor to use; defaults to `globalThis.RTCPeerConnection` (browsers). */
  RTCPeerConnection?: typeof RTCPeerConnection
  /** STUN and TURN servers; none by default. */
  iceServers?: RTCIceServer[]
  /** `'relay'` forces TURN; the platform default otherwise. */
  iceTransportPolicy?: RTCIceTransportPolicy
  /**
   * Extra fields spread into the `RTCPeerConnection` configuration, for options a platform
   * adds (node-datachannel's `bindAddress`, for example). `disableFingerprintVerification`,
   * `iceServers` and `iceTransportPolicy` here are ignored.
   */
  extraConfig?: Record<string, unknown>
  /**
   * Longest wait for ICE gathering before sending what was gathered: a positive number of
   * milliseconds up to 2^31 − 1; defaults to 5 s.
   */
  gatherTimeoutMs?: number
}

/** Options for {@link PeerLink.createOffer} and {@link PeerLink.acceptOffer}. */
export interface PeerLinkOptions extends RtcOptions {
  /** Largest message accepted from the peer, in bytes of JSON text; defaults to 32 MiB. */
  maxMessageBytes?: number
  /** Largest frame sent, 6-byte header included; defaults to 16 KiB. */
  chunkBytes?: number
}

/** `send` waits while more than this many bytes are queued on the channel. */
const MAX_BUFFERED_BYTES = 1024 * 1024
/** Queued bytes at or below which the channel fires `bufferedamountlow`. */
const LOW_WATER_BYTES = 256 * 1024
/** Longest delay `setTimeout` honours. */
const MAX_TIMER_MS = 2 ** 31 - 1
/**
 * How long a link that refused an oversize message stays up once its `too_large` reply is
 * handed to the channel, unless the peer closes first: closing the connection at once can
 * discard the reply before it is sent.
 */
const REFUSAL_LINGER_MS = 1000
/** One fingerprint as `sdpFingerprints` writes it: SHA-256, 32 bytes of lower-case hex. */
const SHA256_FINGERPRINT_ENTRY = /^sha-256 [0-9a-f]{64}$/

type LinkEvents = {
  open: undefined
  message: unknown
  close: WebRTPayError | undefined
}

/**
 * One `RTCPeerConnection` with one ordered, fully reliable data channel labelled
 * `webrtpay/1`, carrying JSON objects as framed binary messages.
 *
 * Signaling is non-trickle: {@link createOffer} and {@link acceptOffer} return a complete
 * SDP once ICE gathering finishes or times out, so each side sends exactly one
 * description. Every SDP, local or remote, must carry exactly one DTLS fingerprint, a
 * SHA-256 one, since the identity handshake signs the fingerprints each side sees (audit
 * F12); anything else is refused with `protocol` before the WebRTC stack applies it. What
 * the stack throws becomes a `WebRTPayError` with it as the `cause`: `protocol`, or `closed`
 * when the connection was closed meanwhile.
 *
 * The link closes, once, when either side calls {@link close}, the channel or connection
 * closes or fails, or the peer breaks the framing rules. A message over the cap is answered
 * with `{ t: 'error', code: 'too_large' }` (the framing is still in step, as the cap is
 * checked before a frame is buffered), so the peer can tell why; the link then reads
 * nothing more and closes with `too_large` when the peer closes, or 1 s after the reply
 * was handed to the channel.
 */
export class PeerLink {
  private readonly pc: RTCPeerConnection
  private readonly role: 'offerer' | 'answerer'
  private readonly chunkBytes: number
  private readonly decoder: FrameDecoder
  private readonly events = new Emitter<LinkEvents>()
  private channel: RTCDataChannel | undefined
  private localSdp = ''
  private remoteSdp: string | undefined
  private opened = false
  private closed = false
  /** Why the link is refusing the peer (an oversize message): nothing more is read. */
  private refused: WebRTPayError | undefined
  private lingerTimer: ReturnType<typeof setTimeout> | undefined
  private closeReason: WebRTPayError | undefined
  private sendSeq = 0
  /** Tail of the send queue; never rejects, so one failed send cannot poison the next. */
  private sendTail: Promise<void> = Promise.resolve()

  private constructor(pc: RTCPeerConnection, role: 'offerer' | 'answerer', o: PeerLinkOptions) {
    this.pc = pc
    this.role = role
    this.chunkBytes = o.chunkBytes ?? DEFAULTS.chunkBytes
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes <= FRAME_HEADER_BYTES) {
      throw new RangeError(`Chunk size must leave room for payload: ${this.chunkBytes}`)
    }
    this.decoder = new FrameDecoder({
      maxMessageBytes: o.maxMessageBytes ?? DEFAULTS.maxMessageBytes
    })
    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState
      if (state === 'failed' || state === 'closed') {
        this.close(new WebRTPayError('closed', `Peer connection ${state}`))
      }
    })
    pc.addEventListener('datachannel', event => this.adopt(event.channel))
  }

  /**
   * Start a link as the offerer: create the data channel, gather ICE and return the offer
   * SDP to send to the peer. Apply the peer's answer with {@link acceptAnswer}.
   *
   * @throws `WebRTPayError('unsupported')` when no `RTCPeerConnection` is available;
   * `WebRTPayError('protocol')` (the stack's error as its `cause`) when the peer connection
   * refuses the configuration or cannot create the offer, or the offer does not have exactly
   * one SHA-256 fingerprint; `RangeError` for invalid `chunkBytes`, `maxMessageBytes` or
   * `gatherTimeoutMs`.
   */
  static async createOffer(o: PeerLinkOptions): Promise<{ link: PeerLink; sdp: string }> {
    const gatherMs = gatherTimeout(o.gatherTimeoutMs)
    const pc = newPeerConnection(o)
    try {
      const link = new PeerLink(pc, 'offerer', o)
      link.attach(
        await fromStack(pc, 'create the data channel', () =>
          pc.createDataChannel(CHANNEL_LABEL, { ordered: true })
        )
      )
      await fromStack(pc, 'create an offer', async () =>
        pc.setLocalDescription(await pc.createOffer())
      )
      link.localSdp = await gatheredSdp(pc, gatherMs)
      return { link, sdp: link.localSdp }
    } catch (e) {
      pc.close()
      throw e
    }
  }

  /**
   * Start a link as the answerer from the peer's offer SDP and return the answer SDP to
   * send back. The link takes the channel the offerer created when it arrives.
   *
   * @throws `WebRTPayError('protocol')` (the stack's error as its `cause`) for an offer
   * without exactly one SHA-256 fingerprint, when the peer connection refuses the
   * configuration or the offer, or cannot create an answer; `WebRTPayError('unsupported')`
   * when no `RTCPeerConnection` is available; `RangeError` for invalid `chunkBytes`,
   * `maxMessageBytes` or `gatherTimeoutMs`.
   */
  static async acceptOffer(
    offerSdp: string,
    o: PeerLinkOptions
  ): Promise<{ link: PeerLink; sdp: string }> {
    const gatherMs = gatherTimeout(o.gatherTimeoutMs)
    requireOneFingerprint(offerSdp, 'offer')
    const pc = newPeerConnection(o)
    try {
      const link = new PeerLink(pc, 'answerer', o)
      await applyRemote(pc, 'offer', offerSdp)
      link.remoteSdp = offerSdp
      await fromStack(pc, 'create an answer', async () =>
        pc.setLocalDescription(await pc.createAnswer())
      )
      link.localSdp = await gatheredSdp(pc, gatherMs)
      return { link, sdp: link.localSdp }
    } catch (e) {
      pc.close()
      throw e
    }
  }

  /**
   * Apply the peer's answer SDP (offerer only, once). A refused answer leaves the link as
   * it was.
   *
   * @throws `WebRTPayError('protocol')` on the answerer, for a second answer, for an answer
   * without exactly one SHA-256 fingerprint, or when the peer connection refuses the SDP;
   * the close reason once the link is closed.
   */
  async acceptAnswer(answerSdp: string): Promise<void> {
    if (this.closed) throw this.closedError()
    if (this.role !== 'offerer' || this.remoteSdp !== undefined) {
      throw new WebRTPayError('protocol', 'Link is not waiting for an answer')
    }
    requireOneFingerprint(answerSdp, 'answer')
    try {
      await applyRemote(this.pc, 'answer', answerSdp)
    } catch (e) {
      throw this.closed ? this.closedError() : e
    }
    this.remoteSdp = answerSdp
  }

  /**
   * Resolve once the data channel is open. It does not close the link on timeout; the
   * caller decides.
   *
   * @throws `WebRTPayError('timeout')` after `timeoutMs`; the close reason (or `closed`)
   * if the link closes first.
   */
  waitOpen(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError())
    if (this.opened) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: WebRTPayError): void => {
        clearTimeout(timer)
        offOpen()
        offClose()
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () => settle(new WebRTPayError('timeout', `Data channel not open after ${timeoutMs} ms`)),
        timeoutMs
      )
      const offOpen = this.events.once('open', () => settle())
      const offClose = this.events.once('close', reason => settle(reason ?? this.closedError()))
    })
  }

  /**
   * Send one JSON object. Messages are delivered whole and in call order, also when sends
   * overlap. Resolves once the last frame is handed to the channel, waiting while more
   * than 1 MiB is queued; that is not an acknowledgement of receipt.
   *
   * @throws `WebRTPayError('closed')` before the channel opens or if it fails mid-message;
   * the close reason once the link is closed; `TypeError` for a value JSON cannot represent.
   */
  send(message: object): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError())
    if (!this.opened) {
      return Promise.reject(new WebRTPayError('closed', 'Data channel is not open'))
    }
    let frames: Uint8Array[]
    try {
      frames = encodeMessage(this.sendSeq, message, this.chunkBytes)
    } catch (e) {
      return Promise.reject(e)
    }
    this.sendSeq++
    const sent = this.sendTail.then(() => this.writeFrames(frames))
    this.sendTail = sent.catch(() => undefined)
    return sent
  }

  /**
   * Receive every message from the peer: a parsed JSON object. Messages that arrive while
   * no listener is registered are dropped, so subscribe before {@link waitOpen}. A listener
   * that throws does not affect the link or other listeners.
   *
   * @returns A function that removes the listener.
   */
  onMessage(fn: (m: unknown) => void): () => void {
    return this.events.on('message', fn)
  }

  /**
   * Learn when the link closes, once. `err` is the reason passed to {@link close}, or why
   * the link closed itself: `protocol` or `too_large` for bad frames from the peer,
   * `closed` when the channel or connection went away. It is `undefined` after a local
   * `close()` without a reason. Registering after the close still reports it, on a
   * microtask.
   *
   * @returns A function that removes the listener.
   */
  onClose(fn: (err?: WebRTPayError) => void): () => void {
    if (!this.closed) return this.events.on('close', fn)
    const late = new Emitter<{ close: WebRTPayError | undefined }>()
    const off = late.on('close', fn)
    const reason = this.closeReason
    queueMicrotask(() => late.emit('close', reason))
    return off
  }

  /** This side's DTLS fingerprints (`"<alg> <lowercase hex>"`, sorted) from its SDP. */
  localFingerprints(): string[] {
    return sdpFingerprints(this.localSdp)
  }

  /** The peer's DTLS fingerprints from its SDP; empty before the answer is applied. */
  remoteFingerprints(): string[] {
    return this.remoteSdp === undefined ? [] : sdpFingerprints(this.remoteSdp)
  }

  /** True while the data channel is open and the link is neither closed nor refusing the peer. */
  get isOpen(): boolean {
    return this.opened && !this.closed && this.refused === undefined
  }

  /**
   * Change the largest message accepted from the peer, for every frame received from now
   * on (a message in progress included). A session raises the cap after the peer
   * authenticates.
   *
   * @throws `RangeError` for a value that is not a non-negative safe integer.
   */
  setMaxMessageBytes(n: number): void {
    this.decoder.setMaxMessageBytes(n)
  }

  /**
   * Close the connection and report `reason` to {@link onClose} listeners. Pending sends
   * and waits reject with `reason`, or `closed` when there is none. Later calls do nothing.
   * A link refusing an oversize message reports `too_large`, whatever closes it.
   */
  close(reason?: WebRTPayError): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.lingerTimer)
    const why = this.refused ?? reason
    this.closeReason = why
    try {
      this.pc.close()
    } catch {
      // already torn down; nothing left to release
    }
    this.events.emit('close', why)
    this.events.clear()
  }

  /**
   * Hand bytes or text to the channel as is, bypassing framing and the send queue.
   *
   * @internal Tests use it to play a peer that breaks the wire rules.
   */
  _sendRaw(data: Uint8Array | string): void {
    if (!this.isOpen || !this.channel) throw new WebRTPayError('closed', 'Data channel is not open')
    if (typeof data === 'string') this.channel.send(data)
    else this.channel.send(data as Uint8Array<ArrayBuffer>)
  }

  private closedError(): WebRTPayError {
    return this.closeReason ?? new WebRTPayError('closed', 'Link is closed')
  }

  /** Take the answerer's side of the offerer's channel; any other channel is a violation. */
  private adopt(channel: RTCDataChannel): void {
    if (this.closed) return
    const reliable =
      channel.ordered &&
      isUnsetLimit(channel.maxRetransmits) &&
      isUnsetLimit(channel.maxPacketLifeTime)
    if (this.role !== 'answerer' || this.channel || channel.label !== CHANNEL_LABEL || !reliable) {
      this.close(new WebRTPayError('protocol', `Unexpected data channel '${channel.label}'`))
      return
    }
    this.attach(channel)
  }

  private attach(channel: RTCDataChannel): void {
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES
    channel.addEventListener('open', () => this.markOpen())
    channel.addEventListener('close', () => {
      this.close(new WebRTPayError('closed', 'Data channel closed'))
    })
    channel.addEventListener('message', event => this.receive(event.data))
    // An answerer's channel can already be open when the datachannel event fires.
    if (channel.readyState === 'open') this.markOpen()
  }

  private markOpen(): void {
    if (this.opened || this.closed) return
    this.opened = true
    this.events.emit('open', undefined)
  }

  private receive(data: unknown): void {
    if (this.closed || this.refused !== undefined) return
    const frame = toBytes(data)
    if (!frame) {
      this.close(new WebRTPayError('protocol', 'Data channel message is not binary'))
      return
    }
    let message: unknown
    try {
      message = this.decoder.push(frame)
    } catch (e) {
      const error =
        e instanceof WebRTPayError
          ? e
          : new WebRTPayError('protocol', 'Frame could not be processed', { cause: e })
      if (error.code === 'too_large') this.refuseTooLarge(error)
      else this.close(error)
      return
    }
    if (message !== undefined) this.events.emit('message', message)
  }

  /**
   * Tell the peer its message is over the cap, then close with `error`. The decoder checks
   * the cap before buffering a frame, so the stream is still in step and the reply is a
   * well-formed message: a payer learns why its payment went nowhere (M14). The rest of the
   * peer's message is ignored. Closing the connection right after handing the reply to the
   * channel can discard it, so the link waits for the peer to close, at most 1 s.
   */
  private refuseTooLarge(error: WebRTPayError): void {
    const canReply = this.isOpen
    this.refused = error
    const close = (): void => this.close(error)
    if (!canReply) {
      close()
      return
    }
    const linger = (): void => {
      if (!this.closed) this.lingerTimer = setTimeout(close, REFUSAL_LINGER_MS)
    }
    this.send({ t: 'error', code: 'too_large', message: error.message }).then(linger, close)
  }

  /**
   * Write `frames` from `from` on, in order. Frames go out at once while the channel's
   * buffer has room; when it is over {@link MAX_BUFFERED_BYTES} the rest wait for it to drain.
   */
  private writeFrames(frames: Uint8Array[], from = 0): Promise<void> {
    const channel = this.channel!
    for (let i = from; i < frames.length; i++) {
      if (!this.closed && channel.bufferedAmount > MAX_BUFFERED_BYTES) {
        return this.drained(channel).then(() => this.writeFrames(frames, i))
      }
      if (this.closed) return Promise.reject(this.closedError())
      try {
        channel.send(frames[i] as Uint8Array<ArrayBuffer>)
      } catch (cause) {
        const error = new WebRTPayError('closed', 'Data channel send failed', { cause })
        this.close(error)
        return Promise.reject(error)
      }
    }
    return Promise.resolve()
  }

  /** Resolve on the next `bufferedamountlow`; reject if the link closes first. */
  private drained(channel: RTCDataChannel): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onLow = (): void => {
        channel.removeEventListener('bufferedamountlow', onLow)
        offClose()
        resolve()
      }
      const offClose = this.events.once('close', reason => {
        channel.removeEventListener('bufferedamountlow', onLow)
        reject(reason ?? this.closedError())
      })
      channel.addEventListener('bufferedamountlow', onLow)
    })
  }
}

/**
 * Numbers a channel reports for `maxRetransmits` or `maxPacketLifeTime` when its opener set no
 * limit. The DOM says `null`, but react-native-webrtc cannot: on Android it reports -1 for a
 * channel the peer opened, and on iOS it passes on libwebrtc's `uint16_t`, where unset is -1
 * read as 65535. That is also the largest limit a peer can set, so a channel limited to
 * exactly 65535 is read as unlimited: far above what a payment exchange reaches, and the price
 * of accepting React Native.
 */
const UNSET_LIMITS: ReadonlySet<number> = new Set([-1, 65535])

/** Whether a channel's `maxRetransmits` or `maxPacketLifeTime` says it has no such limit. */
function isUnsetLimit(limit: number | null | undefined): boolean {
  return limit == null || UNSET_LIMITS.has(limit)
}

/** `extraConfig` fields that are dropped rather than passed to the peer connection. */
const IGNORED_EXTRA_CONFIG = ['disableFingerprintVerification', 'iceServers', 'iceTransportPolicy']

function newPeerConnection(o: RtcOptions): RTCPeerConnection {
  const Ctor =
    o.RTCPeerConnection ??
    (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection
  if (!Ctor) throw new WebRTPayError('unsupported', 'No RTCPeerConnection implementation')
  // The identity handshake signs the DTLS fingerprints, so certificate checks stay on, and
  // ICE settings come only from their own options.
  const extra: Record<string, unknown> = { ...o.extraConfig }
  for (const key of IGNORED_EXTRA_CONFIG) delete extra[key]
  // Fresh objects: some implementations normalise the configuration they are given in place.
  const config: RTCConfiguration = {
    ...extra,
    iceServers: (o.iceServers ?? []).map(server => ({ ...server }))
  }
  if (o.iceTransportPolicy !== undefined) config.iceTransportPolicy = o.iceTransportPolicy
  try {
    return new Ctor(config)
  } catch (cause) {
    // e.g. a SyntaxError for an ICE server url the platform cannot parse
    throw new WebRTPayError('protocol', 'Peer connection refused its configuration', { cause })
  }
}

/** `gatherTimeoutMs`, or the default; a `RangeError` for a value `setTimeout` cannot wait for. */
function gatherTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULTS.gatherTimeoutMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_MS) {
    throw new RangeError(`gatherTimeoutMs must be a positive number up to ${MAX_TIMER_MS}`)
  }
  return ms
}

/**
 * Run `call` on the WebRTC stack. What it throws (a `DOMException` such as `SyntaxError` or
 * `InvalidStateError`, or anything else) becomes a `WebRTPayError` with it as the `cause`:
 * `closed` when the connection has been closed, `protocol` otherwise.
 */
async function fromStack<T>(
  pc: RTCPeerConnection,
  what: string,
  call: () => T | Promise<T>
): Promise<T> {
  try {
    return await call()
  } catch (cause) {
    if (cause instanceof WebRTPayError) throw cause
    if (pc.signalingState === 'closed') {
      throw new WebRTPayError('closed', `Peer connection closed before it could ${what}`, {
        cause
      })
    }
    throw new WebRTPayError('protocol', `Peer connection could not ${what}`, { cause })
  }
}

/**
 * Throws `protocol` unless `sdp` has exactly one `a=fingerprint:` line, a SHA-256 one of 32
 * bytes. The identity handshake signs every fingerprint each side's SDPs carry, while a
 * WebRTC stack may enforce only one of several (libdatachannel checks the first media-level
 * line), so a signed list must be exactly what DTLS checks (audit F12).
 */
function requireOneFingerprint(sdp: string, which: 'offer' | 'answer' | 'local description'): void {
  const fingerprints = sdpFingerprints(sdp)
  if (fingerprints.length !== 1 || !SHA256_FINGERPRINT_ENTRY.test(fingerprints[0])) {
    throw new WebRTPayError(
      'protocol',
      `The ${which} must carry exactly one sha-256 fingerprint; it has ${fingerprints.length}` +
        (fingerprints.length === 1 ? ' of another kind' : '')
    )
  }
}

function applyRemote(pc: RTCPeerConnection, type: 'offer' | 'answer', sdp: string): Promise<void> {
  return fromStack(pc, `apply the peer ${type}`, () => pc.setRemoteDescription({ type, sdp }))
}

/**
 * Wait for ICE gathering to complete or time out, then read the full local SDP, which must
 * carry exactly one SHA-256 fingerprint.
 */
async function gatheredSdp(pc: RTCPeerConnection, timeoutMs: number): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
      const onChange = (): void => {
        if (pc.iceGatheringState === 'complete') done()
      }
      const timer = setTimeout(done, timeoutMs)
      pc.addEventListener('icegatheringstatechange', onChange)
    })
  }
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new WebRTPayError('protocol', 'Peer connection produced no local description')
  requireOneFingerprint(sdp, 'local description')
  return sdp
}

/** The bytes of a binary message as delivered by `RTCDataChannel`, or undefined for text. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  // Tag check rather than instanceof: the buffer may come from another realm.
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array(data as ArrayBuffer)
  }
  return undefined
}
