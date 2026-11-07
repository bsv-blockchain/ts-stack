import type {
  OutputChain,
  OutputRootEvictionOutcome,
  OutputRootEvictionResult,
  OutputRootEvictionTarget,
  OutputSignedRootEvictionRequest
} from '@bsv/sdk'

/** Permanent request fences and action history are bounded, never silently collected. */
export interface RootEvictionCapacity {
  requests: number
  requestBytes: number
  targets: number
  blockers: number
  assessments: number
}
export interface RootEvictionConfiguration {
  root: string
  chain: OutputChain
  capacity?: Partial<RootEvictionCapacity>
  /** Opt in to sealed original-contract storage; ordinary format1 remains unchanged. */
  coordination?: { contractBytes?: number }
  /** Explicit format3 local-rule history and coverage; requires coordination. */
  localRules?: { rules?: number; bytes?: number }
}
export interface RootEvictionHead {
  revision: string
  policyDigest: string
}
export interface RootEvictionRetainedRequest {
  request: OutputSignedRootEvictionRequest
  digest: string
  policyDigest: string
}
export type RootEvictionServingTarget = Pick<
  OutputRootEvictionTarget,
  'service' | 'outpoint' | 'advertisementDigest'
>
export type RootEvictionServing = OutputRootEvictionOutcome['serving']

/** Root-authorized admission/reorganization/expiry assessment, outside peer request authority. */
export interface RootEvictionAssessment {
  operationId: string
  expectedRevision: string
  target: RootEvictionServingTarget
  eligible: boolean
  evidenceDigest: string
  reasonCode: string
}
export interface RootEvictionBasis {
  decisionId: string
  target: RootEvictionServingTarget
  requester: string
  requestDigest: string
  policyDigest: string
  revision: string
  liftedBy: string | null
}

/**
 * Trusted local evaluation, never a peer-supplied decision. The evaluator checks
 * the actual advertisement, attribution, evidence, chain context and installed
 * restoration policy before accepting a target. expectedRevision fences that
 * asynchronous work against every intervening root decision.
 */
export interface RootEvictionEvaluation {
  requestDigest: string
  expectedRevision: string
  now: string
  targets: {
    index: number
    disposition: 'accept' | 'reject'
    reasonCode: string
    /** Verified currentness and topic-rule result; suppression does not require eligibility. */
    eligible: boolean
  }[]
}

/**
 * An idempotent projection intent. Suppression is fenced before removal; restored
 * membership remains fenced until the adapter has durably applied this intent.
 * revision identifies the intent, not a transaction identifier on Bitcoin.
 */
export interface RootEvictionProjection {
  target: RootEvictionServingTarget
  revision: string
  membership: 'withdraw' | 'include'
}
export interface RootEvictionStorage {
  readonly durability: 'durable'
  head(): Promise<RootEvictionHead>
  retain(
    request: unknown,
    authenticatedRequester: string,
    clock: { now: string; maximumLifetimeSeconds: string; futureClockSeconds: string }
  ): Promise<RootEvictionRetainedRequest>
  get(requester: string, requestId: string): Promise<RootEvictionRetainedRequest | undefined>
  evaluate(input: RootEvictionEvaluation): Promise<void>
  assess(input: RootEvictionAssessment): Promise<string>
  basis(decisionId: string): Promise<RootEvictionBasis | undefined>
  result(requester: string, requestId: string, now: string): Promise<OutputRootEvictionResult>
  changePolicy(policyDigest: string): Promise<RootEvictionHead>
  projections(maximum: number): Promise<RootEvictionProjection[]>
  projected(intent: RootEvictionProjection): Promise<boolean>
  serving(target: RootEvictionServingTarget): Promise<RootEvictionServing>
  close(): Promise<void>
}
