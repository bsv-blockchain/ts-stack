import * as s from './OutputProtocolSchema.js'
import { outputAssert } from './OutputProtocolError.js'
import { OUTPUT_LOOKUP_MAXIMUMS } from './OutputLookupProtocol.js'

export const OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES = 4096

const statuses = Object.freeze({
  invalid: 400,
  unauthorized: 401,
  'not-found': 404,
  conflict: 409,
  equivocation: 409,
  'reset-required': 409,
  'context-changed': 409,
  expired: 410,
  limited: 413,
  unsupported: 422,
  unavailable: 503
} as const)

const detail = s.object(
  { kind: s.literal('envelope', 'group', 'permanent-group') },
  { minimumBytes: s.u32, minimumObservations: s.u32 }
)
const envelope = s.object({
  version: s.literal(1),
  error: s.object(
    {
      code: s.literal(
        'invalid',
        'unauthorized',
        'not-found',
        'conflict',
        'equivocation',
        'reset-required',
        'context-changed',
        'expired',
        'limited',
        'unsupported',
        'unavailable'
      ),
      message: s.text,
      retryable: s.bool
    },
    { retryAfterMs: s.u32, limit: detail }
  )
})

export type OutputServiceError = ReturnType<typeof envelope>

/**
 * Parse a complete bounded BRC-193/194 error after transport authentication when
 * selected. Errors never contain a successful cursor or constitute empty data.
 * Local cancellation/revision lookup failures are not fabricated server packets.
 */
export function parseOutputServiceError(input: unknown): OutputServiceError {
  const result = s.normalized(input, envelope, OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES)
  const limit = result.error.limit
  if (limit !== undefined) {
    outputAssert(result.error.code === 'limited', 'Limit details require a limited error')
    if (limit.minimumBytes !== undefined)
      outputAssert(
        limit.minimumBytes > 0 && limit.minimumBytes <= OUTPUT_LOOKUP_MAXIMUMS.maxBytes,
        'Error minimum bytes exceed profile bounds'
      )
    if (limit.minimumObservations !== undefined)
      outputAssert(
        limit.minimumObservations > 0 &&
          limit.minimumObservations <= OUTPUT_LOOKUP_MAXIMUMS.maxObservations,
        'Error minimum observations exceed profile bounds'
      )
  }
  return result
}

/** Exact common packet-profile status mapping; a 402 never authorizes a lookup payment. */
export function outputServiceErrorHTTPStatus(code: OutputServiceError['error']['code']): number {
  outputAssert(Object.hasOwn(statuses, code), 'Unknown service error code')
  return statuses[code]
}
