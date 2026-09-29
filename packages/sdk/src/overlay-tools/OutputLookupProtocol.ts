import * as s from './OutputProtocolSchema.js'
import { outputAssert } from './OutputProtocolError.js'
import { outputU64, validateOutputExtensions } from './OutputProtocol.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import { outputGroupSchema, validateOutputObservation } from './OutputObservation.js'

export const OUTPUT_LOOKUP_PROFILE = 'https://bsv.brc.dev/overlays/0193#lookup-live-v1'
export const OUTPUT_LOOKUP_MAXIMUMS = Object.freeze({
  maxBytes: 4194304,
  maxObservations: 1024,
  waitMs: 25000
})

const limits = s.object({ maxBytes: s.u32, maxObservations: s.u32, waitMs: s.u32 })
export type OutputLookupLimits = ReturnType<typeof limits>
const open = s.object(
  { version: s.literal(1), requestId: s.requestId, service: s.text, query: s.json, limits },
  { requiredRulesDigest: s.hex, ...s.extensions }
)
const read = s.object({ version: s.literal(1), session: s.text, cursor: s.text, limits })
const close = s.object({ version: s.literal(1), session: s.text })
const batch = s.object(
  {
    version: s.literal(1),
    session: s.text,
    scope: s.scope,
    phase: s.literal('snapshot', 'live'),
    groups: s.array(outputGroupSchema, 1024),
    cursor: s.text,
    snapshotComplete: s.bool,
    through: s.u64,
    highWater: s.u64,
    expiresAt: s.u64,
    replayUntil: s.u64,
    limits
  },
  s.extensions
)

export type OutputLookupOpen = ReturnType<typeof open>
export type OutputLookupRead = ReturnType<typeof read>
export type OutputLookupClose = ReturnType<typeof close>
export type OutputLookupBatch = ReturnType<typeof batch>

const checkpoint = s.object({
  version: s.literal(1),
  session: s.text,
  scope: s.scope,
  phase: s.literal('snapshot', 'live'),
  cursor: s.text,
  snapshotComplete: s.bool,
  through: s.u64,
  highWater: s.u64,
  expiresAt: s.u64,
  replayUntil: s.u64
})

/** Local committed receipt boundary, not a wire response or proof of persistence. */
export type OutputLookupCheckpoint = ReturnType<typeof checkpoint>

function validateBoundary(result: OutputLookupCheckpoint): void {
  outputAssert(outputU64(result.through) <= outputU64(result.highWater), 'Invalid lookup watermark')
  outputAssert(
    outputU64(result.expiresAt) <= outputU64(result.replayUntil),
    'Invalid replay deadline'
  )
  outputAssert(result.phase !== 'live' || result.snapshotComplete, 'Live before completed snapshot')
}

/** Recover a compact boundary saved atomically with its complete received groups. */
export function parseOutputLookupCheckpoint(input: unknown): OutputLookupCheckpoint {
  const result = s.normalized(input, checkpoint, 16384)
  validateBoundary(result)
  return result
}

/** Copy only continuity metadata; the caller must also durably retain the groups. */
export function outputLookupCheckpoint(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputLookupCheckpoint {
  const value = parseOutputLookupBatch(input, 4194304, supportedExtensions)
  return {
    version: value.version,
    session: value.session,
    scope: value.scope,
    phase: value.phase,
    cursor: value.cursor,
    snapshotComplete: value.snapshotComplete,
    through: value.through,
    highWater: value.highWater,
    expiresAt: value.expiresAt,
    replayUntil: value.replayUntil
  }
}

function positiveLimits(value: OutputLookupLimits): void {
  outputAssert(value.maxBytes > 0 && value.maxObservations > 0, 'Lookup limits must be positive')
}

export function negotiateOutputLookupLimits(
  request: OutputLookupLimits,
  provider: OutputLookupLimits
): OutputLookupLimits {
  const requested = s.normalized(request, limits)
  const available = s.normalized(provider, limits)
  positiveLimits(requested)
  positiveLimits(available)
  outputAssert(available.maxBytes >= 65536, 'Live provider must support 64 KiB responses')
  return {
    maxBytes: Math.min(requested.maxBytes, available.maxBytes, OUTPUT_LOOKUP_MAXIMUMS.maxBytes),
    maxObservations: Math.min(
      requested.maxObservations,
      available.maxObservations,
      OUTPUT_LOOKUP_MAXIMUMS.maxObservations
    ),
    waitMs: Math.min(requested.waitMs, available.waitMs, OUTPUT_LOOKUP_MAXIMUMS.waitMs)
  }
}

export function parseOutputLookupOpen(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputLookupOpen {
  const result = s.normalized(input, open, 1048576)
  positiveLimits(result.limits)
  validateOutputExtensions(result, supportedExtensions)
  return result
}

export function parseOutputLookupRead(input: unknown): OutputLookupRead {
  const result = s.normalized(input, read, 1048576)
  positiveLimits(result.limits)
  return result
}

export function parseOutputLookupClose(input: unknown): OutputLookupClose {
  return s.normalized(input, close, 1048576)
}

/** Parse one authenticated body. Session continuity is checked separately. */
export function parseOutputLookupBatch(
  input: unknown,
  maximumBytes = 4194304,
  supportedExtensions: readonly string[] = []
): OutputLookupBatch {
  const result = s.normalized(input, batch, maximumBytes)
  validateOutputExtensions(result, supportedExtensions)
  positiveLimits(result.limits)
  for (const key of ['maxBytes', 'maxObservations', 'waitMs'] as const) {
    outputAssert(
      result.limits[key] <= OUTPUT_LOOKUP_MAXIMUMS[key],
      'Response limits exceed profile'
    )
  }
  validateBoundary(result)
  const scope = canonicalOutputJSON(result.scope)
  const groupIds = new Set<string>(),
    observationIds = new Set<string>()
  let sequence: bigint | undefined
  for (const group of result.groups) {
    outputAssert(!groupIds.has(group.id), 'Duplicate lookup group')
    groupIds.add(group.id)
    const current = outputU64(group.sequence)
    outputAssert(current <= outputU64(result.through), 'Group beyond lookup watermark')
    if (result.phase === 'snapshot')
      outputAssert(group.sequence === result.through, 'Snapshot group is not at watermark')
    else if (sequence !== undefined) outputAssert(current > sequence, 'Live groups out of order')
    sequence = current
    for (const observation of group.observations) {
      outputAssert(!observationIds.has(observation.id), 'Duplicate lookup observation')
      observationIds.add(observation.id)
      outputAssert(
        canonicalOutputJSON(observation.scope) === scope,
        'Lookup observation scope mismatch'
      )
      validateOutputObservation(observation, supportedExtensions)
    }
  }
  outputAssert(
    observationIds.size <= result.limits.maxObservations,
    'Lookup observation limit',
    'limited'
  )
  // For bytes received over HTTP the transport also charges original UTF-8 bytes,
  // including whitespace, before this parser. Do not trust an echoed allowance.
  outputAssert(
    new TextEncoder().encode(canonicalOutputJSON(result)).length <= result.limits.maxBytes,
    'Lookup response byte limit',
    'limited'
  )
  return result
}

/** Check an already authenticated next body against the retained prior boundary. */
export function validateOutputLookupContinuation(
  previous: OutputLookupCheckpoint,
  next: OutputLookupBatch
): void {
  outputAssert(
    previous.session === next.session &&
      canonicalOutputJSON(previous.scope) === canonicalOutputJSON(next.scope),
    'Lookup session changed',
    'context-changed'
  )
  outputAssert(
    previous.expiresAt === next.expiresAt && previous.replayUntil === next.replayUntil,
    'Lookup deadlines changed',
    'context-changed'
  )
  outputAssert(
    outputU64(next.through) >= outputU64(previous.through),
    'Decreasing lookup watermark'
  )
  if (previous.snapshotComplete) {
    outputAssert(next.phase === 'live' && next.snapshotComplete, 'Missing final snapshot boundary')
    for (const group of next.groups)
      outputAssert(
        outputU64(group.sequence) > outputU64(previous.through),
        'Replayed group before incoming watermark'
      )
  } else {
    outputAssert(
      next.phase === 'snapshot' && next.through === previous.through,
      'Snapshot boundary changed'
    )
  }
}
