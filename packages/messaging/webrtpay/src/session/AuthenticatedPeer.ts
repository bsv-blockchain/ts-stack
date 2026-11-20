import type { PeerLink } from '../channel/PeerLink.js'
import { parseWireMessage } from '../payments/wire.js'
import type { WireMessage } from '../payments/wire.js'
import type { PubKeyHex } from '../types.js'
import { Emitter } from '../util/emitter.js'
import { WebRTPayError } from '../util/errors.js'

/** Most messages kept for a session nobody has started reading yet. */
export const MAX_BACKLOG = 64

/**
 * How a session reads the values its peer sends once the handshake is over: return the
 * message, or throw to refuse it (the session then answers `{ t: 'error', code: 'protocol' }`
 * and closes with `protocol`). The default is `parseWireMessage`, the payments wire; a
 * consumer that carries its own kinds over the channel passes its own parser and receives
 * them unparsed by the payments layer. The handshake itself always uses the payments wire.
 */
export type SessionCodec<M> = (raw: unknown) => M

const HANDSHAKE_KINDS: ReadonlySet<unknown> = new Set(['hello', 'auth', 'ready'])

/** True for a value tagged as a handshake message, whatever the session's codec. */
function isHandshakeKind(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && HANDSHAKE_KINDS.has((raw as { t?: unknown }).t)
}

/**
 * A data channel session whose peer proved its identity key (see `authenticate`, which
 * creates it). Carries {@link WireMessage}s both ways by default; every incoming value is
 * checked with the session's codec (`parseWireMessage` unless `authenticate` was given
 * another, see {@link SessionCodec}), and one that fails, or a handshake message (`hello`,
 * `auth`, `ready`: the handshake is over), is answered with `{ t: 'error', code: 'protocol' }`
 * before the session closes with `protocol`.
 *
 * Messages that arrive before the first {@link onMessage} or {@link waitFor} are kept and
 * handed to that first listener, in order; after that, messages that arrive while no
 * listener is registered are dropped.
 */
export class AuthenticatedPeer<M = WireMessage> {
  /** The identity key the peer signed the channel binding with. */
  readonly peerIdentityKey: PubKeyHex
  /** This side's identity key. */
  readonly localIdentityKey: PubKeyHex
  private readonly link: PeerLink
  private readonly events = new Emitter<{ message: M }>()
  private readonly codec: SessionCodec<M>
  /** Messages waiting for the first listener; `undefined` once they are handed over. */
  private backlog: M[] | undefined = []
  private releasing = false
  private failed = false

  /**
   * @internal Created by `authenticate`. `pending` are raw values the handshake read past
   * its own end; they come before anything the link delivers later. `codec` reads every
   * incoming value; it defaults to `parseWireMessage`.
   */
  constructor(
    link: PeerLink,
    keys: { localIdentityKey: PubKeyHex; peerIdentityKey: PubKeyHex },
    pending: unknown[] = [],
    codec?: SessionCodec<M>
  ) {
    this.link = link
    this.codec = codec ?? (parseWireMessage as SessionCodec<unknown> as SessionCodec<M>)
    this.localIdentityKey = keys.localIdentityKey
    this.peerIdentityKey = keys.peerIdentityKey
    for (const raw of pending) this.receive(raw)
    link.onMessage(raw => this.receive(raw))
  }

  /**
   * Send one message. Resolves once it is handed to the channel, not when the peer has it.
   *
   * @throws The close reason (or `closed`) once the session is closed.
   */
  send(m: M): Promise<void> {
    return this.link.send(m as object)
  }

  /**
   * Receive every message from the peer. A listener that throws does not affect the
   * session or other listeners.
   *
   * @returns A function that removes the listener.
   */
  onMessage(fn: (m: M) => void): () => void {
    const off = this.events.on('message', fn)
    this.release()
    return off
  }

  /**
   * Resolve with the first message from now on (or kept for the first listener) that
   * `pred` accepts. A timeout does not close the session; the caller decides.
   *
   * @throws `WebRTPayError('timeout')` after `timeoutMs`; the close reason (or `closed`)
   * if the session closes first; whatever `pred` throws.
   */
  waitFor<T extends M>(pred: (m: M) => m is T, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false
      const settle = (finish: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        offMessage()
        offClose()
        finish()
      }
      const timer = setTimeout(
        () => settle(() => reject(new WebRTPayError('timeout', `No reply within ${timeoutMs} ms`))),
        timeoutMs
      )
      // Neither listener runs synchronously: kept messages and a past close come on a microtask.
      const offMessage = this.onMessage(m => {
        let match: boolean
        try {
          match = pred(m)
        } catch (error) {
          settle(() => reject(error))
          return
        }
        if (match) settle(() => resolve(m as T))
      })
      const offClose = this.link.onClose(reason =>
        settle(() => reject(reason ?? new WebRTPayError('closed', 'Session closed')))
      )
    })
  }

  /**
   * Learn when the session closes, once, with the reason (see `PeerLink.onClose`).
   *
   * @returns A function that removes the listener.
   */
  onClose(fn: (e?: WebRTPayError) => void): () => void {
    return this.link.onClose(fn)
  }

  /**
   * True while the session can still carry messages: the channel is open and neither side
   * has closed it. Check it before spending when time has passed since `connect`, as a
   * payee closes a session that sends nothing within its first-message timeout.
   */
  get isOpen(): boolean {
    return this.link.isOpen && !this.failed
  }

  /** Close the session and its connection; `reason` goes to {@link onClose} listeners. */
  close(reason?: WebRTPayError): void {
    this.link.close(reason)
  }

  private receive(raw: unknown): void {
    if (this.failed) return
    let m: M
    try {
      m = this.codec(raw)
    } catch (cause) {
      this.fail(new WebRTPayError('protocol', 'Peer sent an invalid message', { cause }))
      return
    }
    if (isHandshakeKind(raw)) {
      const t = String((raw as { t: unknown }).t)
      this.fail(new WebRTPayError('protocol', `Peer sent '${t}' after the handshake`))
      return
    }
    if (this.backlog === undefined) {
      this.events.emit('message', m)
    } else if (this.backlog.length < MAX_BACKLOG) {
      this.backlog.push(m)
    } else {
      this.fail(new WebRTPayError('protocol', `Peer sent more than ${MAX_BACKLOG} unread messages`))
    }
  }

  /** Hand the kept messages to the listeners on a microtask, so `onMessage` returns first. */
  private release(): void {
    if (this.backlog === undefined || this.releasing) return
    this.releasing = true
    queueMicrotask(() => {
      const kept = this.backlog ?? []
      this.backlog = undefined
      for (const m of kept) this.events.emit('message', m)
    })
  }

  /** Tell the peer, then close; the close waits until the error is handed to the channel. */
  private fail(error: WebRTPayError): void {
    this.failed = true
    const close = (): void => this.link.close(error)
    this.link.send({ t: 'error', code: 'protocol' }).then(close, close)
  }
}
