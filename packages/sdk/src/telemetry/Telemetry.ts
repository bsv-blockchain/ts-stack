import Random from '../primitives/Random.js'
import { toHex } from '../primitives/utils.js'

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error'

export type TelemetryAttributeValue = string | number | boolean
export type TelemetryEventType = 'event' | 'span'
export type TelemetrySpanKind = 'internal' | 'client' | 'server'
export type TelemetrySpanStatus = 'ok' | 'error' | 'cancelled'

export interface TelemetrySpanContext {
  traceId: string
  spanId: string
  traceFlags?: number
}

export interface TelemetryError {
  name: string
  message: string
  code?: string
  stack?: string
}

/**
 * A privacy-bounded event delivered to a consumer-provided telemetry sink.
 *
 * Attributes are deliberately limited to scalar values. Library code must
 * report operational metadata (counts, durations, result categories), never
 * request payloads, wallet snapshots, keys, secrets, or encrypted material.
 */
export interface TelemetryEvent {
  name: string
  component: string
  severity: TelemetrySeverity
  timestamp: number
  type?: TelemetryEventType
  correlationId?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  spanKind?: TelemetrySpanKind
  spanStatus?: TelemetrySpanStatus
  startTimestamp?: number
  durationMs?: number
  attributes?: Readonly<Record<string, TelemetryAttributeValue>>
  error?: TelemetryError
}

export interface TelemetryEventInput {
  name: string
  component: string
  severity?: TelemetrySeverity
  type?: TelemetryEventType
  correlationId?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  spanKind?: TelemetrySpanKind
  spanStatus?: TelemetrySpanStatus
  startTimestamp?: number
  durationMs?: number
  attributes?: Readonly<Record<string, unknown>>
  error?: unknown
}

/**
 * Generic integration point for Sentry, OpenTelemetry, crash reporters, or a
 * consumer's own support-event pipeline.
 */
export interface TelemetrySink {
  capture: (event: Readonly<TelemetryEvent>) => void | Promise<void>
}

/**
 * Optional host integration for asynchronous span context propagation.
 *
 * Node applications can adapt AsyncLocalStorage. Browser and React Native
 * consumers can instead use the explicit carrier helpers on `Telemetry`.
 */
export interface TelemetryContextManager {
  active: () => TelemetrySpanContext | undefined
  run: <T>(context: TelemetrySpanContext, callback: () => T) => T
}

/**
 * Optional runtime sampler. Counter and gauge semantics are host-defined; the
 * provider returns the already-derived, privacy-safe attributes to append to a
 * completed span.
 */
export interface TelemetryRuntimeMetrics {
  snapshot: () => unknown
  diff: (start: unknown, end: unknown) => Readonly<Record<string, TelemetryAttributeValue>>
}

export interface TelemetryConfig {
  /**
   * No events are emitted unless a sink is supplied and this is true. A
   * predicate lets long-lived hosts honor a diagnostics preference without
   * reconstructing every instrumented component.
   */
  sink?: TelemetrySink
  enabled?: boolean | (() => boolean)
  minimumSeverity?: TelemetrySeverity
  /** Error stacks are omitted by default. Enable only for a trusted sink. */
  includeErrorStack?: boolean
  /** Injectable clock for tests and host applications. */
  now?: () => number
  /** Monotonic high-resolution clock used for span durations. */
  highResolutionNow?: () => number
  /** Injectable correlation-id factory for distributed tracing. */
  correlationIdFactory?: () => string
  /** Injectable trace-id factory. Must return 32 lowercase hexadecimal characters. */
  traceIdFactory?: () => string
  /** Injectable span-id factory. Must return 16 lowercase hexadecimal characters. */
  spanIdFactory?: () => string
  /** Optional async context propagation supplied by the host runtime. */
  contextManager?: TelemetryContextManager
  /** Optional CPU, GC, heap, and event-loop sampler supplied by the host runtime. */
  runtimeMetrics?: TelemetryRuntimeMetrics
  /**
   * Last-mile event filtering or enrichment. The returned event is sanitized
   * again, so enrichment cannot bypass the secret-redaction boundary.
   */
  beforeSend?: (event: Readonly<TelemetryEvent>) => TelemetryEvent | null | undefined
}

export interface TelemetrySpanOptions {
  component: string
  kind?: TelemetrySpanKind
  parent?: TelemetrySpanContext
  carrier?: object
  correlationId?: string
  attributes?: Readonly<Record<string, unknown>>
}

export interface TelemetrySpanEndOptions {
  status?: TelemetrySpanStatus
  severity?: TelemetrySeverity
  attributes?: Readonly<Record<string, unknown>>
  error?: unknown
}

const REDACTED = '[REDACTED]'
const MAX_ATTRIBUTES = 64
const MAX_ATTRIBUTE_LENGTH = 512
const MAX_ERROR_LENGTH = 2048
const MAX_STACK_LENGTH = 8192
let fallbackCorrelationSequence = 0
const carrierContexts = new WeakMap<object, TelemetrySpanContext>()
const synchronousContextStack: TelemetrySpanContext[] = []

const SENSITIVE_TERMS = [
  'password',
  'passphrase',
  'privatekey',
  'presentationkey',
  'recoverykey',
  'snapshot',
  'mnemonic',
  'seed',
  'secret',
  'shamir',
  'share',
  'ciphertext',
  'plaintext',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'bearer',
  'otp',
  'onetime',
  'pin'
] as const

const SENSITIVE_LABEL_PATTERNS = SENSITIVE_TERMS.map(term => {
  const flexibleTerm = term.replace(/key|token|time/g, match => `[_ -]?${match}`)
  return new RegExp(String.raw`(${flexibleTerm}\s*["'=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)`, 'gi')
})

const BEARER_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]+/gi
const WIF_PRIVATE_KEY = /\b[KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g
const EXTENDED_PRIVATE_KEY = /\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]+\b/g
const HEX_256_BIT_VALUE = /\b[0-9a-fA-F]{64}\b/g
const LARGE_ENCODED_BLOB = /\b[A-Za-z0-9+/=_-]{128,}\b/g
const BYTE_VALUE = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)`
const SERIALIZED_BYTE_ARRAY = new RegExp(
  String.raw`\[(?:\s*${BYTE_VALUE}\s*,){15,}\s*${BYTE_VALUE}\s*\]`,
  'g'
)

const severityRank: Record<TelemetrySeverity, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

/**
 * Removes common secret encodings from diagnostic text. Unlabelled 256-bit
 * hex values are redacted because they may be private or presentation keys.
 */
export function sanitizeTelemetryText(value: string, maxLength: number = MAX_ERROR_LENGTH): string {
  // Bound sanitizer work before applying regular expressions. Any suffix past
  // this window cannot reach the emitted value, even after redaction.
  const bounded = value.slice(0, Math.max(maxLength * 2, maxLength + 256))
  const labelsRedacted = SENSITIVE_LABEL_PATTERNS.reduce(
    (sanitized, pattern) => sanitized.replace(pattern, '$1[REDACTED]'),
    bounded
  )
  return truncate(
    labelsRedacted
      .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
      .replace(WIF_PRIVATE_KEY, REDACTED)
      .replace(EXTENDED_PRIVATE_KEY, REDACTED)
      .replace(HEX_256_BIT_VALUE, REDACTED)
      .replace(LARGE_ENCODED_BLOB, REDACTED)
      .replace(SERIALIZED_BYTE_ARRAY, REDACTED),
    maxLength
  )
}

function sanitizeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  return truncate(value.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_'), 160)
}

function sanitizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return truncate(value.replace(/[^a-zA-Z0-9_.:-]/g, '_'), 128)
}

function sanitizeTraceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(normalized) || /^0{32}$/.test(normalized)) return undefined
  return normalized
}

function sanitizeSpanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(normalized) || /^0{16}$/.test(normalized)) return undefined
  return normalized
}

function sanitizeDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sanitizeAttributeValue(name: string, value: unknown): TelemetryAttributeValue | undefined {
  const normalizedName = name.toLowerCase().replaceAll(/[_ .-]/g, '')
  if (SENSITIVE_TERMS.some(term => normalizedName.includes(term))) return REDACTED
  if (typeof value === 'string') return sanitizeTelemetryText(value, MAX_ATTRIBUTE_LENGTH)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined) return undefined
  return REDACTED
}

function sanitizeAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, TelemetryAttributeValue>> | undefined {
  if (attributes == null) return undefined
  const safe: Record<string, TelemetryAttributeValue> = {}
  let count = 0
  for (const [rawName, value] of Object.entries(attributes)) {
    if (count >= MAX_ATTRIBUTES) break
    const name = sanitizeName(rawName, '')
    if (name.length === 0) continue
    const sanitized = sanitizeAttributeValue(name, value)
    if (sanitized === undefined) continue
    safe[name] = sanitized
    count++
  }
  return count > 0 ? safe : undefined
}

function sanitizeError(error: unknown, includeStack: boolean): TelemetryError | undefined {
  if (error == null) return undefined
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown }
    const code =
      typeof withCode.code === 'string' ? sanitizeTelemetryText(withCode.code, 120) : undefined
    const stack =
      includeStack && typeof error.stack === 'string'
        ? sanitizeTelemetryText(error.stack, MAX_STACK_LENGTH)
        : undefined
    return {
      name: sanitizeName(error.name, 'Error'),
      message: sanitizeTelemetryText(error.message.length > 0 ? error.message : 'Unknown error'),
      ...(code !== undefined ? { code } : {}),
      ...(stack !== undefined ? { stack } : {})
    }
  }
  if (typeof error === 'object') {
    const candidate = error as {
      name?: unknown
      message?: unknown
      code?: unknown
      stack?: unknown
    }
    const code =
      typeof candidate.code === 'string' ? sanitizeTelemetryText(candidate.code, 120) : undefined
    const stack =
      includeStack && typeof candidate.stack === 'string'
        ? sanitizeTelemetryText(candidate.stack, MAX_STACK_LENGTH)
        : undefined
    return {
      name: sanitizeName(candidate.name, 'Error'),
      message: sanitizeTelemetryText(
        typeof candidate.message === 'string' && candidate.message.length > 0
          ? candidate.message
          : 'Unknown error'
      ),
      ...(code !== undefined ? { code } : {}),
      ...(stack !== undefined ? { stack } : {})
    }
  }
  return {
    name: 'Error',
    message: sanitizeTelemetryText(typeof error === 'string' ? error : 'Unknown error')
  }
}

function sanitizeEvent(
  event: TelemetryEventInput | TelemetryEvent,
  now: () => number,
  includeErrorStack: boolean
): TelemetryEvent {
  const severity = event.severity ?? 'info'
  const correlationId = sanitizeCorrelationId(event.correlationId)
  const traceId = sanitizeTraceId(event.traceId)
  const spanId = sanitizeSpanId(event.spanId)
  const parentSpanId = sanitizeSpanId(event.parentSpanId)
  const startTimestamp = sanitizeDuration(event.startTimestamp)
  const durationMs = sanitizeDuration(event.durationMs)
  const attributes = sanitizeAttributes(event.attributes)
  const error = sanitizeError(event.error, includeErrorStack)
  return {
    name: sanitizeName(event.name, 'unknown'),
    component: sanitizeName(event.component, 'unknown'),
    severity,
    timestamp:
      typeof (event as TelemetryEvent).timestamp === 'number' &&
      Number.isFinite((event as TelemetryEvent).timestamp)
        ? (event as TelemetryEvent).timestamp
        : now(),
    ...(event.type === 'span' || event.type === 'event' ? { type: event.type } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(spanId !== undefined ? { spanId } : {}),
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    ...(event.spanKind === 'internal' || event.spanKind === 'client' || event.spanKind === 'server'
      ? { spanKind: event.spanKind }
      : {}),
    ...(event.spanStatus === 'ok' ||
    event.spanStatus === 'error' ||
    event.spanStatus === 'cancelled'
      ? { spanStatus: event.spanStatus }
      : {}),
    ...(startTimestamp !== undefined ? { startTimestamp } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(error !== undefined ? { error } : {})
  }
}

function defaultHighResolutionNow(): number {
  const perf = globalThis.performance
  return perf != null && typeof perf.now === 'function' ? perf.now() : Date.now()
}

function randomTraceId(): string {
  return toHex(Random(16))
}

function randomSpanId(): string {
  return toHex(Random(8))
}

function mergeAttributes(
  first: Readonly<Record<string, unknown>> | undefined,
  second: Readonly<Record<string, unknown>> | undefined,
  third: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (first == null && second == null && third == null) return undefined
  return {
    ...first,
    ...second,
    ...third
  }
}

/**
 * A single timed operation. Ending a span is idempotent and cannot throw.
 */
export class TelemetrySpan {
  readonly context: TelemetrySpanContext
  readonly parentSpanId?: string

  private readonly startedAt: number
  private readonly startedAtHighResolution: number
  private readonly runtimeStart: unknown
  private ended = false

  constructor(
    private readonly telemetry: Telemetry,
    readonly name: string,
    readonly component: string,
    readonly kind: TelemetrySpanKind,
    parent: TelemetrySpanContext | undefined,
    private readonly correlationId: string,
    private readonly initialAttributes?: Readonly<Record<string, unknown>>
  ) {
    const now = telemetry.wallClock()
    this.startedAt = now()
    this.startedAtHighResolution = telemetry.monotonicClock()()
    this.context = {
      traceId: parent?.traceId ?? telemetry.createTraceId(),
      spanId: telemetry.createSpanId(),
      ...(parent?.traceFlags !== undefined ? { traceFlags: parent.traceFlags } : {})
    }
    this.parentSpanId = parent?.spanId
    this.runtimeStart = telemetry.runtimeSnapshot()
  }

  bind(carrier: object): void {
    this.telemetry.bindContext(carrier, this.context)
  }

  child(name: string, options: Omit<TelemetrySpanOptions, 'parent'>): TelemetrySpan {
    return this.telemetry.startSpan(name, {
      ...options,
      parent: this.context,
      correlationId: options.correlationId ?? this.correlationId
    })
  }

  capture(
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    severity: TelemetrySeverity = 'info'
  ): void {
    this.telemetry.capture({
      name,
      component: this.component,
      severity,
      type: 'event',
      correlationId: this.correlationId,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      attributes
    })
  }

  end(options: TelemetrySpanEndOptions = {}): void {
    if (this.ended) return
    this.ended = true

    const runtimeAttributes = this.telemetry.runtimeDiff(
      this.runtimeStart,
      this.telemetry.runtimeSnapshot()
    )
    const durationMs = Math.max(0, this.telemetry.monotonicClock()() - this.startedAtHighResolution)
    const status = options.status ?? (options.error == null ? 'ok' : 'error')
    this.telemetry.capture({
      name: this.name,
      component: this.component,
      severity: options.severity ?? (status === 'error' ? 'error' : 'info'),
      type: 'span',
      correlationId: this.correlationId,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentSpanId,
      spanKind: this.kind,
      spanStatus: status,
      startTimestamp: this.startedAt,
      durationMs,
      attributes: mergeAttributes(this.initialAttributes, runtimeAttributes, options.attributes),
      error: options.error
    })
  }
}

/**
 * Safe, no-op-by-default telemetry dispatcher.
 *
 * Consumer sink and beforeSend failures are intentionally isolated from wallet
 * and network behavior. `capture` never throws and never returns a rejecting
 * promise.
 */
export class Telemetry {
  private readonly config: TelemetryConfig

  constructor(config: TelemetryConfig = {}) {
    this.config = config
  }

  get enabled(): boolean {
    if (this.config.sink == null) return false
    if (typeof this.config.enabled !== 'function') return this.config.enabled !== false
    try {
      return this.config.enabled()
    } catch {
      return false
    }
  }

  wallClock(): () => number {
    return this.config.now ?? Date.now
  }

  monotonicClock(): () => number {
    return this.config.highResolutionNow ?? defaultHighResolutionNow
  }

  createCorrelationId(): string {
    try {
      const custom = this.config.correlationIdFactory?.()
      if (typeof custom === 'string' && custom.length > 0) {
        return sanitizeCorrelationId(custom) ?? toHex(Random(16))
      }
      return toHex(Random(16))
    } catch {
      fallbackCorrelationSequence = (fallbackCorrelationSequence + 1) % Number.MAX_SAFE_INTEGER
      return `${Date.now().toString(36)}-${fallbackCorrelationSequence.toString(36)}`
    }
  }

  createTraceId(): string {
    try {
      const custom = sanitizeTraceId(this.config.traceIdFactory?.())
      return custom ?? randomTraceId()
    } catch {
      return randomTraceId()
    }
  }

  createSpanId(): string {
    try {
      const custom = sanitizeSpanId(this.config.spanIdFactory?.())
      return custom ?? randomSpanId()
    } catch {
      return randomSpanId()
    }
  }

  activeContext(): TelemetrySpanContext | undefined {
    try {
      return (
        this.config.contextManager?.active() ??
        synchronousContextStack[synchronousContextStack.length - 1]
      )
    } catch {
      return synchronousContextStack[synchronousContextStack.length - 1]
    }
  }

  contextFor(carrier: object | undefined): TelemetrySpanContext | undefined {
    if (carrier == null) return undefined
    return carrierContexts.get(carrier)
  }

  bindContext(carrier: object, context: TelemetrySpanContext): void {
    carrierContexts.set(carrier, context)
  }

  linkContext(source: object | undefined, target: object | undefined): void {
    if (source == null || target == null) return
    const context = this.contextFor(source)
    if (context != null) this.bindContext(target, context)
  }

  startSpan(name: string, options: TelemetrySpanOptions): TelemetrySpan {
    const parent = options.parent ?? this.contextFor(options.carrier) ?? this.activeContext()
    const correlationId = options.correlationId ?? parent?.traceId ?? this.createCorrelationId()
    const span = new TelemetrySpan(
      this,
      name,
      options.component,
      options.kind ?? 'internal',
      parent,
      correlationId,
      options.attributes
    )
    if (options.carrier != null) span.bind(options.carrier)
    return span
  }

  withSpan<T>(
    name: string,
    options: TelemetrySpanOptions,
    callback: (span: TelemetrySpan) => T
  ): T {
    const span = this.startSpan(name, options)
    const invoke = (): T => callback(span)
    let result: T
    try {
      if (this.config.contextManager != null) {
        result = this.config.contextManager.run(span.context, invoke)
      } else {
        synchronousContextStack.push(span.context)
        try {
          result = invoke()
        } finally {
          synchronousContextStack.pop()
        }
      }
    } catch (error) {
      span.end({ status: 'error', error })
      throw error
    }

    if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(result as PromiseLike<unknown>).then(
        value => {
          span.end()
          return value
        },
        error => {
          span.end({ status: 'error', error })
          throw error
        }
      ) as T
    }

    span.end()
    return result
  }

  runtimeSnapshot(): unknown {
    try {
      return this.config.runtimeMetrics?.snapshot()
    } catch {
      return undefined
    }
  }

  runtimeDiff(
    start: unknown,
    end: unknown
  ): Readonly<Record<string, TelemetryAttributeValue>> | undefined {
    try {
      return this.config.runtimeMetrics?.diff(start, end)
    } catch {
      return undefined
    }
  }

  capture(input: TelemetryEventInput): void {
    if (!this.enabled) return
    const minimum = this.config.minimumSeverity ?? 'info'
    const severity = input.severity ?? 'info'
    if (severityRank[severity] < severityRank[minimum]) return

    const now = this.config.now ?? Date.now
    const includeStack = this.config.includeErrorStack === true
    let event = sanitizeEvent(input, now, includeStack)
    try {
      const transformed = this.config.beforeSend?.(event)
      if (transformed === null) return
      // Re-sanitize even when the hook returns undefined. TypeScript readonly
      // types do not prevent a JavaScript consumer from mutating the supplied
      // object in place.
      event = sanitizeEvent(transformed ?? event, now, includeStack)
    } catch {
      return
    }

    try {
      const result = this.config.sink?.capture(event)
      if (result != null && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {
          /* telemetry must never break callers */
        })
      }
    } catch {
      // Telemetry must never break wallet or network behavior.
    }
  }
}
