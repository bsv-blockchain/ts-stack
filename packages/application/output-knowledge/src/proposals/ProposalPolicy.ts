import type {
  OutputChain,
  OutputJSON,
  OutputJSONObject,
  OutputProposalBody,
  Transaction
} from '@bsv/sdk'

export type ProposalAction = 'put' | 'read' | 'finalize'

/**
 * Locally installed, immutable, deterministic validation code. Methods are pure;
 * mutable host access policy is a separate port. A remote identifier never loads code.
 */
export interface ProposalPolicy {
  readonly id: string
  readonly supportedExtensions?: readonly string[]
  /** Reject unknown fields and return the exact registered canonical parameters. */
  parameters(input: unknown): OutputJSONObject
  validate(body: OutputProposalBody, parameters: OutputJSONObject): void
  permits(action: ProposalAction, body: OutputProposalBody, caller: string): boolean
  /**
   * Optional pure read-visibility descriptor. Equal canonical values MUST mean
   * permits('read', body, caller) is identical for EVERY caller. Mutable host
   * policy remains separate. Omitting this uses the complete signed body, so
   * unknown policies conservatively invalidate sessions on any head replacement.
   */
  readVisibility?(body: OutputProposalBody, parameters: OutputJSONObject): OutputJSON
  successor(previous: OutputProposalBody, next: OutputProposalBody): void
  /** Relation only. The host must separately verify BEEF and ordinary topic admission. */
  finalization(body: OutputProposalBody, proposalId: string, transaction: Transaction): void
}

export interface ProposalPolicyInstallation {
  policy: ProposalPolicy
  parameters: OutputJSONObject
}

export interface ProposalPolicyDescription {
  id: string
  digest: string
  parameters: OutputJSONObject
}

export interface ProposalScope {
  chain: OutputChain
  service: string
}

/** Finite host clock policy, expressed in exact seconds. It never extends signed expiry. */
export interface ProposalClockPolicy {
  maxLifetimeSeconds: string
  futureSkewSeconds: string
}
