import { ServerResponse, validateHeaderName, validateHeaderValue } from 'node:http'
import type { Response } from 'express'

/** A complete replacement, signed again for the original request. Limited to 64 KiB. */
export interface AuthenticatedResponseReplacement {
  statusCode: number
  headers: Record<string, string>
  body: Uint8Array
}

/** Owned snapshot of the exact signed HTTP response presented to the final guard. */
export interface AuthenticatedResponseCandidate extends AuthenticatedResponseReplacement {
  readonly identityKey: string
  readonly requestId: string
  /** At most one replacement is signed, so attempts are always zero or one. */
  readonly attempt: 0 | 1
}

/**
 * Acquire the application's durable read/send fence, recheck current access and
 * all disclosed targets, and call enqueue synchronously while holding that fence.
 * Returning a replacement without calling enqueue discards the signed candidate.
 * The guard may await fence acquisition; enqueue itself never signs or awaits.
 * All paths must honor signal. A guard never grants application authorization
 * merely because the peer authenticated successfully.
 */
export type AuthenticatedResponseQueueGuard = (
  response: AuthenticatedResponseCandidate,
  enqueue: () => void,
  signal: AbortSignal
) => void | AuthenticatedResponseReplacement | Promise<void | AuthenticatedResponseReplacement>

const transportMethods = ['end', 'write', 'writeHead', 'flushHeaders'] as const
const headerMethods = ['getHeaders', 'getHeaderNames', 'setHeader', 'removeHeader'] as const
const native = ServerResponse.prototype
const queues = new WeakMap<Response, AuthenticatedResponseQueue>()

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Opt in after authentication and before sending a response. This requires a
 * native Node HTTP/1 response without compression or deferred response wrappers.
 * Ordinary, unguarded responses keep the established Express behavior.
 */
export function guardAuthenticatedResponse(
  res: Response,
  guard: AuthenticatedResponseQueueGuard
): void {
  const queue = queues.get(res)
  ensure(queue !== undefined, 'A response queue guard requires an authenticated request.')
  queue.register(guard)
}

/** Internal transport attachment; not exported from the package entry point. */
export function bindAuthenticatedResponseQueue(
  res: Response,
  identityKey: string,
  requestId: string,
  maximumBodyBytes: number
): void {
  queues.set(res, new AuthenticatedResponseQueue(res, identityKey, requestId, maximumBodyBytes))
}

export function authenticatedResponseQueue(res: Response): AuthenticatedResponseQueue | undefined {
  const queue = queues.get(res)
  if (queue?.registered === true) return queue
  queue?.sealUnguarded()
  return undefined
}

/** Internal lifetime for one authenticated response, including one optional re-sign. */
export class AuthenticatedResponseQueue {
  private guard?: AuthenticatedResponseQueueGuard
  private readonly controller = new AbortController()
  private readonly wrapped: Map<string, unknown>
  private phase: 'ready' | 'signing' | 'checking' | 'queued' | 'closed' = 'ready'
  private current?: AuthenticatedResponseReplacement
  private attempt: 0 | 1 = 0
  private committed = false

  constructor(
    private readonly res: Response,
    private readonly identityKey: string,
    private readonly requestId: string,
    private readonly maximumBodyBytes: number
  ) {
    this.wrapped = new Map(transportMethods.map(name => [name, res[name]]))
  }
  get registered(): boolean {
    return this.guard !== undefined
  }
  get queued(): boolean {
    return this.committed
  }

  sealUnguarded(): void {
    this.phase = 'closed'
  }

  register(guard: AuthenticatedResponseQueueGuard): void {
    ensure(
      typeof guard === 'function' && this.guard === undefined && this.phase === 'ready',
      'The response queue guard must be installed exactly once before sending.'
    )
    this.checkTransport()
    this.guard = guard
    this.res.once('close', () => this.close())
  }
  private checkTransport(): void {
    const res = this.res
    ensure(
      res instanceof ServerResponse && res.req.httpVersionMajor === 1,
      'Guarded responses require native Node HTTP/1 transport.'
    )
    ensure(
      !res.headersSent && !res.writableEnded && !res.destroyed,
      'The guarded response is already closed or queued.'
    )
    for (const name of transportMethods) {
      const original = Reflect.get(res, `__${name}`)
      ensure(
        original === native[name] && res[name] === this.wrapped.get(name),
        'Guarded responses cannot use buffering or replacement transport methods.'
      )
    }
    for (const name of headerMethods)
      ensure(res[name] === native[name], 'Guarded responses require native HTTP header methods.')
  }
  private own(
    input: AuthenticatedResponseReplacement,
    replacement: boolean
  ): AuthenticatedResponseReplacement {
    ensure(
      input !== null && typeof input === 'object' && Object.keys(input).length === 3,
      'A guarded response requires status, headers and body.'
    )
    ensure(
      Number.isSafeInteger(input.statusCode) && input.statusCode >= 200 && input.statusCode <= 599,
      'Invalid guarded HTTP response status.'
    )
    ensure(input.body instanceof Uint8Array, 'Guarded response bodies must be bytes.')
    ensure(
      this.maximumBodyBytes === -1 || input.body.byteLength <= this.maximumBodyBytes,
      'Guarded response exceeds the configured body limit.'
    )
    ensure(
      input.headers !== null && typeof input.headers === 'object' && !Array.isArray(input.headers),
      'Invalid guarded response headers.'
    )
    const headers: Record<string, string> = Object.create(null) as Record<string, string>
    let bytes = input.body.byteLength
    for (const [key, value] of Object.entries(input.headers)) {
      ensure(typeof value === 'string', 'Guarded HTTP header values must be strings.')
      validateHeaderName(key)
      validateHeaderValue(key, value)
      const name = key.toLowerCase()
      ensure(!Object.hasOwn(headers, name), 'Duplicate guarded HTTP header.')
      ensure(!name.startsWith('x-bsv-auth-'), 'Authentication headers belong to the transport.')
      ensure(
        name !== 'transfer-encoding' && (name !== 'content-encoding' || value === 'identity'),
        'Guarded responses cannot defer body encoding or transfer framing.'
      )
      headers[name] = value
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    }
    ensure(!replacement || bytes <= 65536, 'Guarded response replacement exceeds 64 KiB.')
    ensure(
      !([204, 205, 304].includes(input.statusCode) || this.res.req.method === 'HEAD') ||
        input.body.byteLength === 0,
      'A bodyless guarded response cannot discard signed body bytes.'
    )
    return { statusCode: input.statusCode, headers, body: input.body.slice() }
  }
  prepare(
    input: AuthenticatedResponseReplacement,
    attempt: 0 | 1
  ): AuthenticatedResponseReplacement {
    ensure(
      this.phase === 'ready' && !this.controller.signal.aborted,
      'The response queue is not ready to sign.'
    )
    this.checkTransport()
    const owned = this.own(input, attempt === 1)
    this.current = owned
    this.attempt = attempt
    this.phase = 'signing'
    return { statusCode: owned.statusCode, headers: { ...owned.headers }, body: owned.body.slice() }
  }
  /** Bound signing and guard acquisition to the same transport cancellation. */
  async wait<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('The guarded response was cancelled.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      return await Promise.race([cancelled, work])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  async deliver(
    statusCode: number,
    signedHeaders: Record<string, string>,
    body: Uint8Array,
    restore: () => void
  ): Promise<AuthenticatedResponseReplacement | undefined> {
    ensure(
      this.phase === 'signing' && this.guard !== undefined && this.current !== undefined,
      'The response queue received an unexpected signed response.'
    )
    const current = this.current
    ensure(
      statusCode === current.statusCode && Buffer.from(body).equals(Buffer.from(current.body)),
      'The signed response differs from the retained candidate.'
    )
    const bytes = body.slice()
    const headers = { ...current.headers, ...signedHeaders }
    delete headers['content-length']
    if (![204, 304].includes(statusCode)) headers['content-length'] = String(bytes.byteLength)
    Object.freeze(headers)
    this.phase = 'checking'
    let active = true
    const enqueue = (): void => {
      ensure(
        active && this.phase === 'checking' && !this.controller.signal.aborted,
        'The response enqueue callback is no longer active.'
      )
      this.checkTransport()
      // The only operation under the application's final fence is the native
      // synchronous HTTP queue. Encoding and BRC-104 signing have already finished.
      restore()
      for (const name of transportMethods)
        ensure(this.res[name] === native[name], 'Native response restoration failed.')
      this.committed = true
      this.phase = 'queued'
      for (const name of this.res.getHeaderNames()) this.res.removeHeader(name)
      for (const [name, value] of Object.entries(headers)) this.res.setHeader(name, value)
      this.res.writeHead(statusCode)
      this.res.end(Buffer.from(bytes))
    }
    try {
      const candidate = Object.freeze({
        statusCode,
        headers: { ...headers },
        body: bytes.slice(),
        identityKey: this.identityKey,
        requestId: this.requestId,
        attempt: this.attempt
      })
      const replacement = await this.wait(
        Promise.resolve(this.guard(candidate, enqueue, this.controller.signal))
      )
      if (this.committed) {
        ensure(replacement === undefined, 'A queued response cannot also be replaced.')
        return undefined
      }
      ensure(
        replacement !== undefined && this.attempt === 0,
        'The guard must enqueue or provide one bounded replacement.'
      )
      const next = this.own(replacement, true)
      this.phase = 'ready'
      return next
    } finally {
      active = false
      this.current = undefined
    }
  }
  close(): void {
    this.phase = 'closed'
    this.current = undefined
    this.controller.abort()
    if (!this.res.writableFinished) this.res.destroy()
  }
}
