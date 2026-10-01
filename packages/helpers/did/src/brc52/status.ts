import { verifyBRC52CertificateBinary } from './envelope.js'

/** BRC-203 evidence labels describe the configured adapter's work, not proof by this helper. */
export type BRC52StatusEvidenceKind =
  'provider-assertion' | 'authenticated-view' | 'independently-validated-chain'

export interface BRC52StatusQuery {
  outpoint: string
  network: string
}

export interface BRC52StatusObservation extends BRC52StatusQuery {
  source: string
  /** Unix milliseconds of the current-state observation, not an old inclusion proof. */
  observedAt: number
  exists: boolean
  state: 'spent' | 'unspent'
  confirmations: number
  reorganization: 'stable' | 'pending' | 'conflicting'
  evidence: { kind: BRC52StatusEvidenceKind; reference: string }
}

export interface BRC52StatusRetrieval {
  mode: 'local-chain-view' | 'batched-cached' | 'issuer-per-presentation'
  /** Locally reviewed operational contract; a remote response cannot select this policy. */
  issuerTracking: 'prevented' | 'possible'
  /** Describe the local view or batching/cache mechanism and why it prevents issuer tracking. */
  protection: string
  thirdPartyCorrelation: 'none' | 'possible'
  /** Required when a non-issuer third party can correlate queries with presentations. */
  correlationLimitation?: string
  /** Locally reviewed validation performed by the adapter, never selected by provider JSON. */
  evidenceValidation: { kind: BRC52StatusEvidenceKind; procedure: string }
  /** Must return current-state evidence; inclusion of the creating transaction alone is insufficient. */
  retrieve: (query: Readonly<BRC52StatusQuery>) => Promise<unknown>
}

export interface BRC52StatusPolicy {
  /** Locally selected; this is never an issuer-secured BRC-52 fact. */
  network: string
  source: string
  acceptedEvidence: readonly BRC52StatusEvidenceKind[]
  maxAgeMs: number
  now: number
  minConfirmations: number
  unconfirmedSpends: 'accept' | 'unknown'
  reorganization: 'require-stable' | 'accept-pending'
  retrieval: BRC52StatusRetrieval
}

export interface BRC52StatusResult extends BRC52StatusQuery {
  status: 'disabled' | 'unknown' | 'revoked' | 'notRevokedAsOf'
  reason?:
    | 'issuer-tracking-prohibited'
    | 'retrieval-failed'
    | 'invalid-observation'
    | 'unaccepted-evidence'
    | 'stale-observation'
    | 'outpoint-does-not-exist'
    | 'chain-policy-insufficient'
  observedAt?: number
  source?: string
  evidence?: { kind: BRC52StatusEvidenceKind; reference: string }
  privacy: {
    mode: BRC52StatusRetrieval['mode']
    retrievalAttempted: boolean
    protection: string
    thirdPartyCorrelation: BRC52StatusRetrieval['thirdPartyCorrelation']
    correlationLimitation?: string
  }
}

const DISABLED_OUTPOINT = `${'0'.repeat(64)}.0`
const EVIDENCE_KINDS: readonly BRC52StatusEvidenceKind[] = [
  'provider-assertion',
  'authenticated-view',
  'independently-validated-chain'
]

function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a bounded own-data object')
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Expected a plain own-data object')
  }
  const names = Reflect.ownKeys(value)
  if (
    names.length > keys.length ||
    names.some(name => typeof name !== 'string' || !keys.includes(name))
  ) {
    throw new Error('Unexpected object members')
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('Accessors are not accepted')
    }
    result[name as string] = descriptor.value as unknown
  }
  return result
}

function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error('Expected bounded text')
  }
  for (const character of value) {
    const code = character.codePointAt(0) as number
    if (code < 32 || code === 127) throw new Error('Expected bounded text')
  }
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Expected a nonnegative safe integer')
  }
  return value
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error('Invalid policy choice')
  return value as T
}

function evidenceKinds(value: unknown): BRC52StatusEvidenceKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > EVIDENCE_KINDS.length) {
    throw new Error('Select one or more evidence kinds')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    throw new Error('Invalid evidence choices')
  const kinds: BRC52StatusEvidenceKind[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !('value' in descriptor))
      throw new Error('Invalid evidence choices')
    kinds.push(choice(descriptor.value as unknown, EVIDENCE_KINDS))
  }
  if (new Set(kinds).size !== kinds.length) throw new Error('Duplicate evidence choices')
  return kinds
}

function snapshotPolicy(input: BRC52StatusPolicy): BRC52StatusPolicy {
  const policy = ownRecord(input, [
    'network',
    'source',
    'acceptedEvidence',
    'maxAgeMs',
    'now',
    'minConfirmations',
    'unconfirmedSpends',
    'reorganization',
    'retrieval'
  ])
  const retrieval = ownRecord(policy.retrieval, [
    'mode',
    'issuerTracking',
    'protection',
    'thirdPartyCorrelation',
    'correlationLimitation',
    'evidenceValidation',
    'retrieve'
  ])
  const evidenceValidation = ownRecord(retrieval.evidenceValidation, ['kind', 'procedure'])
  if (typeof retrieval.retrieve !== 'function')
    throw new Error('A status retrieval adapter is required')
  const thirdPartyCorrelation = choice(retrieval.thirdPartyCorrelation, ['none', 'possible'])
  const correlationLimitation =
    retrieval.correlationLimitation === undefined
      ? undefined
      : text(retrieval.correlationLimitation)
  if (thirdPartyCorrelation === 'possible' && correlationLimitation === undefined) {
    throw new Error('Document third-party correlation limitations')
  }
  return {
    network: text(policy.network, 128),
    source: text(policy.source, 256),
    acceptedEvidence: evidenceKinds(policy.acceptedEvidence),
    maxAgeMs: integer(policy.maxAgeMs),
    now: integer(policy.now),
    minConfirmations: integer(policy.minConfirmations),
    unconfirmedSpends: choice(policy.unconfirmedSpends, ['accept', 'unknown']),
    reorganization: choice(policy.reorganization, ['require-stable', 'accept-pending']),
    retrieval: {
      mode: choice(retrieval.mode, [
        'local-chain-view',
        'batched-cached',
        'issuer-per-presentation'
      ]),
      issuerTracking: choice(retrieval.issuerTracking, ['prevented', 'possible']),
      protection: text(retrieval.protection),
      thirdPartyCorrelation,
      correlationLimitation,
      evidenceValidation: {
        kind: choice(evidenceValidation.kind, EVIDENCE_KINDS),
        procedure: text(evidenceValidation.procedure)
      },
      retrieve: retrieval.retrieve as BRC52StatusRetrieval['retrieve']
    }
  }
}

function snapshotObservation(input: unknown): BRC52StatusObservation {
  const observation = ownRecord(input, [
    'outpoint',
    'network',
    'source',
    'observedAt',
    'exists',
    'state',
    'confirmations',
    'reorganization',
    'evidence'
  ])
  const evidence = ownRecord(observation.evidence, ['kind', 'reference'])
  if (typeof observation.exists !== 'boolean')
    throw new Error('An existence observation is required')
  return {
    outpoint: text(observation.outpoint, 128),
    network: text(observation.network, 128),
    source: text(observation.source, 256),
    observedAt: integer(observation.observedAt),
    exists: observation.exists,
    state: choice(observation.state, ['spent', 'unspent']),
    confirmations: integer(observation.confirmations),
    reorganization: choice(observation.reorganization, ['stable', 'pending', 'conflicting']),
    evidence: {
      kind: choice(evidence.kind, EVIDENCE_KINDS),
      reference: text(evidence.reference)
    }
  }
}

/**
 * Verify the original BRC-52 signature before evaluating its signed revocation outpoint.
 * No network provider is installed. The caller supplies a locally reviewed retrieval adapter,
 * including its evidence validation, batching/cache protections, and chain/reorganization policy.
 * An evidence label is a report of that adapter's work; this helper does not validate chain proofs.
 * `notRevokedAsOf` is an observation under that policy, never timeless validity or issuer trust.
 * Invalid certificates or local configuration throw. Missing/unaccepted evidence returns unknown.
 */
export async function evaluateBRC52Status(
  certificateBinary: number[] | Uint8Array,
  inputPolicy: BRC52StatusPolicy
): Promise<BRC52StatusResult> {
  const certificate = verifyBRC52CertificateBinary(certificateBinary)
  const policy = snapshotPolicy(inputPolicy)
  const { retrieval } = policy
  const base: BRC52StatusResult = {
    status: 'unknown',
    outpoint: certificate.revocationOutpoint,
    network: policy.network,
    privacy: {
      mode: retrieval.mode,
      retrievalAttempted: false,
      protection: retrieval.protection,
      thirdPartyCorrelation: retrieval.thirdPartyCorrelation,
      ...(retrieval.correlationLimitation === undefined
        ? {}
        : { correlationLimitation: retrieval.correlationLimitation })
    }
  }
  if (base.outpoint === DISABLED_OUTPOINT) return { ...base, status: 'disabled' }
  if (retrieval.mode === 'issuer-per-presentation' || retrieval.issuerTracking !== 'prevented') {
    return { ...base, reason: 'issuer-tracking-prohibited' }
  }
  base.privacy.retrievalAttempted = true
  let received: unknown
  try {
    received = await retrieval.retrieve(
      Object.freeze({ outpoint: base.outpoint, network: policy.network })
    )
  } catch {
    return { ...base, reason: 'retrieval-failed' }
  }
  let observation: BRC52StatusObservation
  try {
    observation = snapshotObservation(received)
  } catch {
    return { ...base, reason: 'invalid-observation' }
  }
  if (
    observation.outpoint !== base.outpoint ||
    observation.network !== policy.network ||
    observation.source !== policy.source
  ) {
    return { ...base, reason: 'invalid-observation' }
  }
  if (
    observation.evidence.kind !== retrieval.evidenceValidation.kind ||
    !policy.acceptedEvidence.includes(observation.evidence.kind)
  ) {
    return { ...base, reason: 'unaccepted-evidence' }
  }
  if (
    observation.observedAt > policy.now ||
    policy.now - observation.observedAt > policy.maxAgeMs
  ) {
    return { ...base, reason: 'stale-observation' }
  }
  if (!observation.exists) return { ...base, reason: 'outpoint-does-not-exist' }
  const acceptedUnconfirmedSpend =
    observation.state === 'spent' &&
    observation.confirmations === 0 &&
    policy.unconfirmedSpends === 'accept'
  if (
    observation.reorganization === 'conflicting' ||
    (observation.reorganization === 'pending' && policy.reorganization === 'require-stable') ||
    (observation.confirmations === 0 &&
      observation.state === 'spent' &&
      policy.unconfirmedSpends === 'unknown') ||
    (observation.confirmations < policy.minConfirmations && !acceptedUnconfirmedSpend)
  ) {
    return { ...base, reason: 'chain-policy-insufficient' }
  }
  return {
    ...base,
    status: observation.state === 'spent' ? 'revoked' : 'notRevokedAsOf',
    source: observation.source,
    observedAt: observation.observedAt,
    evidence: observation.evidence
  }
}
