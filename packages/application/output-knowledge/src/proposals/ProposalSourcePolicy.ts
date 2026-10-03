import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  Hash,
  Utils,
  outputString,
  outputU64,
  parseOutputScope,
  OutputProtocolError,
  type OutputScope,
  type OutputSignedProposal
} from '@bsv/sdk'
import { compareKnowledgeText, outputSourceIdentity } from '../SourceMembership.js'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'
import type { ProposalPolicyDescription } from './ProposalPolicy.js'
import { ProposalLocalState } from './ProposalLocalState.js'

/** Explicit client interpretation of one source's proposal partition. */
export interface ProposalSourceRule {
  source: Omit<OutputScope, 'epoch'>
  proposalService: string
  policy: { id: string; digest: string }
  maxLifetimeSeconds: string
  futureSkewSeconds: string
}
export interface ProposalSourceConfiguration {
  reader: string
  rules: ProposalSourceRule[]
  policies: ProposalPolicyDescription[]
}

export function parseProposalSourceRules(input: unknown): ProposalSourceRule[] {
  const value: unknown = JSON.parse(canonicalOutputJSON(input))
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new OutputProtocolError('invalid', 'Install 1–64 proposal source rules')
  const seen = new Set<string>()
  const rules = value.map(item => {
    closedOutputObject(item, [
      'source',
      'proposalService',
      'policy',
      'maxLifetimeSeconds',
      'futureSkewSeconds'
    ])
    closedOutputObject(item.source, [
      'chain',
      'provider',
      'service',
      'queryDigest',
      'rulesDigest',
      'access'
    ])
    const { epoch: _epoch, ...source } = parseOutputScope({
      ...item.source,
      epoch: 'configuration'
    })
    closedOutputObject(item.policy, ['id', 'digest'])
    const id = outputString(item.policy.id)
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(id))
      throw new OutputProtocolError('invalid', 'Proposal policy identifier must be an IRI')
    const policy = { id, digest: outputHex32(item.policy.digest) }
    const maxLifetimeSeconds = item.maxLifetimeSeconds as string,
      futureSkewSeconds = item.futureSkewSeconds as string
    if (outputU64(maxLifetimeSeconds) === 0n)
      throw new OutputProtocolError('invalid', 'Proposal source lifetime must be positive')
    outputU64(futureSkewSeconds)
    const key = canonicalOutputJSON(source)
    if (seen.has(key)) throw new OutputProtocolError('invalid', 'Duplicate proposal source rule')
    seen.add(key)
    return {
      source,
      proposalService: outputString(item.proposalService),
      policy,
      maxLifetimeSeconds,
      futureSkewSeconds
    }
  })
  rules.sort((a, b) =>
    compareKnowledgeText(canonicalOutputJSON(a.source), canonicalOutputJSON(b.source))
  )
  return rules
}

/**
 * Local installation only. Validation establishes an authenticated proposal for
 * this reader and source; it does not establish full channel history, current host
 * permission, topical admission, Bitcoin evidence or authority to perform effects.
 */
export class ProposalSourcePolicy {
  private readonly configuration: ProposalSourceConfiguration
  private readonly rules: ReadonlyMap<string, ProposalSourceRule>
  private readonly authorize: ProposalPolicyRegistry['authorize']

  constructor(
    registry: ProposalPolicyRegistry,
    reader: string,
    input: readonly ProposalSourceRule[]
  ) {
    const rules = parseProposalSourceRules(input),
      selected = new Map<string, ProposalPolicyDescription>()
    const installed = registry.describe()
    for (const rule of rules) {
      const policy = installed.find(
        value => value.id === rule.policy.id && value.digest === rule.policy.digest
      )
      if (!policy)
        throw new OutputProtocolError('unsupported', 'Proposal source policy is not installed')
      selected.set(policy.id, policy)
    }
    this.configuration = {
      reader: outputIdentity(reader),
      rules,
      policies: [...selected.values()].sort((a, b) => compareKnowledgeText(a.id, b.id))
    }
    this.rules = new Map(rules.map(rule => [canonicalOutputJSON(rule.source), rule]))
    this.authorize = registry.authorize.bind(registry)
  }

  describe(): ProposalSourceConfiguration {
    return structuredClone(this.configuration)
  }

  /** @internal Construct one isolated replay state; optional code stays in this entry. */
  createState(maximumBytes: number): ProposalLocalState {
    return new ProposalLocalState(this, maximumBytes)
  }

  rule(scope: OutputScope): ProposalSourceRule | undefined {
    const selected = this.rules.get(outputSourceIdentity(parseOutputScope(scope)))
    return selected ? structuredClone(selected) : undefined
  }

  /** firstReceivedAt is a retained local receipt time, never a provider freshness claim. */
  validate(input: unknown, scope: OutputScope, firstReceivedAt: string): OutputSignedProposal {
    const selected = this.rule(scope)
    if (!selected) throw new OutputProtocolError('unsupported', 'No installed proposal source rule')
    const proposal = this.authorize(
      'read',
      input,
      {
        chain: selected.source.chain,
        service: selected.proposalService
      },
      this.configuration.reader
    )
    if (canonicalOutputJSON(proposal.body.policy) !== canonicalOutputJSON(selected.policy))
      throw new OutputProtocolError('unsupported', 'Proposal differs from source policy selection')
    const issued = outputU64(proposal.body.issuedAt),
      expiry = outputU64(proposal.body.expiresAt)
    if (
      expiry - issued > outputU64(selected.maxLifetimeSeconds) ||
      issued > outputU64(firstReceivedAt) + outputU64(selected.futureSkewSeconds)
    )
      throw new OutputProtocolError('invalid', 'Proposal violates installed source clock policy')
    // Historical disclosure is distinct from active intent. Expiry is evaluated
    // separately against a monotonically retained local publication clock.
    return proposal
  }
}

/** Exact signed-envelope variant; a body ID alone cannot qualify a changed signature. */
export function proposalEnvelopeIdentity(proposal: OutputSignedProposal): string {
  return Utils.toHex(
    Hash.sha256(
      Utils.toArray('TS-OUTPUT-PROPOSAL-ENVELOPE/1\0' + canonicalOutputJSON(proposal), 'utf8')
    )
  )
}
