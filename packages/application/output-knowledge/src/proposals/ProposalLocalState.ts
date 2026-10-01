import { outputU64, OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import type { Mutation } from '../ports.js'
import type { ReceivedSourceGroup } from '../SourceMembership.js'
import { proposalLocalFrame, parseProposalLocalFrame } from './ProposalLocalFrame.js'
import type { ProposalSourcePolicy } from './ProposalSourcePolicy.js'
import { ProposalKnowledgeViewBuilder } from './ProposalKnowledgeView.js'
import { ProposalVerificationPool, type ProposalVerification } from './ProposalVerificationPool.js'

type Kind = Mutation['body']['kind']
/** Private opt-in local replay material, separate from Bitcoin checks and wire data. */
export class ProposalLocalState {
  readonly pool: ProposalVerificationPool
  private clock = '0'
  private initialized = false
  constructor(
    readonly policy: ProposalSourcePolicy,
    bytes: number
  ) {
    if (policy.describe().rules.some(rule => rule.proposalService !== rule.source.service))
      throw new OutputProtocolError(
        'unsupported',
        'Proposal observations require an identical source and proposal service name'
      )
    this.pool = new ProposalVerificationPool(policy, 4096, Math.min(bytes, 16 * 1024 * 1024))
  }
  get evaluatedAt(): string {
    return this.clock
  }
  view(
    rows: readonly ReceivedSourceGroup[],
    published: readonly ReceivedSourceGroup[]
  ): ProposalKnowledgeViewBuilder {
    return new ProposalKnowledgeViewBuilder(this.policy, this.pool, rows, published)
  }
  evaluation(now: string): string {
    return outputU64(now) > outputU64(this.clock) ? now : this.clock
  }
  frame(
    bitcoin: OutputJSONObject,
    kind: Kind,
    rows: readonly ReceivedSourceGroup[],
    now: string,
    work: ProposalVerification[] = []
  ): OutputJSONObject {
    return proposalLocalFrame(
      bitcoin,
      this.policy,
      kind === 'receive' ? this.clock : this.evaluation(now),
      kind === 'receive' ? this.pool.stamps(rows, now) : [],
      work
    )
  }
  apply(
    local: OutputJSONObject,
    kind: Kind,
    rows: readonly ReceivedSourceGroup[]
  ): OutputJSONObject {
    const frame = parseProposalLocalFrame(local, this.policy),
      proposal = frame.proposals
    if (!this.initialized && kind !== 'context')
      throw new OutputProtocolError('reset-required', 'Proposal journal lacks its initial context')
    if (
      outputU64(proposal.evaluatedAt) < outputU64(this.clock) ||
      (kind === 'receive' && proposal.evaluatedAt !== this.clock)
    )
      throw new OutputProtocolError(
        'invalid',
        'Proposal evaluation clock changed outside an accepted transition'
      )
    if (kind !== 'receive' && proposal.receipts.length)
      throw new OutputProtocolError('invalid', 'Proposal stamps require a receive transition')
    if (
      kind !== 'accept' &&
      kind !== 'reconcile' &&
      (proposal.work.length || frame.bitcoin.work.length)
    )
      throw new OutputProtocolError(
        'invalid',
        'Verification work requires an acceptance transition'
      )
    if (kind === 'receive') this.pool.receive(rows, proposal.receipts)
    this.pool.apply(proposal.work)
    this.clock = proposal.evaluatedAt
    this.initialized = true
    // Parsing already owns and validates this plain JSON frame.
    return frame.bitcoin as unknown as OutputJSONObject
  }
}
