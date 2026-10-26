import type { TelemetrySpanContext } from './Telemetry.js'

const TRACEPARENT_VERSION = '00'
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

function validTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value)
}

function validSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value)
}

/**
 * Encodes a canonical current span using the W3C Trace Context `traceparent`
 * format. Invalid, accessor-backed, or out-of-range context fields are rejected
 * rather than coerced into a different trace identity.
 */
export function formatTraceparent(context: TelemetrySpanContext): string | undefined {
  try {
    if (context == null || typeof context !== 'object') return undefined
    const traceDescriptor = Object.getOwnPropertyDescriptor(context, 'traceId')
    const spanDescriptor = Object.getOwnPropertyDescriptor(context, 'spanId')
    const flagsDescriptor = Object.getOwnPropertyDescriptor(context, 'traceFlags')
    const traceId = traceDescriptor?.value
    const spanId = spanDescriptor?.value
    const traceFlags = flagsDescriptor == null ? 1 : flagsDescriptor.value
    if (
      typeof traceId !== 'string' ||
      typeof spanId !== 'string' ||
      !validTraceId(traceId) ||
      !validSpanId(spanId) ||
      !Number.isSafeInteger(traceFlags) ||
      traceFlags < 0 ||
      traceFlags > 255
    )
      return undefined
    return `${TRACEPARENT_VERSION}-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${traceFlags.toString(16).padStart(2, '0')}`
  } catch {
    return undefined
  }
}

/**
 * Parses a W3C version-00 `traceparent`. Malformed, future-version, and all-zero
 * identifiers are ignored so untrusted headers cannot break request handling.
 */
export function parseTraceparent(value: unknown): TelemetrySpanContext | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  const match = TRACEPARENT_PATTERN.exec(value.trim())
  if (match == null || !validTraceId(match[1]) || !validSpanId(match[2])) return undefined
  return {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    traceFlags: Number.parseInt(match[3], 16)
  }
}
