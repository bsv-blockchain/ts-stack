import Random from '../primitives/Random.js'
import { toHex } from '../primitives/utils.js'

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error'

export type TelemetryAttributeValue = string | number | boolean

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
  correlationId?: string
  attributes?: Readonly<Record<string, TelemetryAttributeValue>>
  error?: TelemetryError
}

export interface TelemetryEventInput {
  name: string
  component: string
  severity?: TelemetrySeverity
  correlationId?: string
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

export interface TelemetryConfig {
  /** No events are emitted unless a sink is supplied and enabled is not false. */
  sink?: TelemetrySink
  enabled?: boolean
  minimumSeverity?: TelemetrySeverity
  /** Error stacks are omitted by default. Enable only for a trusted sink. */
  includeErrorStack?: boolean
  /** Injectable clock for tests and host applications. */
  now?: () => number
  /** Injectable correlation-id factory for distributed tracing. */
  correlationIdFactory?: () => string
  /**
   * Last-mile event filtering or enrichment. The returned event is sanitized
   * again, so enrichment cannot bypass the secret-redaction boundary.
   */
  beforeSend?: (event: Readonly<TelemetryEvent>) => TelemetryEvent | null | undefined
}

const REDACTED = '[REDACTED]'
const MAX_ATTRIBUTES = 64
const MAX_ATTRIBUTE_LENGTH = 512
const MAX_ERROR_LENGTH = 2048
const MAX_STACK_LENGTH = 8192
let fallbackCorrelationSequence = 0

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
  return new RegExp(
    `(${flexibleTerm}\\s*["'=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}]+)`,
    'gi'
  )
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

function truncate (value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…`
}

/**
 * Removes common secret encodings from diagnostic text. Unlabelled 256-bit
 * hex values are redacted because they may be private or presentation keys.
 */
export function sanitizeTelemetryText (value: string, maxLength: number = MAX_ERROR_LENGTH): string {
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

function sanitizeName (value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  return truncate(value.trim().replace(/[^a-zA-Z0-9_.:-]/g, '_'), 160)
}

function sanitizeCorrelationId (value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return truncate(value.replace(/[^a-zA-Z0-9_.:-]/g, '_'), 128)
}

function sanitizeAttributeValue (name: string, value: unknown): TelemetryAttributeValue | undefined {
  const normalizedName = name.toLowerCase().replaceAll(/[_ .-]/g, '')
  if (SENSITIVE_TERMS.some(term => normalizedName.includes(term))) return REDACTED
  if (typeof value === 'string') return sanitizeTelemetryText(value, MAX_ATTRIBUTE_LENGTH)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined) return undefined
  return REDACTED
}

function sanitizeAttributes (
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

function sanitizeError (error: unknown, includeStack: boolean): TelemetryError | undefined {
  if (error == null) return undefined
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown }
    const code = typeof withCode.code === 'string'
      ? sanitizeTelemetryText(withCode.code, 120)
      : undefined
    const stack = includeStack && typeof error.stack === 'string'
      ? sanitizeTelemetryText(error.stack, MAX_STACK_LENGTH)
      : undefined
    return {
      name: sanitizeName(error.name, 'Error'),
      message: sanitizeTelemetryText(error.message.length > 0 ? error.message : 'Unknown error'),
      ...(code !== undefined ? { code } : {}),
      ...(stack !== undefined ? { stack } : {})
    }
  }
  return {
    name: 'Error',
    message: sanitizeTelemetryText(typeof error === 'string' ? error : 'Unknown error')
  }
}

function sanitizeEvent (
  event: TelemetryEventInput | TelemetryEvent,
  now: () => number,
  includeErrorStack: boolean
): TelemetryEvent {
  const severity = event.severity ?? 'info'
  const correlationId = sanitizeCorrelationId(event.correlationId)
  const attributes = sanitizeAttributes(event.attributes)
  const error = sanitizeError(event.error, includeErrorStack)
  return {
    name: sanitizeName(event.name, 'unknown'),
    component: sanitizeName(event.component, 'unknown'),
    severity,
    timestamp: typeof (event as TelemetryEvent).timestamp === 'number' &&
      Number.isFinite((event as TelemetryEvent).timestamp)
      ? (event as TelemetryEvent).timestamp
      : now(),
    ...(correlationId !== undefined
      ? { correlationId }
      : {}),
    ...(attributes !== undefined
      ? { attributes }
      : {}),
    ...(error !== undefined
      ? { error }
      : {})
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

  constructor (config: TelemetryConfig = {}) {
    this.config = config
  }

  get enabled (): boolean {
    return this.config.enabled !== false && this.config.sink != null
  }

  createCorrelationId (): string {
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

  capture (input: TelemetryEventInput): void {
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
        void Promise.resolve(result).catch(() => { /* telemetry must never break callers */ })
      }
    } catch {
      // Telemetry must never break wallet or network behavior.
    }
  }
}
