import { decodeEnvelope } from '../bootstrap/envelope.js'
import { DeliveryFailed, GroupMessagingError } from '../errors.js'
import type { IdentityKey, MlsGroupId, Unsubscribe, WirePayload } from '../types.js'
import type { TransportBackend } from './backend.js'
import { InProcessTransportHub } from './backends/in-process.js'
import {
  MessageBoxTransport,
  type MessageBoxClientLike,
  type MessageBoxTransportOptions
} from './backends/message-box.js'

/**
 * Refuse anything that is not a well-formed envelope.
 *
 * {@link WirePayload}'s brand is erased at compile time, so a JavaScript caller
 * — or anyone with an `as any` — can hand `send` the private half of a
 * KeyPackage and the type system never sees it. Every outbound payload the
 * library produces comes from `encodeEnvelope`, so demanding one costs nothing
 * and makes spec §4.1 true at runtime rather than only under `tsc`.
 */
const requireEnvelope = (payload: WirePayload): void => {
  try {
    decodeEnvelope(payload)
  } catch (cause) {
    throw new GroupMessagingError('Refusing to send bytes that are not a valid envelope', {
      cause
    })
  }
}

/** Anything {@link TransportService.open} knows how to turn into delivery. */
export type TransportInput = TransportService | TransportBackend | MessageBoxClientLike

/**
 * Delivery, as the rest of the library sees it.
 *
 * The class callers touch. It owns fan-out — one Commit reaching every member,
 * using the backend's `broadcast` when it has one and N sends when it does not
 * — and delegates the bytes to a {@link TransportBackend}.
 */
type MessageHandler = (from: IdentityKey, payload: Uint8Array) => void | Promise<void>
type ErrorHandler = (error: Error, from?: IdentityKey) => void

export { DeliveryFailed }

export class TransportService {
  readonly #handlers = new Set<MessageHandler>()
  readonly #errorHandlers = new Set<ErrorHandler>()
  #unsubscribe: Unsubscribe | undefined
  #unsubscribeErrors: Unsubscribe | undefined

  constructor(private readonly backend: TransportBackend) {}

  /** Delivery over MessageBox / PeerServ. */
  static messageBox(
    client: MessageBoxClientLike,
    options?: MessageBoxTransportOptions
  ): TransportService {
    return new TransportService(new MessageBoxTransport(client, options))
  }

  /** Delivery to another client in this process. */
  static inProcess(hub: InProcessTransportHub, identity: IdentityKey): TransportService {
    return new TransportService(hub.endpoint(identity))
  }

  /** Work out which backend fits, build it, and start it. */
  static async open(input: TransportInput): Promise<TransportService> {
    const service = input instanceof TransportService ? input : resolve(input)
    await service.start()
    return service
  }

  async start(): Promise<void> {
    // Subscribed before the backend starts: a backend reports its startup
    // faults from inside `start` — a refused live socket, most of all — and a
    // subscription taken afterwards would find them already discarded.
    this.#unsubscribeErrors ??= this.backend.onError?.(error => {
      this.#report(error)
    })
    await this.backend.start?.()
    this.#unsubscribe ??= this.backend.onMessage(async (from, payload) => {
      const failures: Error[] = []
      for (const handler of this.#handlers) {
        try {
          await handler(from, payload)
        } catch (cause) {
          const error = toError(cause)
          this.#report(error, from)
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new DeliveryFailed(from, failures)
    })
  }

  /**
   * Handlers are isolated from each other and from the transport.
   *
   * Without this, one subscriber throwing on a malformed message aborts the
   * delivery loop: every later subscriber is skipped, and a backend draining a
   * queue stops mid-drain with the remaining messages neither delivered nor
   * re-queued. Each failure is reported here and the loop runs to the end;
   * the summary {@link DeliveryFailed} is then thrown so a backend that can
   * retry knows the message was not processed. Reported *and* propagated,
   * with the two carrying different information.
   */
  #report(error: Error, from?: IdentityKey): void {
    if (this.#errorHandlers.size === 0) {
      // Nobody is listening, and swallowing silently would hide a real fault.
      queueMicrotask(() => {
        throw error
      })
      return
    }
    for (const handler of this.#errorHandlers) handler(error, from)
  }

  /** Called when an inbound handler throws. */
  onError(handler: ErrorHandler): Unsubscribe {
    this.#errorHandlers.add(handler)
    return () => {
      this.#errorHandlers.delete(handler)
    }
  }

  /**
   * The backend closes first, and only then are the handlers dropped.
   *
   * The other order is not a tidier version of the same thing: a backend with a
   * delivery in flight would find an empty handler set, see every handler
   * "succeed", and acknowledge a batch nobody received. Closing first lets the
   * backend finish or abandon that batch while its subscribers are still real.
   */
  async close(): Promise<void> {
    await this.backend.close?.()
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#unsubscribeErrors?.()
    this.#unsubscribeErrors = undefined
    this.#handlers.clear()
    this.#errorHandlers.clear()
  }

  onMessage(handler: MessageHandler): Unsubscribe {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  async send(recipient: IdentityKey, payload: WirePayload): Promise<void> {
    requireEnvelope(payload)
    await this.backend.send(recipient, payload)
  }

  /**
   * Deliver one payload to every member of a group.
   *
   * With no central server the sender fans out, so this is N sends unless the
   * backend can do better. Sends run concurrently and failures are collected
   * rather than short-circuited: a Commit that reached three of four members is
   * a different situation from one that reached none, and the caller needs to
   * know which.
   */
  async broadcast(
    groupId: MlsGroupId,
    recipients: IdentityKey[],
    payload: WirePayload
  ): Promise<void> {
    requireEnvelope(payload)
    if (this.backend.broadcast !== undefined) {
      await this.backend.broadcast(groupId, recipients, payload)
      return
    }
    const results = await Promise.allSettled(
      recipients.map(async recipient => this.backend.send(recipient, payload))
    )
    const failed = recipients.filter((_, index) => results[index]?.status === 'rejected')
    if (failed.length > 0) {
      throw new BroadcastError(groupId, failed, recipients.length - failed.length)
    }
  }
}

export class BroadcastError extends GroupMessagingError {
  override name = 'BroadcastError'
  constructor(
    readonly groupId: MlsGroupId,
    readonly failed: IdentityKey[],
    readonly delivered: number
  ) {
    super(
      `Delivered to ${delivered} of ${delivered + failed.length} members of ${groupId}; ` +
        `${failed.length} failed`
    )
  }
}

const resolve = (input: TransportBackend | MessageBoxClientLike): TransportService => {
  if (
    typeof (input as TransportBackend).send === 'function' &&
    typeof (input as TransportBackend).onMessage === 'function'
  ) {
    return new TransportService(input as TransportBackend)
  }
  if (typeof (input as MessageBoxClientLike).sendMessage === 'function') {
    return TransportService.messageBox(input as MessageBoxClientLike)
  }
  throw new GroupMessagingError(
    'Unrecognized transport. Pass a TransportBackend, a MessageBoxClient, or an InProcessTransportHub endpoint.'
  )
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))
