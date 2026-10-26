import Random from '../primitives/Random.js'
import { toHex } from '../primitives/utils.js'
import { isPlainRecord } from '../primitives/SafeRecord.js'

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
 * consumer's own support-event pipeline. The sink is optional diagnostics,
 * never an authorization or application-result participant; failures are
 * contained by `Telemetry`.
 */
export interface TelemetrySink {
  capture: (event: Readonly<TelemetryEvent>) => void | Promise<void>
}

/**
 * Optional host integration for asynchronous span context propagation.
 *
 * Node applications can adapt AsyncLocalStorage. Browser and React Native
 * consumers can instead use the explicit carrier helpers on `Telemetry`.
 * `Telemetry.withSpan` invokes application work at most once and ignores a
 * manager's substituted result or failures outside that application callback.
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
const MAX_SANITIZER_LENGTH = 64 * 1024
let fallbackCorrelationSequence = 0
const carrierContexts = new WeakMap<object, TelemetrySpanContext>()
const synchronousContextStack: TelemetrySpanContext[] = []
const systemDateNow = Date.now.bind(Date)

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
  'token',
  'bearer',
  'authorization',
  'credential',
  'cookie',
  'session',
  'apikey',
  'key',
  'signature',
  'hmac',
  'derivation',
  'certificate',
  'revocation',
  'otp',
  'onetime',
  'pin'
] as const

const SENSITIVE_LABEL_PATTERNS = SENSITIVE_TERMS.map(term => {
  const flexibleTerm = term.replace(/key|token|time/g, match => `[_ -]?${match}`)
  return new RegExp(String.raw`(${flexibleTerm}\s*["'=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)`, 'gi')
})

const BEARER_TOKEN = /\bBearer\s+[a-z0-9._~+/=-]+/gi
const BASIC_AUTH = /\bBasic\s+[a-z0-9+/=]+/gi
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
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

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return undefined
  }
  return descriptor.value
}

function telemetrySeverity(
  value: unknown,
  fallback: TelemetrySeverity = 'info'
): TelemetrySeverity {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : fallback
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

/**
 * Removes common secret encodings from diagnostic text. Unlabelled 256-bit
 * hex values are redacted because they may be private or presentation keys.
 * This defense in depth does not make arbitrary payloads safe to log: callers
 * must still emit only operational metadata.
 */
export function sanitizeTelemetryText(value: string, maxLength: number = MAX_ERROR_LENGTH): string {
  if (typeof value !== 'string') return ''
  const safeMaximum =
    Number.isSafeInteger(maxLength) && maxLength >= 0
      ? Math.min(maxLength, MAX_SANITIZER_LENGTH)
      : MAX_ERROR_LENGTH
  // Bound sanitizer work before applying regular expressions. Any suffix past
  // this window cannot reach the emitted value, even after redaction.
  const bounded = value.slice(0, Math.max(safeMaximum * 2, safeMaximum + 256))
  const credentialHeadersRedacted = bounded
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(BASIC_AUTH, 'Basic [REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
  const labelsRedacted = SENSITIVE_LABEL_PATTERNS.reduce(
    (sanitized, pattern) => sanitized.replace(pattern, '$1[REDACTED]'),
    credentialHeadersRedacted
  )
  return truncate(
    labelsRedacted
      .replace(WIF_PRIVATE_KEY, REDACTED)
      .replace(EXTENDED_PRIVATE_KEY, REDACTED)
      .replace(HEX_256_BIT_VALUE, REDACTED)
      .replace(LARGE_ENCODED_BLOB, REDACTED)
      .replace(SERIALIZED_BYTE_ARRAY, REDACTED),
    safeMaximum
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

function sanitizeSpanContext(value: unknown): TelemetrySpanContext | undefined {
  if (!isPlainRecord(value)) return undefined
  const traceId = sanitizeTraceId(ownDataValue(value, 'traceId'))
  const spanId = sanitizeSpanId(ownDataValue(value, 'spanId'))
  const traceFlags = ownDataValue(value, 'traceFlags')
  if (
    traceId === undefined ||
    spanId === undefined ||
    (traceFlags !== undefined &&
      (!Number.isSafeInteger(traceFlags) ||
        (traceFlags as number) < 0 ||
        (traceFlags as number) > 255))
  )
    return undefined
  return Object.freeze({
    traceId,
    spanId,
    ...(traceFlags !== undefined ? { traceFlags: traceFlags as number } : {})
  })
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
  if (!isPlainRecord(attributes)) return undefined
  const safe: Record<string, TelemetryAttributeValue> = Object.create(null)
  let count = 0
  let inspected = 0
  for (const rawName of Reflect.ownKeys(attributes)) {
    if (inspected >= MAX_ATTRIBUTES) break
    inspected += 1
    if (typeof rawName !== 'string') continue
    const name = sanitizeName(rawName, '')
    if (name.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(safe, name)) continue
    const value = ownDataValue(attributes, rawName)
    const sanitized = sanitizeAttributeValue(name, value)
    if (sanitized === undefined) continue
    safe[name] = sanitized
    count++
  }
  return count > 0 ? safe : undefined
}

function sanitizeOptionalErrorText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? sanitizeTelemetryText(value, maxLength) : undefined
}

function sanitizeErrorCandidate(
  candidate: Record<string, unknown>,
  includeStack: boolean
): TelemetryError {
  const candidateName = ownDataValue(candidate, 'name')
  const candidateMessage = ownDataValue(candidate, 'message')
  const candidateCode = ownDataValue(candidate, 'code')
  const candidateStack = ownDataValue(candidate, 'stack')
  const message =
    typeof candidateMessage === 'string' && candidateMessage.length > 0
      ? candidateMessage
      : 'Unknown error'
  const code = sanitizeOptionalErrorText(candidateCode, 120)
  const stack = includeStack
    ? sanitizeOptionalErrorText(candidateStack, MAX_STACK_LENGTH)
    : undefined
  return {
    name: sanitizeName(candidateName, 'Error'),
    message: sanitizeTelemetryText(message),
    ...(code !== undefined ? { code } : {}),
    ...(stack !== undefined ? { stack } : {})
  }
}

function sanitizeError(error: unknown, includeStack: boolean): TelemetryError | undefined {
  if (error == null) return undefined
  if (typeof error === 'object') {
    return sanitizeErrorCandidate(error as Record<string, unknown>, includeStack)
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
  if (!isPlainRecord(event)) throw new TypeError('Telemetry event must be a plain data object.')
  const severity = telemetrySeverity(ownDataValue(event, 'severity'))
  const correlationId = sanitizeCorrelationId(ownDataValue(event, 'correlationId'))
  const traceId = sanitizeTraceId(ownDataValue(event, 'traceId'))
  const spanId = sanitizeSpanId(ownDataValue(event, 'spanId'))
  const parentSpanId = sanitizeSpanId(ownDataValue(event, 'parentSpanId'))
  const startTimestamp = sanitizeDuration(ownDataValue(event, 'startTimestamp'))
  const durationMs = sanitizeDuration(ownDataValue(event, 'durationMs'))
  const attributes = sanitizeAttributes(
    ownDataValue(event, 'attributes') as Readonly<Record<string, unknown>> | undefined
  )
  const error = sanitizeError(ownDataValue(event, 'error'), includeErrorStack)
  const timestamp = ownDataValue(event, 'timestamp')
  const type = ownDataValue(event, 'type')
  const spanKind = ownDataValue(event, 'spanKind')
  const spanStatus = ownDataValue(event, 'spanStatus')
  return {
    name: sanitizeName(ownDataValue(event, 'name'), 'unknown'),
    component: sanitizeName(ownDataValue(event, 'component'), 'unknown'),
    severity,
    timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : now(),
    ...(type === 'span' || type === 'event' ? { type } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(spanId !== undefined ? { spanId } : {}),
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    ...(spanKind === 'internal' || spanKind === 'client' || spanKind === 'server'
      ? { spanKind }
      : {}),
    ...(spanStatus === 'ok' || spanStatus === 'error' || spanStatus === 'cancelled'
      ? { spanStatus }
      : {}),
    ...(startTimestamp !== undefined ? { startTimestamp } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(error !== undefined ? { error } : {})
  }
}

function defaultHighResolutionNow(): number {
  try {
    const perf = globalThis.performance
    const value = perf != null && typeof perf.now === 'function' ? perf.now() : systemDateNow()
    return Number.isFinite(value) ? value : systemDateNow()
  } catch {
    return systemDateNow()
  }
}

function nextFallbackSequence(): number {
  fallbackCorrelationSequence = (fallbackCorrelationSequence + 1) % Number.MAX_SAFE_INTEGER
  if (fallbackCorrelationSequence === 0) fallbackCorrelationSequence = 1
  return fallbackCorrelationSequence
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
  const merged: Record<string, unknown> = Object.create(null)
  let count = 0
  for (const source of [first, second, third]) {
    if (!isPlainRecord(source)) continue
    let inspected = 0
    for (const key of Reflect.ownKeys(source)) {
      if (inspected >= MAX_ATTRIBUTES) break
      inspected += 1
      if (typeof key !== 'string') continue
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (descriptor != null && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        if (!Object.prototype.hasOwnProperty.call(merged, key)) {
          if (count >= MAX_ATTRIBUTES) continue
          count += 1
        }
        merged[key] = descriptor.value
      }
    }
  }
  return merged
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
    this.context = Object.freeze({
      traceId: parent?.traceId ?? telemetry.createTraceId(),
      spanId: telemetry.createSpanId(),
      ...(parent?.traceFlags !== undefined ? { traceFlags: parent.traceFlags } : {})
    })
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
    try {
      const runtimeAttributes = this.telemetry.runtimeDiff(
        this.runtimeStart,
        this.telemetry.runtimeSnapshot()
      )
      const durationMs = Math.max(
        0,
        this.telemetry.monotonicClock()() - this.startedAtHighResolution
      )
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
    } catch {
      // Ending diagnostics must never change application behavior.
    }
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
    try {
      if (this.config.sink == null) return false
      const enabled = this.config.enabled
      if (typeof enabled !== 'function') return enabled === undefined || enabled === true
      return enabled() === true
    } catch {
      return false
    }
  }

  wallClock(): () => number {
    return () => {
      try {
        const value = (this.config.now ?? systemDateNow)()
        return typeof value === 'number' && Number.isFinite(value) ? value : systemDateNow()
      } catch {
        return systemDateNow()
      }
    }
  }

  monotonicClock(): () => number {
    return () => {
      try {
        const value = (this.config.highResolutionNow ?? defaultHighResolutionNow)()
        return typeof value === 'number' && Number.isFinite(value)
          ? value
          : defaultHighResolutionNow()
      } catch {
        return defaultHighResolutionNow()
      }
    }
  }

  createCorrelationId(): string {
    try {
      const custom = this.config.correlationIdFactory?.()
      if (typeof custom === 'string' && custom.length > 0) {
        return sanitizeCorrelationId(custom) ?? toHex(Random(16))
      }
      return toHex(Random(16))
    } catch {
      return `${systemDateNow().toString(36)}-${nextFallbackSequence().toString(36)}`
    }
  }

  createTraceId(): string {
    try {
      const custom = sanitizeTraceId(this.config.traceIdFactory?.())
      return custom ?? randomTraceId()
    } catch {
      const sequence = nextFallbackSequence()
      return (
        systemDateNow().toString(16).padStart(16, '0').slice(-16) +
        sequence.toString(16).padStart(16, '0').slice(-16)
      )
    }
  }

  createSpanId(): string {
    try {
      const custom = sanitizeSpanId(this.config.spanIdFactory?.())
      return custom ?? randomSpanId()
    } catch {
      return nextFallbackSequence().toString(16).padStart(16, '0').slice(-16)
    }
  }

  activeContext(): TelemetrySpanContext | undefined {
    try {
      return sanitizeSpanContext(
        this.config.contextManager?.active() ?? synchronousContextStack.at(-1)
      )
    } catch {
      return sanitizeSpanContext(synchronousContextStack.at(-1))
    }
  }

  contextFor(carrier: object | undefined): TelemetrySpanContext | undefined {
    if (carrier == null || (typeof carrier !== 'object' && typeof carrier !== 'function'))
      return undefined
    return carrierContexts.get(carrier)
  }

  bindContext(carrier: object, context: TelemetrySpanContext): void {
    if (carrier == null || (typeof carrier !== 'object' && typeof carrier !== 'function')) return
    try {
      const safeContext = sanitizeSpanContext(context)
      if (safeContext !== undefined) carrierContexts.set(carrier, safeContext)
    } catch {
      // Invalid diagnostic context must not affect application behavior.
    }
  }

  linkContext(source: object | undefined, target: object | undefined): void {
    if (source == null || target == null) return
    const context = this.contextFor(source)
    if (context != null) this.bindContext(target, context)
  }

  startSpan(name: string, options: TelemetrySpanOptions): TelemetrySpan {
    const parent =
      sanitizeSpanContext(options.parent) ??
      this.contextFor(options.carrier) ??
      this.activeContext()
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
    let callbackStarted = false
    let callbackCompleted = false
    let callbackFailed = false
    let callbackResult!: T
    let callbackError: unknown
    const invoke = (): T => {
      if (callbackStarted) {
        if (callbackCompleted) return callbackResult
        throw new Error('Telemetry context manager invoked a callback recursively.')
      }
      callbackStarted = true
      try {
        callbackResult = callback(span)
        callbackCompleted = true
        return callbackResult
      } catch (error) {
        callbackFailed = true
        callbackError = error
        throw error
      }
    }
    const invokeSynchronously = (): T => {
      synchronousContextStack.push(span.context)
      try {
        return invoke()
      } finally {
        synchronousContextStack.pop()
      }
    }

    try {
      let manager: TelemetryContextManager | undefined
      try {
        manager = this.config.contextManager
      } catch {
        // Fall back to the built-in synchronous propagation below.
      }
      if (manager != null) {
        try {
          const run = manager.run
          if (typeof run === 'function') run.call(manager, span.context, invoke)
        } catch (error) {
          if (callbackFailed) throw callbackError
          if (callbackStarted && !callbackCompleted) throw error
        }
      }
      if (callbackFailed) throw callbackError
      const result = callbackStarted ? callbackResult : invokeSynchronously()

      let then: unknown
      try {
        then = result == null ? undefined : (result as unknown as PromiseLike<unknown>).then
      } catch (error) {
        span.end({ status: 'error', error })
        throw error
      }
      if (typeof then === 'function') {
        return Promise.resolve(result as unknown as PromiseLike<unknown>).then(
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
    } catch (error) {
      span.end({ status: 'error', error })
      throw error
    }
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
    try {
      if (!this.enabled) return
      const minimum = telemetrySeverity(this.config.minimumSeverity)
      const now = this.wallClock()
      const includeStack = this.config.includeErrorStack === true
      let event = sanitizeEvent(input, now, includeStack)
      if (severityRank[event.severity] < severityRank[minimum]) return
      const transformed = this.config.beforeSend?.(event)
      if (transformed === null) return
      // Re-sanitize even when the hook returns undefined. TypeScript readonly
      // types do not prevent a JavaScript consumer from mutating the supplied
      // object in place.
      event = sanitizeEvent(transformed ?? event, now, includeStack)
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
