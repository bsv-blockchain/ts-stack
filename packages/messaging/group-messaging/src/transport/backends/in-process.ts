import { utf8 } from '../../bytes.js'
import { decodeFrames, encodeFrames } from '../../storage/frames.js'
import type { IdentityKey, Unsubscribe } from '../../types.js'
import type { TransportBackend } from '../backend.js'

type Handler = (from: IdentityKey, payload: Uint8Array) => void | Promise<void>

const decoder = new TextDecoder()

/**
 * Connects several clients inside one process.
 *
 * Useful wherever a network is not wanted: unit tests, a demo page running two
 * simulated wallets, a native shell wiring an embedded client to a WebView. It
 * mirrors MessageBox semantics closely enough to be a fair stand-in — bytes go
 * straight to a listening recipient, queue for one that is offline, and are
 * forgotten once delivered.
 *
 * The queue map is supplied by the caller, so the hub holds no store of its
 * own. Subscriptions are not in it: those are live callbacks belonging to
 * running clients, so they cannot be persisted and stay in memory.
 */
export class InProcessTransportHub {
  readonly #handlers = new Map<IdentityKey, Set<Handler>>()
  readonly #offline = new Set<IdentityKey>()
  readonly #flushing = new Map<IdentityKey, Promise<void>>()

  constructor(private readonly queues: Map<string, Uint8Array> = new Map()) {}

  /** A backend bound to one identity. */
  endpoint(identity: IdentityKey): TransportBackend {
    return {
      send: async (recipient: IdentityKey, payload: Uint8Array) => {
        await this.#deliver(identity, recipient, payload)
      },
      onMessage: (handler: Handler): Unsubscribe => {
        const handlers = this.#handlers.get(identity) ?? new Set<Handler>()
        handlers.add(handler)
        this.#handlers.set(identity, handlers)
        void this.#flush(identity)
        return () => {
          handlers.delete(handler)
        }
      }
    }
  }

  /** Hold an endpoint offline. Sends to it queue until {@link goOnline}. */
  goOffline(identity: IdentityKey): void {
    this.#offline.add(identity)
  }

  /** Release an endpoint and deliver everything queued for it, in order. */
  async goOnline(identity: IdentityKey): Promise<void> {
    this.#offline.delete(identity)
    await this.#flush(identity)
  }

  pendingCount(identity: IdentityKey): number {
    return decodeFrames(this.queues.get(identity)).length
  }

  /**
   * Everything is queued first, then drained. Routing direct delivery through
   * the same queue costs nothing here and buys strict per-recipient ordering: a
   * message sent while a flush is in progress cannot overtake the messages
   * already waiting, which is the property Commit-before-message ordering
   * depends on.
   */
  async #deliver(from: IdentityKey, to: IdentityKey, payload: Uint8Array): Promise<void> {
    const queue = decodeFrames(this.queues.get(to))
    queue.push(encodeFrames([utf8(from), payload]))
    this.queues.set(to, encodeFrames(queue))
    await this.#flush(to)
  }

  /**
   * Serialized per identity, which is what keeps a recipient's messages in
   * order.
   *
   * `#flushOnce` reads the queue and clears it in adjacent synchronous
   * statements, so two flushes cannot both take the same messages — duplicate
   * delivery is not the hazard here. The hazard is overtaking: a `send` that
   * lands while a drain is parked on a handler would otherwise start its own
   * flush, find the queue empty, and deliver ahead of the messages still
   * waiting behind that handler. Commit-before-message ordering depends on it
   * not doing that.
   */
  async #flush(identity: IdentityKey): Promise<void> {
    const previous = this.#flushing.get(identity) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => this.#flushOnce(identity))
    this.#flushing.set(identity, current)
    try {
      await current
    } finally {
      if (this.#flushing.get(identity) === current) this.#flushing.delete(identity)
    }
  }

  async #flushOnce(identity: IdentityKey): Promise<void> {
    if (this.#offline.has(identity)) return
    const handlers = this.#handlers.get(identity)
    if (handlers === undefined || handlers.size === 0) return

    const queued = decodeFrames(this.queues.get(identity))
    if (queued.length === 0) return
    this.queues.delete(identity)

    for (const item of queued) {
      const [from, payload] = decodeFrames(item)
      if (from === undefined || payload === undefined) continue
      for (const handler of handlers) {
        try {
          await handler(decoder.decode(from), payload)
        } catch {
          // A receiver that cannot process a message must not fail the sender's
          // send: this hub has no queue to leave it in, and the failure has
          // already been reported through the transport's error channel.
        }
      }
    }
  }
}
