import type { ProposalKnowledgeView } from './proposals/ProposalKnowledgeView.js'
import type {
  OutputChain,
  OutputPartition,
  OutputScope,
  OutputEvidence,
  OutputOutpoint,
  OutputObservation,
  OutputSourceGroup,
  OutputBytes,
  OutputHex32,
  OutputU64,
  OutputProtocolErrorCode
} from '@bsv/sdk'

export type {
  OutputChain,
  OutputPartition,
  OutputScope,
  OutputEvidence,
  OutputOutpoint,
  OutputObservation,
  OutputSourceGroup
}

export interface ChainView {
  id: string
  chain: OutputChain
  tipHash: OutputHex32
  tipHeight: OutputU64
  medianTimePast: OutputU64
  chainPolicyDigest: OutputHex32
}
export interface VerificationContext {
  id: string
  partition: OutputPartition
  generation: OutputU64
  view: ChainView
  policyDigest: OutputHex32
  now: OutputU64
  limits: { bytes: number; transactions: number; dependencies: number; deadline: OutputU64 }
}
export interface Provenance {
  partition: OutputPartition
  generation: OutputU64
  adapter: string
  scope: OutputScope
  authentication: 'brc103' | 'configured-transport'
  peer: string
  receivedAt: OutputU64
}
export interface EvidenceCandidate {
  chain: OutputChain
  evidence: OutputEvidence
  variantId: OutputHex32
}
export interface TransactionFact {
  chain: OutputChain
  txid: OutputHex32
  rawTransaction: OutputBytes
  factId: OutputHex32
}
export type VerificationResult =
  | {
      status: 'verified'
      contextId: string
      variantId: OutputHex32
      fact: TransactionFact
      placement?: { blockHash: OutputHex32; height: OutputU64 }
    }
  | {
      status: 'invalid' | 'unresolved' | 'limited' | 'cancelled' | 'context-changed'
      contextId: string
      variantId: OutputHex32
      reason: string
      dependencies: OutputOutpoint[]
    }
export interface Currentness {
  id: OutputHex32
  outpoint: OutputOutpoint
  state: 'unknown' | 'reported-unspent' | 'spent' | 'conflicted' | 'stale'
  contextId: string
  generation: OutputU64
  policyDigest: OutputHex32
  origin: { kind: 'local' } | { kind: 'source'; scope: OutputScope }
  evidenceIds: OutputHex32[]
  expiresAt?: OutputU64
}
export interface Coverage {
  scope: OutputScope
  phase: 'snapshot' | 'live' | 'finite'
  status: 'partial' | 'complete' | 'reset-required' | 'unavailable' | 'limited'
  through?: OutputU64
  highWater?: OutputU64
}
export interface SourceBatch {
  provenance: Provenance
  groups: OutputSourceGroup[]
  coverage: Coverage
  checkpoint?: { session: string; cursor: string; expiresAt: OutputU64; replayUntil: OutputU64 }
}
export interface IngressPosition {
  journalId: string
  position: OutputU64
  index: number
}
export interface CandidateOrder {
  firstRaw: IngressPosition
  readyAt: OutputU64
  depth: number
  readyContextId: string
}
export interface ReconciledTransaction {
  txid: OutputHex32
  evidenceIds: OutputHex32[]
  firstRaw: IngressPosition
  order?: CandidateOrder
  eligible?: { at: OutputU64; contextId: string }
  status:
    | 'unresolved'
    | 'invalid'
    | 'limited'
    | 'unsupported'
    | 'conflicting'
    | 'dependent-conflict'
    | 'selected-non-final'
    | 'selected-final'
    | 'included'
  reason: string
  dependencies: OutputOutpoint[]
  replaces?: OutputHex32
  conflictsWith: OutputHex32[]
}
export interface SourceMembership {
  scope: OutputScope
  generation: OutputU64
  outpoint: OutputOutpoint
  present: boolean
  phase: 'snapshot' | 'live' | 'finite'
  sequence: OutputU64
  observationId: string
}
export interface ReconciledState {
  profile: 'https://bsv.brc.dev/apps/0192#bitcoin-spend-reconciliation-v1'
  nonFinal: boolean
  journalId: string
  through: OutputU64
  contextId: string
  transactions: ReconciledTransaction[]
  memberships: SourceMembership[]
  replacements: {
    previous: OutputHex32
    replacement: OutputHex32
    at: OutputU64
    contextId: string
  }[]
  pendingComponents: { txids: OutputHex32[]; reason: string }[]
}
export interface StoreRevision {
  received: OutputU64
  accepted: OutputU64
}
export interface Mutation {
  key: OutputHex32
  body:
    | { kind: 'receive'; batch: SourceBatch }
    | {
        kind: 'accept'
        scope: OutputScope
        groupId: string
        generation: OutputU64
        contextId: string
        results: VerificationResult[]
        assessments: Currentness[]
        reconciled: ReconciledState
      }
    | {
        kind: 'reconcile'
        generation: OutputU64
        contextId: string
        reconciled: ReconciledState
        assessments: Currentness[]
      }
    | { kind: 'invalidate'; generation: OutputU64; assessmentIds: OutputHex32[]; reason: string }
    | { kind: 'context'; context: VerificationContext }
}
export type CommitResult =
  | { status: 'committed' | 'replayed'; revision: StoreRevision }
  | { status: 'conflict' | 'equivocation' | 'limited' | 'context-changed'; reason: string }
export interface AcceptedInput {
  /** Optional authenticated intent and provider reports; never Bitcoin spend eligibility. */
  proposals?: ProposalKnowledgeView
  partition: OutputPartition
  generation: OutputU64
  revision: StoreRevision
  context: VerificationContext
  observations: OutputObservation[]
  facts: TransactionFact[]
  assessments: Currentness[]
  reconciled: ReconciledState
  pendingGroups: { scope: OutputScope; groupId: string; reason: string }[]
}
export interface Projection {
  acceptedRevision: OutputU64
  generation: OutputU64
  contextId: string
  records: { id: string; schema: string; value: OutputBytes }[]
  conflicts: { id: string; reason: string; observationIds: string[] }[]
  unresolved: { id: string; reason: string; dependencies: OutputOutpoint[] }[]
}

/** All limits are finite, validated before opening sources and never remote-selected. */
export interface RuntimeLimits {
  batchBytes: number
  observations: number
  pendingBytes: number
  verificationConcurrency: number
  dependencies: number
  retainedBytes: number
  deadlineMs: number
}
export interface SourceRequest {
  partition: OutputPartition
  generation: OutputU64
  scope: OutputScope
  limits: RuntimeLimits
  checkpoint?: NonNullable<SourceBatch['checkpoint']>
}
export interface Source {
  readonly id: string
  /** A transport acknowledgement can require durable receipt instead of volatile intake. */
  readonly requiredDurability?: 'durable'
  open(request: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch>
}
export interface EvidenceVerifier {
  verify(
    candidate: EvidenceCandidate,
    context: VerificationContext,
    signal: AbortSignal
  ): Promise<VerificationResult>
}
export interface DomainProjector {
  readonly policyDigest: OutputHex32
  project(input: AcceptedInput, signal: AbortSignal): Promise<Projection>
}
/** Actions are explicitly authorized application calls. No ingest path holds this port. */
export interface ActionPort<Intent, Result> {
  request(intent: Intent, signal?: AbortSignal): Promise<Result>
}
export type RuntimeEvent =
  | { kind: 'knowledge'; input: AcceptedInput }
  | { kind: 'projection'; projection: Projection; knowledgeRevision: StoreRevision }
  | {
      kind: 'error'
      source?: string
      code: OutputProtocolErrorCode
      message: string
      retryable: boolean
    }
