import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputIdentity,
  outputPrivatePublicationRequestDigest,
  OutputProtocolError,
  parseOutputChain,
  parseOutputPrivatePublish,
  Transaction,
  Utils,
  type OutputChain,
  type OutputPrivatePublish,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'

export interface VerifiedPrivatePublicationEvidence {
  rawTransaction: string
  requestDigest: string
  publisher: string
  verificationContext: VerificationContext
}

/**
 * Exact-output Script/SPV validation under the host's immutable header policy.
 * Publisher authentication, schema/key-content validation, current authorization
 * and durable reservation remain separate service duties. No private bytes are
 * sent to the chain resolver, network discovery or public admission here.
 */
export class SDKPrivatePublicationEvidence {
  private readonly verifier: SDKEvidenceVerifier
  private readonly extensions: readonly string[]

  constructor(
    chains: ChainViewResolver,
    private readonly context: (
      request: OutputPrivatePublish,
      publisher: string,
      chain: OutputChain
    ) => VerificationContext,
    limits: Partial<TransactionEvidenceLimits> = {},
    supportedExtensions: readonly string[] = []
  ) {
    this.verifier = new SDKEvidenceVerifier(chains, limits)
    this.extensions = [...supportedExtensions]
  }

  async verify(
    input: OutputPrivatePublish,
    publisher: string,
    chain: OutputChain,
    signal: AbortSignal = new AbortController().signal
  ): Promise<VerifiedPrivatePublicationEvidence> {
    const request = parseOutputPrivatePublish(input, this.extensions)
    const author = outputIdentity(publisher),
      selectedChain = parseOutputChain(chain)
    const snapshot = parseVerificationContext(
      this.context(structuredClone(request), author, structuredClone(selectedChain))
    )
    outputAssert(
      canonicalOutputJSON(snapshot.view.chain) === canonicalOutputJSON(selectedChain),
      'Private publication chain context differs',
      'context-changed'
    )
    const bytes = decodeOutputBytes(request.evidence.beef)
    const result = await this.verifier.verify(
      {
        chain: selectedChain,
        evidence: request.evidence,
        variantId: Utils.toHex(Hash.sha256(bytes))
      },
      snapshot,
      signal
    )
    if (result.status !== 'verified') {
      const code = result.status === 'unresolved' ? 'unavailable' : result.status
      throw new OutputProtocolError(
        code,
        `Private publication evidence verification ${result.status}`,
        ['unavailable', 'limited', 'cancelled', 'context-changed'].includes(code)
      )
    }
    // Engine.submit consumes the BEEF default transaction. An aggregate containing
    // the requested transaction elsewhere cannot silently select another target.
    // Exact bytes already bind the verified txid and are stronger than a repeated hash check.
    const target = Transaction.fromBEEF(bytes)
    outputAssert(
      Utils.toBase64(target.toBinary()) === result.fact.rawTransaction,
      'Private publication BEEF default target differs'
    )
    return {
      rawTransaction: result.fact.rawTransaction,
      requestDigest: outputPrivatePublicationRequestDigest(request, this.extensions),
      publisher: author,
      verificationContext: snapshot
    }
  }
}
