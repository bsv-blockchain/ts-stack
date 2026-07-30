interface TraceContextLike {
  traceId: string
  spanId: string
  traceFlags?: number
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

function validTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value)
}

function validSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value)
}

/**
 * Package-local compatibility helpers keep remoting loadable with older SDK
 * peers while the equivalent public SDK helpers roll out.
 */
export function formatTraceparent(context: TraceContextLike): string | undefined {
  if (!validTraceId(context.traceId) || !validSpanId(context.spanId)) return undefined
  const flags = Math.max(0, Math.min(255, context.traceFlags ?? 1))
  return `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${flags.toString(16).padStart(2, '0')}`
}

export function parseTraceparent(value: unknown): TraceContextLike | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  const match = TRACEPARENT_PATTERN.exec(value.trim())
  if (match == null || !validTraceId(match[1]) || !validSpanId(match[2])) return undefined
  return {
    traceId: match[1].toLowerCase(),
    spanId: match[2].toLowerCase(),
    traceFlags: Number.parseInt(match[3], 16)
  }
}
