import {
  canonicalOutputJSON,
  parseOutputJSON,
  closedOutputObject,
  outputString,
  outputU32,
  outputU64,
  outputHex32,
  outputIdentity,
  parseOutputChain,
  parseOutputScope,
  parseOutputObservation,
  parseOutputOutpoint,
  decodeOutputBytes,
  OutputProtocolError,
  type OutputPartition
} from '@bsv/sdk'
import type {
  ChainView,
  Coverage,
  Provenance,
  RuntimeLimits,
  SourceBatch,
  VerificationContext,
  Projection,
  SourceRequest
} from './ports.js'

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OutputProtocolError('invalid', message)
}

export function parseSourceRequest(input: unknown): SourceRequest {
  const value = snapshot(input)
  closedOutputObject(value, ['partition', 'generation', 'scope', 'limits'], ['checkpoint'])
  outputU64(value.generation)
  closedOutputObject(value.limits, Object.keys(DEFAULT_RUNTIME_LIMITS))
  const result: SourceRequest = {
    partition: parsePartition(value.partition),
    generation: value.generation as string,
    scope: parseOutputScope(value.scope),
    limits: runtimeLimits(value.limits as unknown as RuntimeLimits)
  }
  if (value.checkpoint !== undefined) {
    closedOutputObject(value.checkpoint, ['session', 'cursor', 'expiresAt', 'replayUntil'])
    const checkpoint = value.checkpoint
    failUnless(
      outputU64(checkpoint.expiresAt) <= outputU64(checkpoint.replayUntil),
      'Invalid source replay deadline'
    )
    result.checkpoint = {
      session: outputString(checkpoint.session),
      cursor: outputString(checkpoint.cursor),
      expiresAt: checkpoint.expiresAt as string,
      replayUntil: checkpoint.replayUntil as string
    }
  }
  return result
}

export function parseProjection(input: unknown): Projection {
  const value = snapshot(input)
  closedOutputObject(value, [
    'acceptedRevision',
    'generation',
    'contextId',
    'records',
    'conflicts',
    'unresolved'
  ])
  outputU64(value.acceptedRevision)
  outputU64(value.generation)
  outputString(value.contextId)
  for (const collection of [value.records, value.conflicts, value.unresolved])
    failUnless(Array.isArray(collection), 'Invalid projection collection')
  const recordIds = new Set<string>(),
    conflictIds = new Set<string>(),
    unresolvedIds = new Set<string>()
  const unique = (ids: Set<string>, id: unknown): void => {
    const key = outputString(id)
    failUnless(!ids.has(key), 'Duplicate projection identity')
    ids.add(key)
  }
  for (const row of value.records as unknown[]) {
    closedOutputObject(row, ['id', 'schema', 'value'])
    unique(recordIds, row.id)
    failUnless(
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(outputString(row.schema)),
      'Projection schema must be an absolute IRI'
    )
    decodeOutputBytes(row.value)
  }
  for (const row of value.conflicts as unknown[]) {
    closedOutputObject(row, ['id', 'reason', 'observationIds'])
    unique(conflictIds, row.id)
    outputString(row.reason)
    failUnless(Array.isArray(row.observationIds), 'Invalid projection conflict observations')
    for (const id of row.observationIds) outputString(id)
  }
  for (const row of value.unresolved as unknown[]) {
    closedOutputObject(row, ['id', 'reason', 'dependencies'])
    unique(unresolvedIds, row.id)
    outputString(row.reason)
    failUnless(Array.isArray(row.dependencies), 'Invalid projection dependencies')
    for (const dependency of row.dependencies) parseOutputOutpoint(dependency)
  }
  return value as unknown as Projection
}
function snapshot(input: unknown, bytes = 4194304): unknown {
  return parseOutputJSON(canonicalOutputJSON(input, { bytes }), { bytes })
}
export function parsePartition(input: unknown): OutputPartition {
  const value = snapshot(input)
  closedOutputObject(value, ['application', 'account', 'access'])
  return {
    application: outputString(value.application),
    account: outputString(value.account),
    access: outputString(value.access)
  }
}
export function parseChainView(input: unknown): ChainView {
  const value = snapshot(input)
  closedOutputObject(value, [
    'id',
    'chain',
    'tipHash',
    'tipHeight',
    'medianTimePast',
    'chainPolicyDigest'
  ])
  outputU64(value.tipHeight)
  outputU64(value.medianTimePast)
  return {
    id: outputString(value.id),
    chain: parseOutputChain(value.chain),
    tipHash: outputHex32(value.tipHash),
    tipHeight: value.tipHeight as string,
    medianTimePast: value.medianTimePast as string,
    chainPolicyDigest: outputHex32(value.chainPolicyDigest)
  }
}
export function parseVerificationContext(input: unknown): VerificationContext {
  const value = snapshot(input)
  closedOutputObject(value, [
    'id',
    'partition',
    'generation',
    'view',
    'policyDigest',
    'now',
    'limits'
  ])
  const limits = value.limits
  closedOutputObject(limits, ['bytes', 'transactions', 'dependencies', 'deadline'])
  outputU64(value.generation)
  outputU64(value.now)
  outputU64(limits.deadline)
  const bytes = outputU32(limits.bytes),
    transactions = outputU32(limits.transactions),
    dependencies = outputU32(limits.dependencies)
  failUnless(
    bytes > 0 &&
      bytes <= 4194304 &&
      transactions > 0 &&
      transactions <= 4096 &&
      dependencies > 0 &&
      dependencies <= 16384,
    'Invalid verification resource bounds'
  )
  failUnless(
    outputU64(value.now) < outputU64(limits.deadline),
    'Verification deadline precedes context'
  )
  return {
    id: outputString(value.id),
    partition: parsePartition(value.partition),
    generation: value.generation as string,
    view: parseChainView(value.view),
    policyDigest: outputHex32(value.policyDigest),
    now: value.now as string,
    limits: { bytes, transactions, dependencies, deadline: limits.deadline as string }
  }
}

export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
  batchBytes: 3 * 1024 * 1024,
  observations: 1024,
  pendingBytes: 16 * 1024 * 1024,
  verificationConcurrency: 4,
  dependencies: 4096,
  retainedBytes: 64 * 1024 * 1024,
  deadlineMs: 15000
})
export function runtimeLimits(input: Partial<RuntimeLimits> = {}): RuntimeLimits {
  const result = { ...DEFAULT_RUNTIME_LIMITS, ...input }
  for (const [key, value] of Object.entries(result)) {
    failUnless(
      Object.hasOwn(DEFAULT_RUNTIME_LIMITS, key) &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= DEFAULT_RUNTIME_LIMITS[key as keyof RuntimeLimits],
      'Invalid runtime resource bound'
    )
  }
  failUnless(
    result.batchBytes <= result.pendingBytes && result.pendingBytes <= result.retainedBytes,
    'Inconsistent runtime byte limits'
  )
  return result
}

function provenance(input: unknown): Provenance {
  closedOutputObject(input, [
    'partition',
    'generation',
    'adapter',
    'scope',
    'authentication',
    'peer',
    'receivedAt'
  ])
  outputU64(input.generation)
  outputU64(input.receivedAt)
  failUnless(
    input.authentication === 'brc103' || input.authentication === 'configured-transport',
    'Invalid source authentication provenance'
  )
  const result: Provenance = {
    partition: parsePartition(input.partition),
    generation: input.generation as string,
    adapter: outputString(input.adapter),
    scope: parseOutputScope(input.scope),
    authentication: input.authentication,
    peer: outputString(input.peer),
    receivedAt: input.receivedAt as string
  }
  if (result.authentication === 'brc103') {
    outputIdentity(result.peer)
    failUnless(result.scope.provider === result.peer, 'Authenticated provider identity mismatch')
  }
  return result
}

function coverage(input: unknown): Coverage {
  closedOutputObject(input, ['scope', 'phase', 'status'], ['through', 'highWater'])
  failUnless(
    input.phase === 'snapshot' || input.phase === 'live' || input.phase === 'finite',
    'Invalid coverage phase'
  )
  failUnless(
    ['partial', 'complete', 'reset-required', 'unavailable', 'limited'].includes(
      input.status as string
    ),
    'Invalid coverage status'
  )
  if (input.through !== undefined) outputU64(input.through)
  if (input.highWater !== undefined) outputU64(input.highWater)
  if (input.through !== undefined && input.highWater !== undefined)
    failUnless(outputU64(input.through) <= outputU64(input.highWater), 'Invalid coverage watermark')
  return {
    scope: parseOutputScope(input.scope),
    phase: input.phase,
    status: input.status as Coverage['status'],
    ...(input.through !== undefined ? { through: input.through as string } : {}),
    ...(input.highWater !== undefined ? { highWater: input.highWater as string } : {})
  }
}

/** Validate local adapter provenance against trusted configuration before journal receipt. */
export function parseSourceBatch(
  input: unknown,
  expected: Pick<Provenance, 'partition' | 'generation' | 'adapter' | 'scope'>,
  limits: RuntimeLimits,
  supportedExtensions: readonly string[] = []
): SourceBatch {
  const value = snapshot(input, limits.batchBytes)
  closedOutputObject(value, ['provenance', 'groups', 'coverage'], ['checkpoint'])
  const origin = provenance(value.provenance),
    covered = coverage(value.coverage)
  for (const key of ['partition', 'generation', 'adapter', 'scope'] as const)
    failUnless(
      canonicalOutputJSON(origin[key]) === canonicalOutputJSON(expected[key]),
      `Source ${key} differs from configured session`
    )
  const scope = canonicalOutputJSON(origin.scope)
  failUnless(canonicalOutputJSON(covered.scope) === scope, 'Coverage scope mismatch')
  failUnless(Array.isArray(value.groups), 'Invalid source groups')
  const ids = new Set<string>(),
    observationIds = new Set<string>()
  let previousSequence: bigint | undefined
  const groups = value.groups.map(raw => {
    closedOutputObject(raw, ['id', 'sequence', 'observations'])
    const id = outputString(raw.id),
      sequence = outputU64(raw.sequence)
    failUnless(
      !ids.has(id) && Array.isArray(raw.observations),
      'Invalid or duplicated source group'
    )
    ids.add(id)
    if (covered.phase === 'finite') failUnless(sequence === 0n, 'Finite sequence must be zero')
    if (covered.phase === 'snapshot' && covered.through !== undefined)
      failUnless(sequence === outputU64(covered.through), 'Snapshot group watermark mismatch')
    if (covered.phase === 'live') {
      if (previousSequence !== undefined)
        failUnless(sequence > previousSequence, 'Source group sequence reversed')
      if (covered.through !== undefined)
        failUnless(sequence <= outputU64(covered.through), 'Source group beyond watermark')
    }
    previousSequence = sequence
    const observations = raw.observations.map(item => {
      const observation = parseOutputObservation(item, supportedExtensions)
      failUnless(
        canonicalOutputJSON(observation.scope) === scope && !observationIds.has(observation.id),
        'Observation scope or identity mismatch'
      )
      observationIds.add(observation.id)
      if (observationIds.size > limits.observations)
        throw new OutputProtocolError('limited', 'Source observation limit')
      return observation
    })
    return { id, sequence: raw.sequence as string, observations }
  })
  let checkpoint: SourceBatch['checkpoint']
  if (value.checkpoint !== undefined) {
    closedOutputObject(value.checkpoint, ['session', 'cursor', 'expiresAt', 'replayUntil'])
    const c = value.checkpoint
    failUnless(outputU64(c.expiresAt) <= outputU64(c.replayUntil), 'Invalid source replay deadline')
    checkpoint = {
      session: outputString(c.session),
      cursor: outputString(c.cursor),
      expiresAt: c.expiresAt as string,
      replayUntil: c.replayUntil as string
    }
  }
  return { provenance: origin, groups, coverage: covered, ...(checkpoint ? { checkpoint } : {}) }
}
