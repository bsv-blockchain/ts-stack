import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputIdentity,
  outputPacketDigest,
  OutputProtocolError,
  outputString,
  outputU64,
  parseOutputChain,
  parseOutputJSON,
  parseOutputProposal,
  validateOutputExtensions,
  verifyOutputPacket,
  Transaction,
  type OutputProposalBody,
  type OutputSignedProposal
} from '@bsv/sdk'
import type {
  ProposalAction,
  ProposalClockPolicy,
  ProposalPolicyDescription,
  ProposalPolicyInstallation,
  ProposalScope
} from './ProposalPolicy.js'

/** Explicit installation, signature checking and policy relations, independent of host storage. */
export class ProposalPolicyRegistry {
  private readonly installed = new Map<
    string,
    ProposalPolicyInstallation & ProposalPolicyDescription
  >()
  private readonly extensions: string[]

  constructor(installations: readonly ProposalPolicyInstallation[]) {
    if (installations.length < 1 || installations.length > 32)
      throw new OutputProtocolError('invalid', 'Install 1–32 proposal policies')
    const extensions = new Set<string>()
    for (const { policy, parameters: supplied } of installations) {
      const id = outputString(policy.id)
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(id) || this.installed.has(id))
        throw new OutputProtocolError('invalid', 'Invalid or duplicate installed proposal policy')
      const parameters = parseOutputJSON(canonicalOutputJSON(policy.parameters(supplied)))
      if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
        throw new OutputProtocolError('invalid', 'Installed policy parameters must be an object')
      closedOutputObject(parameters, Object.keys(parameters))
      const digest = outputPacketDigest('proposal-policy', { id, parameters })
      this.installed.set(id, { policy, id, digest, parameters })
      for (const extension of policy.supportedExtensions ?? []) extensions.add(extension)
    }
    this.extensions = [...extensions]
  }

  /** Owned copies suitable for an explicitly authenticated capability manifest. */
  describe(): ProposalPolicyDescription[] {
    return [...this.installed.values()].map(({ id, digest, parameters }) => ({
      id,
      digest,
      parameters: structuredClone(parameters)
    }))
  }

  /** Does not decide clock freshness, current host access, channel CAS or topical admission. */
  validate(input: unknown, scope: ProposalScope): OutputSignedProposal {
    const proposal = parseOutputProposal(input, this.extensions)
    const { body } = proposal
    if (
      body.service !== outputString(scope.service) ||
      canonicalOutputJSON(body.chain) !== canonicalOutputJSON(parseOutputChain(scope.chain))
    )
      throw new OutputProtocolError('invalid', 'Proposal differs from selected service or chain')
    const installation = this.resolve(body)
    validateOutputExtensions(body, installation.policy.supportedExtensions)
    installation.policy.validate(body, structuredClone(installation.parameters))
    if (!verifyOutputPacket('proposal', proposal, body.author))
      throw new OutputProtocolError('unauthorized', 'Invalid proposal author signature')
    return proposal
  }

  /** Policy permission only. Intersect with the host's current access policy on every effect/read. */
  permits(action: ProposalAction, proposal: OutputSignedProposal, caller: string): boolean {
    const validated = this.validate(proposal, proposal.body)
    return this.resolve(validated.body).policy.permits(
      action,
      validated.body,
      outputIdentity(caller)
    )
  }

  /** Validate the signed successor relation; durable storage must still serialize the active head. */
  successor(previous: OutputSignedProposal, next: OutputSignedProposal): void {
    const prior = this.validate(previous, previous.body)
    const following = this.validate(next, previous.body)
    if (
      proposalChannelKey(prior.body) !== proposalChannelKey(following.body) ||
      outputU64(following.body.revision) !== outputU64(prior.body.revision) + 1n ||
      following.body.previous !== outputPacketDigest('proposal', prior.body) ||
      prior.body.operation === 'withdraw'
    )
      throw new OutputProtocolError('conflict', 'Proposal does not extend the active signed head')
    this.resolve(prior.body).policy.successor(prior.body, following.body)
  }

  /** Strict raw-byte relation only; successful return is not Bitcoin evidence verification. */
  finalization(proposal: OutputSignedProposal, rawTransaction: string, txid: string): void {
    const validated = this.validate(proposal, proposal.body)
    const transaction = Transaction.fromBinary(decodeOutputBytes(rawTransaction))
    if (transaction.id('hex') !== txid || validated.body.operation !== 'update')
      throw new OutputProtocolError('invalid', 'Finalization transaction or proposal mismatch')
    this.resolve(validated.body).policy.finalization(
      validated.body,
      outputPacketDigest('proposal', validated.body),
      transaction
    )
  }

  private resolve(
    body: OutputProposalBody
  ): ProposalPolicyInstallation & ProposalPolicyDescription {
    const installation = this.installed.get(body.policy.id)
    if (installation?.digest !== body.policy.digest)
      throw new OutputProtocolError(
        'unsupported',
        'Proposal policy is not installed with these parameters'
      )
    return installation
  }
}

/** Separate channel namespace; never an outpoint, transaction identifier or spend assertion. */
export function proposalChannelKey(
  body: Pick<OutputProposalBody, 'chain' | 'service' | 'policy' | 'channel'>
): string {
  return canonicalOutputJSON({
    chain: body.chain,
    service: body.service,
    policy: body.policy,
    channel: body.channel
  })
}

/** Evaluate on new mutations, not on recovery of an already committed finalization. */
export function validateProposalWindow(
  body: OutputProposalBody,
  now: string,
  policy: ProposalClockPolicy
): void {
  const issued = outputU64(body.issuedAt),
    expiry = outputU64(body.expiresAt),
    clock = outputU64(now)
  const lifetime = outputU64(policy.maxLifetimeSeconds),
    skew = outputU64(policy.futureSkewSeconds)
  if (lifetime === 0n || issued >= expiry || expiry - issued > lifetime || issued > clock + skew)
    throw new OutputProtocolError('invalid', 'Proposal violates installed clock policy')
  if (clock >= expiry) throw new OutputProtocolError('expired', 'Proposal has expired')
}
