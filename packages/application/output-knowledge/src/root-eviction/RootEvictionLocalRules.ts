import type { OutputJSONObject } from '@bsv/sdk'
import type {
  RootEvictionCommitGuard,
  RootEvictionObservation
} from './RootEvictionCommitContext.js'
import type { RootEvictionServingTarget } from './RootEvictionStorage.js'

/** Immutable operator-authorized rule descriptor. No remote matcher or URL fetch is implied. */
export interface RootEvictionLocalRule {
  /** Versioned identifier understood by the root's installed evaluator. */
  id: string
  parameters: OutputJSONObject
  supportingDigest: string
  /** Attribution checked by the trusted local administration adapter, not a self-asserted peer. */
  operator: string
}
export interface RootEvictionLocalRuleRecord {
  decisionId: string
  rule: RootEvictionLocalRule
  policyDigest: string
  revision: string
  liftedBy: string | null
}
export interface RootEvictionLocalRuleSet {
  epoch: string
  /** Complete active inventory, sorted by decision ID and bounded by blocker capacity. */
  rules: RootEvictionLocalRuleRecord[]
}
export interface RootEvictionLocalRuleAssessment {
  operationId: string
  expectedRevision: string
  ruleEpoch: string
  target: RootEvictionServingTarget
  /** Independently verified chain/currentness and topic-rule assessment. */
  eligible: boolean
  evidenceDigest: string
  reasonCode: string
  /**
   * Exactly one entry per active rule, sorted by decision ID. The trusted local
   * evaluator checks immutable advertisement facts using each installed rule.
   * Unknown implementations/parameters or unavailable facts produce null, never
   * false. Any null keeps serving unresolved unless a known blocker suppresses it.
   */
  matches: { decisionId: string; matches: boolean | null }[]
}

/** Optional trusted-local companion; no public peer administration protocol. */
export interface RootEvictionLocalRulesStorage {
  readonly durability: 'durable'
  active(guard: RootEvictionCommitGuard): Promise<RootEvictionObservation<RootEvictionLocalRuleSet>>
  get(
    decisionId: string,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionLocalRuleRecord | undefined>>
  install(
    input: { operationId: string; expectedRevision: string; rule: RootEvictionLocalRule },
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionLocalRuleRecord>>
  lift(
    input: {
      operationId: string
      expectedRevision: string
      decisionId: string
      operator: string
      supportingDigest: string
    },
    guard: RootEvictionCommitGuard
  ): Promise<
    RootEvictionObservation<{
      actionStatus: 'applied' | 'no-op'
      decisionId?: string
      affected: string
    }>
  >
  assess(
    input: RootEvictionLocalRuleAssessment,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<string>>
  close(): Promise<void>
}
