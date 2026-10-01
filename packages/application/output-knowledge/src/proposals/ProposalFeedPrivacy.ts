import {
  canonicalOutputJSON,
  outputPacketDigest,
  OutputProtocolError,
  type OutputScope
} from '@bsv/sdk'
import type { ProposalFeedWireLimits } from './ProposalChannelFeedRecords.js'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'
import { ProposalChannelHeadsQuery } from './ProposalChannelHeadsQuery.js'
import type { ProposalChannelRecord } from './ProposalTransitions.js'
import type { LookupSessionOpening } from '../lookup/LookupSessionCodec.js'
import { SQLiteLookupDisclosure } from '../lookup/SQLiteLookupDisclosure.js'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'

/** Local, durable policy-wide continuity fences, separate from current host access. */
export class ProposalFeedPrivacy {
  private readonly guards = new Map<string, string>()
  private readonly policies = new Set<string>()
  constructor(
    private readonly domain: SQLiteTransactionDomain,
    private readonly registry: ProposalPolicyRegistry,
    private readonly disclosure: SQLiteLookupDisclosure,
    private readonly scope: Pick<OutputScope, 'chain' | 'provider' | 'service'>,
    private readonly wire: Readonly<ProposalFeedWireLimits>
  ) {
    const rule = new ProposalChannelHeadsQuery(registry)
    for (const { id, digest } of registry.describe()) {
      const rules = outputPacketDigest('service-rules', {
        id: rule.id,
        parameters: { policy: { id, digest } }
      })
      this.guards.set(rules, 'proposal-read-visibility/1/' + digest)
      this.policies.add(digest)
    }
  }

  initialize(create: boolean): void {
    this.domain.writing()
    for (const guard of this.guards.values()) {
      if (create) this.disclosure.initialize(guard)
      else this.disclosure.state(guard)
    }
  }

  guard(policy: { id: string; digest: string }): string {
    new ProposalChannelHeadsQuery(this.registry).parameters({ policy })
    return 'proposal-read-visibility/1/' + policy.digest
  }

  opening(value: LookupSessionOpening): void {
    this.domain.writing()
    const scope = value.first.scope,
      guard = this.guards.get(scope.rulesDigest)
    if (
      !guard ||
      scope.provider !== this.scope.provider ||
      scope.service !== this.scope.service ||
      canonicalOutputJSON(scope.chain) !== canonicalOutputJSON(this.scope.chain) ||
      value.principal === null
    )
      throw new OutputProtocolError(
        'context-changed',
        'Private proposal feed requires its exact authenticated query profile'
      )
    const service = value.contract.manifest.body.services.find(
      item => item.kind === value.contract.kind && item.name === value.contract.service
    )
    const profile = service?.profiles.find(item => item.id === value.contract.profile)
    if (
      !profile ||
      profile.maxResponseBytes < this.wire.maxBytes ||
      Number(profile.parameters.maxObservations) < this.wire.maxObservations
    )
      throw new OutputProtocolError(
        'unsupported',
        'Proposal lookup contract cannot carry its sealed complete groups'
      )
    const required = value.guards.find(item => item.id === guard)
    if (!required || required.failure !== 'reset-required')
      throw new OutputProtocolError(
        'invalid',
        'Proposal lookup opening omitted its durable visibility guard'
      )
  }

  publish(previous: ProposalChannelRecord | undefined, next: ProposalChannelRecord): void {
    this.domain.writing()
    if (!this.policies.has(next.proposal.body.policy.digest))
      throw new OutputProtocolError('context-changed', 'Proposal feed policy is not installed')
    if (
      !previous ||
      previous.proposalId === next.proposalId ||
      this.registry.readVisibility(previous.proposal) ===
        this.registry.readVisibility(next.proposal)
    )
      return
    const guard = this.guard(next.proposal.body.policy)
    this.disclosure.advance(guard, this.disclosure.guard(guard))
  }
}
