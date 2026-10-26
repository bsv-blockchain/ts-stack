/**
 * Client for Arcade transaction status updates.
 *
 * Uses react-native-sse EventSource to connect to Arcade's
 * `GET /events?callbackToken=<token>` endpoint for real-time status updates.
 */

import { containsControlCharacter, safeDiagnostic } from '../chaintracker/chaintracks/util/safeDiagnostic'

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_PENDING_EVENTS = 64
const MAX_PENDING_EVENTS = 4096
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_PENDING_BYTES = 64 * 1024 * 1024

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  )
}

function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

function normalizeArcadeBaseUrl(baseUrl: string): string {
  if (baseUrl.length === 0 || baseUrl.length > 2048 || containsControlCharacter(baseUrl)) {
    throw new TypeError('Arcade SSE base URL must be a bounded absolute URL.')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new TypeError('Arcade SSE base URL must be absolute.')
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('Arcade SSE base URL cannot include credentials, query, or fragment.')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new TypeError('Arcade SSE base URL requires HTTPS except on localhost.')
  }
  parsed.pathname = trimTrailingSlashes(parsed.pathname)
  return trimTrailingSlashes(parsed.toString())
}

export interface ArcSSEEvent {
  txid: string
  txStatus: string
  timestamp: string
  /** Transport cursor attached by ArcSSEClient; not part of Arcade's JSON payload. */
  eventId?: string
  /** ARC rejection code supplied by Arcade for classifiable REJECTED events. */
  status?: number
  /** Arcade's validator or network rejection detail. */
  extraInfo?: string
  blockHash?: string
  blockHeight?: number
  merklePath?: string
}

export interface ArcSSEClientOptions {
  /** Base URL of the Arcade instance (e.g. "https://arcade-us-1.bsvb.tech") */
  baseUrl: string
  /** Stable per-wallet token matching the X-CallbackToken sent on broadcast */
  callbackToken: string
  /** Server-level API key for Authorization header (from ArcConfig.apiKey) */
  arcApiKey?: string
  /** Called for each status event received; resolution acknowledges durable processing. */
  onEvent: (event: ArcSSEEvent) => void | Promise<void>
  /** Called when a connection or processing error occurs. Callback failures are contained. */
  onError?: (error: Error) => void | Promise<void>
  /** Initial lastEventId for catchup */
  lastEventId?: string
  /** Called after event processing and before lastEventId advances. */
  onLastEventIdChanged?: (lastEventId: string) => void | Promise<void>
  /** Maximum UTF-8 bytes admitted for one status event. Default: 262144; maximum: 8388608. */
  maxEventBytes?: number
  /** Maximum received events retained while earlier work commits. Default: 64; maximum: 4096. */
  maxPendingEvents?: number
  /** Maximum aggregate bytes retained while earlier work commits. Default: 4194304; maximum: 67108864. */
  maxPendingBytes?: number
  /** Optional fixed-message operational logger. The client is silent by default. */
  log?: (message: string) => void
  /** The react-native-sse EventSource class — passed in to avoid import from wallet-toolbox */
  EventSourceClass: any
}

interface NormalizedArcSSEClientOptions {
  callbackToken: string
  arcApiKey?: string
  onEvent: (event: ArcSSEEvent) => void | Promise<void>
  onError?: (error: Error) => void | Promise<void>
  onLastEventIdChanged?: (lastEventId: string) => void | Promise<void>
  maxEventBytes: number
  maxPendingEvents: number
  maxPendingBytes: number
  log?: (message: string) => void
  EventSourceClass: any
}

interface PendingEvent {
  event: ArcSSEEvent
  bytes: number
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError(`Arcade SSE ${key} must be a data property.`)
  return descriptor.value
}

function boundedUtf8Length(value: string, maximum: number): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index)
    if (first <= 0x7f) bytes += 1
    else if (first <= 0x7ff) bytes += 2
    else if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
    if (bytes > maximum) return bytes
  }
  return bytes
}

function normalizeBoundedString(
  value: unknown,
  name: string,
  maximum: number,
  options: { optional?: boolean; empty?: boolean } = {}
): string | undefined {
  if (value == null && options.optional === true) return undefined
  if (
    typeof value !== 'string' ||
    (value.length === 0 && options.empty !== true) ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`Arcade SSE ${name} must be a bounded control-free string.`)
  }
  return value
}

function normalizeLimit(value: unknown, name: string, defaultValue: number, maximum: number): number {
  const result = value ?? defaultValue
  if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > maximum) {
    throw new TypeError(`Arcade SSE ${name} must be an integer from 1 through ${maximum}.`)
  }
  return result as number
}

function normalizeOptions(options: ArcSSEClientOptions): {
  options: NormalizedArcSSEClientOptions
  baseUrl: string
  lastEventId?: string
} {
  if (
    options == null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  ) {
    throw new TypeError('Arcade SSE options must be a plain data object.')
  }
  const baseUrl = normalizeArcadeBaseUrl(
    normalizeBoundedString(ownDataValue(options, 'baseUrl'), 'base URL', 2048) as string
  )
  const callbackToken = normalizeBoundedString(ownDataValue(options, 'callbackToken'), 'callback token', 1024) as string
  const arcApiKey = normalizeBoundedString(ownDataValue(options, 'arcApiKey'), 'API key', 4096, { optional: true })
  const lastEventId = normalizeBoundedString(ownDataValue(options, 'lastEventId'), 'last event ID', 256, {
    optional: true
  })
  const onEvent = ownDataValue(options, 'onEvent')
  const onError = ownDataValue(options, 'onError')
  const onLastEventIdChanged = ownDataValue(options, 'onLastEventIdChanged')
  const log = ownDataValue(options, 'log')
  const EventSourceClass = ownDataValue(options, 'EventSourceClass')
  if (typeof onEvent !== 'function') throw new TypeError('Arcade SSE onEvent must be callable.')
  if (onError != null && typeof onError !== 'function') throw new TypeError('Arcade SSE onError must be callable.')
  if (onLastEventIdChanged != null && typeof onLastEventIdChanged !== 'function') {
    throw new TypeError('Arcade SSE onLastEventIdChanged must be callable.')
  }
  if (log != null && typeof log !== 'function') throw new TypeError('Arcade SSE log must be callable.')
  if (typeof EventSourceClass !== 'function') throw new TypeError('Arcade SSE EventSourceClass must be constructable.')
  const maxEventBytes = normalizeLimit(
    ownDataValue(options, 'maxEventBytes'),
    'maxEventBytes',
    DEFAULT_MAX_EVENT_BYTES,
    MAX_EVENT_BYTES
  )
  const maxPendingEvents = normalizeLimit(
    ownDataValue(options, 'maxPendingEvents'),
    'maxPendingEvents',
    DEFAULT_MAX_PENDING_EVENTS,
    MAX_PENDING_EVENTS
  )
  const maxPendingBytes = normalizeLimit(
    ownDataValue(options, 'maxPendingBytes'),
    'maxPendingBytes',
    DEFAULT_MAX_PENDING_BYTES,
    MAX_PENDING_BYTES
  )
  return {
    baseUrl,
    lastEventId,
    options: Object.freeze({
      callbackToken,
      arcApiKey,
      onEvent: onEvent as NormalizedArcSSEClientOptions['onEvent'],
      onError: onError as NormalizedArcSSEClientOptions['onError'],
      onLastEventIdChanged: onLastEventIdChanged as NormalizedArcSSEClientOptions['onLastEventIdChanged'],
      maxEventBytes,
      maxPendingEvents,
      maxPendingBytes,
      log: log as NormalizedArcSSEClientOptions['log'],
      EventSourceClass
    })
  }
}

function optionalPayloadString(record: object, key: string, maximum: number): string | undefined {
  const value = ownDataValue(record, key)
  if (value == null) return undefined
  return normalizeBoundedString(value, `event ${key}`, maximum, { empty: true })
}

function normalizeStatusEvent(value: unknown, eventId: string | undefined): ArcSSEEvent {
  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError('Arcade SSE status payload must be a plain data object.')
  }
  const txid = normalizeBoundedString(ownDataValue(value, 'txid'), 'event txid', 64) as string
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new TypeError('Arcade SSE event txid must be 32-byte hexadecimal.')
  const txStatus = normalizeBoundedString(ownDataValue(value, 'txStatus'), 'event status', 64) as string
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(txStatus)) {
    throw new TypeError('Arcade SSE event status must be a bounded uppercase status token.')
  }
  const timestamp = normalizeBoundedString(ownDataValue(value, 'timestamp'), 'event timestamp', 128, {
    empty: true
  }) as string
  const statusValue = ownDataValue(value, 'status')
  let status: number | undefined
  if (statusValue != null) {
    if (!Number.isSafeInteger(statusValue) || (statusValue as number) < 0 || (statusValue as number) > 999) {
      throw new TypeError('Arcade SSE event status code must be an integer from 0 through 999.')
    }
    status = statusValue as number
  }
  const blockHashValue = optionalPayloadString(value, 'blockHash', 64)
  let blockHash: string | undefined
  if (blockHashValue != null) {
    if (!/^[0-9a-fA-F]{64}$/.test(blockHashValue)) {
      throw new TypeError('Arcade SSE event blockHash must be 32-byte hexadecimal.')
    }
    blockHash = blockHashValue.toLowerCase()
  }
  const blockHeightValue = ownDataValue(value, 'blockHeight')
  let blockHeight: number | undefined
  if (blockHeightValue != null) {
    if (
      !Number.isSafeInteger(blockHeightValue) ||
      (blockHeightValue as number) < 0 ||
      (blockHeightValue as number) > 0xffffffff
    ) {
      throw new TypeError('Arcade SSE event blockHeight must be an unsigned 32-bit integer.')
    }
    blockHeight = blockHeightValue as number
  }
  const extraInfoValue = optionalPayloadString(value, 'extraInfo', 4096)
  const extraInfo = extraInfoValue == null ? undefined : safeDiagnostic(extraInfoValue, 4096)
  const merklePath = optionalPayloadString(value, 'merklePath', DEFAULT_MAX_EVENT_BYTES)
  return {
    txid: txid.toLowerCase(),
    txStatus,
    timestamp,
    ...(eventId == null ? {} : { eventId }),
    ...(status == null ? {} : { status }),
    ...(extraInfo == null ? {} : { extraInfo }),
    ...(blockHash == null ? {} : { blockHash }),
    ...(blockHeight == null ? {} : { blockHeight }),
    ...(merklePath == null ? {} : { merklePath })
  }
}

function readEventData(event: unknown, key: string): unknown {
  if (event == null || (typeof event !== 'object' && typeof event !== 'function')) return undefined
  try {
    return ownDataValue(event as object, key)
  } catch {
    return undefined
  }
}

export class ArcSSEClient {
  private _lastEventId: string | undefined
  private es: any = null
  private readonly url: string
  private readonly options: NormalizedArcSSEClientOptions
  private connected = false
  private connecting = false
  private generation = 0
  private processingGeneration: number | undefined
  private readonly pendingEvents: PendingEvent[] = []
  private pendingBytes = 0

  constructor(options: ArcSSEClientOptions) {
    const normalized = normalizeOptions(options)
    this.options = normalized.options
    this._lastEventId = normalized.lastEventId
    this.url = `${normalized.baseUrl}/events?callbackToken=${encodeURIComponent(this.options.callbackToken)}`
  }

  get lastEventId(): string | undefined {
    return this._lastEventId
  }

  /** Open the SSE connection. Events are processed serially in exact arrival order. */
  connect(): void {
    if (this.es != null || this.processingGeneration != null) return

    this.connecting = true
    const headers: Record<string, string> = {
      'Last-Event-ID': this._lastEventId ?? '0'
    }
    if (this.options.arcApiKey != null) headers.Authorization = `Bearer ${this.options.arcApiKey}`

    let source: any
    const generation = ++this.generation
    try {
      source = new this.options.EventSourceClass(this.url, {
        headers,
        // Third-party debug output can include the URL token and Authorization header.
        debug: false,
        pollingInterval: 0
      })
      if (source == null || typeof source.addEventListener !== 'function' || typeof source.close !== 'function') {
        throw new TypeError('Invalid EventSource instance.')
      }
      this.es = source
      source.addEventListener('open', () => {
        if (this.es !== source || this.generation !== generation) return
        this.connected = true
        this.connecting = false
        this.emitLog('Arcade SSE connected.')
      })
      source.addEventListener('status', (event: unknown) => {
        if (this.es !== source || this.generation !== generation) return
        this.receiveStatusEvent(event, generation)
      })
      source.addEventListener('error', (event: unknown) => {
        if (this.es !== source || this.generation !== generation) return
        // Error objects can contain the credential-bearing request URL and
        // headers. Do not inspect or forward remote diagnostic fields.
        void event
        this.terminateSource(source, new Error('Arcade SSE connection error.'), true)
      })
      this.emitLog('Arcade SSE connecting.')
    } catch {
      if (source != null) {
        try {
          source.close?.()
        } catch {
          // The state reset below remains authoritative.
        }
      }
      if (this.es === source) this.es = null
      this.connected = false
      this.connecting = false
      this.generation += 1
      throw new Error('Unable to initialize Arcade SSE connection.')
    }
  }

  private receiveStatusEvent(event: unknown, generation: number): void {
    try {
      const rawData = readEventData(event, 'data')
      if (typeof rawData !== 'string' || rawData.length > this.options.maxEventBytes) {
        throw new TypeError('Arcade SSE event exceeded its character limit or was not text.')
      }
      const bytes = boundedUtf8Length(rawData, this.options.maxEventBytes)
      if (bytes > this.options.maxEventBytes) throw new TypeError('Arcade SSE event exceeded its byte limit.')
      const rawEventId = readEventData(event, 'lastEventId')
      const eventId =
        rawEventId == null || rawEventId === ''
          ? undefined
          : normalizeBoundedString(rawEventId, 'event last event ID', 256)
      const normalized = normalizeStatusEvent(JSON.parse(rawData) as unknown, eventId)
      if (
        this.pendingEvents.length >= this.options.maxPendingEvents ||
        this.pendingBytes + bytes > this.options.maxPendingBytes
      ) {
        throw new Error('Arcade SSE pending-event capacity was exceeded.')
      }
      this.pendingEvents.push({ event: normalized, bytes })
      this.pendingBytes += bytes
      this.startDrain(generation)
    } catch {
      if (this.es != null) {
        this.terminateSource(this.es, new Error('Arcade SSE supplied an invalid or excessive status event.'), true)
      }
    }
  }

  private startDrain(generation: number): void {
    if (this.processingGeneration != null) return
    this.processingGeneration = generation
    void this.drainEvents(generation).finally(() => {
      if (this.processingGeneration === generation) this.processingGeneration = undefined
      if (this.es != null && this.pendingEvents.length > 0) this.startDrain(this.generation)
    })
  }

  private async drainEvents(generation: number): Promise<void> {
    while (this.generation === generation && this.es != null && this.pendingEvents.length > 0) {
      const pending = this.pendingEvents[0]
      try {
        await this.options.onEvent({ ...pending.event })
        if (this.generation !== generation || this.es == null) return
        const eventId = pending.event.eventId
        if (eventId != null) {
          await this.options.onLastEventIdChanged?.(eventId)
          if (this.generation !== generation || this.es == null) return
          this._lastEventId = eventId
        }
        if (this.pendingEvents[0] !== pending) return
        this.pendingEvents.shift()
        this.pendingBytes -= pending.bytes
      } catch (error) {
        if (this.es != null) {
          this.terminateSource(
            this.es,
            error instanceof Error ? error : new Error('Arcade SSE event processing failed.'),
            true
          )
        }
        return
      }
    }
  }

  private terminateSource(source: any, error: Error, notify: boolean): void {
    if (this.es !== source) return
    this.es = null
    this.connected = false
    this.connecting = false
    this.generation += 1
    this.pendingEvents.length = 0
    this.pendingBytes = 0
    try {
      source.close()
    } catch {
      // State has already been reset; a hostile close method cannot retain it.
    }
    if (notify) this.reportError(error)
  }

  private reportError(error: Error): void {
    this.emitLog('Arcade SSE connection or event processing failed.')
    if (this.options.onError == null) return
    try {
      void Promise.resolve(this.options.onError(error)).catch(() => this.emitLog('Arcade SSE error callback failed.'))
    } catch {
      this.emitLog('Arcade SSE error callback failed.')
    }
  }

  private emitLog(message: string): void {
    if (this.options.log == null) return
    try {
      this.options.log(message)
    } catch {
      // Observability hooks never control the event lifecycle.
    }
  }

  /** Close the connection, discard unacknowledged network events, and reset lifecycle state. */
  close(): void {
    if (this.es != null) {
      this.terminateSource(this.es, new Error('Arcade SSE client closed.'), false)
    } else {
      this.connected = false
      this.connecting = false
      this.generation += 1
      this.pendingEvents.length = 0
      this.pendingBytes = 0
    }
  }

  /** Ensure a connection is open; events still commit asynchronously in arrival order. */
  async fetchEvents(): Promise<number> {
    if (this.es == null && !this.connecting && this.processingGeneration == null) {
      this.connect()
    } else if (this.es != null && !this.connected && !this.connecting) {
      this.close()
      this.connect()
    }
    return 0
  }
}
