import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputPacketDigest,
  OutputProtocolError,
  parseOutputProposalFinalize,
  Utils,
  type OutputProposalFinalize,
  type OutputSignedProposal,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import type { ProposalServiceEvidence } from './ProposalService.js'

/**
 * Complete exact-transaction evidence adapter. The host supplies an immutable,
 * validated chain view and verification policy. Topic rules, proposal policy
 * relations, caller authorization and currentness remain separate checks.
 */
export class SDKProposalEvidence implements ProposalServiceEvidence {
  private readonly verifier: SDKEvidenceVerifier

  constructor(
    chains: ChainViewResolver,
    private readonly context: (proposal: OutputSignedProposal) => VerificationContext,
    limits: Partial<TransactionEvidenceLimits> = {}
  ) {
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }

  async verify(
    input: OutputProposalFinalize,
    proposal: OutputSignedProposal,
    signal: AbortSignal = new AbortController().signal
  ): Promise<string> {
    const request = parseOutputProposalFinalize(input)
    const owned = JSON.parse(canonicalOutputJSON(proposal)) as OutputSignedProposal
    if (
      request.service !== owned.body.service ||
      request.proposalId !== outputPacketDigest('proposal', owned.body)
    )
      throw new OutputProtocolError('invalid', 'Evidence request does not name this proposal')
    const snapshot = parseVerificationContext(this.context(structuredClone(owned)))
    const bytes = decodeOutputBytes(request.beef)
    const result = await this.verifier.verify(
      {
        chain: owned.body.chain,
        evidence: { txid: request.txid, outputIndex: 0, beef: request.beef },
        variantId: Utils.toHex(Hash.sha256(bytes))
      },
      snapshot,
      signal
    )
    if (result.status !== 'verified') {
      const code = result.status === 'unresolved' ? 'unavailable' : result.status
      throw new OutputProtocolError(
        code,
        `Proposal evidence verification ${result.status}`,
        ['unavailable', 'limited', 'cancelled', 'context-changed'].includes(code)
      )
    }
    return result.fact.rawTransaction
  }
}
