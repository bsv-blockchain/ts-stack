import type { OutputChain, OutputJSONObject, OutputProposalBody, Transaction } from '@bsv/sdk'

export type ProposalAction = 'put' | 'read' | 'finalize'

/** Locally installed, versioned code. A remote policy identifier never loads code. */
export interface ProposalPolicy {
  readonly id: string
  readonly supportedExtensions?: readonly string[]
  /** Reject unknown fields and return the exact registered canonical parameters. */
  parameters(input: unknown): OutputJSONObject
  validate(body: OutputProposalBody, parameters: OutputJSONObject): void
  permits(action: ProposalAction, body: OutputProposalBody, caller: string): boolean
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
