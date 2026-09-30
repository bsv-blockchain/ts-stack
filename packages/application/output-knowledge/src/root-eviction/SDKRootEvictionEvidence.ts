import {
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputPacketDigest,
  outputRootAdvertisementDigest,
  OverlayAdminTokenTemplate,
  OutputProtocolError,
  parseOutputRootEvictionRequest,
  Transaction,
  Utils,
  verifyOutputPacket,
  type OutputEvidence,
  type OutputRootEvictionTarget,
  type OverlayDiscoveryAdvertisement,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext, VerificationResult } from '../ports.js'
import { parseVerificationContext } from '../validation.js'

type VerifiedTransaction = Extract<VerificationResult, { status: 'verified' }>

/** Verified facts are inputs to installed root policy, never an automatic serving decision. */
export interface RootEvictionVerifiedEvidence {
  requestDigest: string
  targetIndex: number
  target: OutputRootEvictionTarget
  advertisement: OverlayDiscoveryAdvertisement
  rawAdvertisementTransaction: string
  verificationContext: VerificationContext
  advertisementPlacement?: { blockHash: string; height: string }
  /** Operator references are deliberately not resolved or authorized by this component. */
  proof:
    | { kind: 'owner-withdrawal'; advertiser: string }
    | { kind: 'spent'; rawTransaction: string; placement?: { blockHash: string; height: string } }
    | { kind: 'operator-policy'; policy: string; detailDigest: string }
}

/**
 * Verify current-format SHIP/SLAP bytes, advertiser attribution and exact spent
 * evidence through the bounded SDK verifier and one owned immutable chain view.
 * The host separately checks authenticated transport, selected capabilities,
 * requester/restore authority, acceptance thresholds, topic rules and currentness.
 */
export class SDKRootEvictionEvidence {
  private readonly verifier: SDKEvidenceVerifier

  constructor(chains: ChainViewResolver, limits: Partial<TransactionEvidenceLimits> = {}) {
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }

  async verify(
    input: unknown,
    targetIndex: number,
    context: VerificationContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RootEvictionVerifiedEvidence> {
    const request = parseOutputRootEvictionRequest(input)
    outputAssert(
      Number.isSafeInteger(targetIndex) &&
        targetIndex >= 0 &&
        targetIndex < request.body.targets.length,
      'Root evidence selects an absent target'
    )
    outputAssert(
      verifyOutputPacket('root-eviction-request', request, request.body.requester),
      'Root evidence request signature failed',
      'unauthorized'
    )
    const snapshot = parseVerificationContext(context)
    const target = request.body.targets[targetIndex]
    const original = await this.transaction(target.advertisement, target, snapshot, signal)
    const transaction = Transaction.fromBinary(decodeOutputBytes(original.fact.rawTransaction))
    const script = transaction.outputs[target.outpoint.outputIndex].lockingScript
    const advertisement = await OverlayAdminTokenTemplate.decodeAndVerify(
      script,
      target.service === 'ls_ship' ? 'SHIP' : 'SLAP'
    ).catch(() => {
      throw new OutputProtocolError('invalid', 'Root advertisement authentication failed')
    })
    outputAssert(
      outputRootAdvertisementDigest({
        service: target.service,
        outpoint: target.outpoint,
        lockingScript: Utils.toBase64(script.toBinary())
      }) === target.advertisementDigest,
      'Root advertisement digest differs from verified output'
    )
    const proof = await this.proof(
      target,
      request.body.requester,
      advertisement.identityKey,
      original,
      snapshot,
      signal
    )
    if (signal.aborted)
      throw new OutputProtocolError('cancelled', 'Root evidence verification cancelled', true)
    return {
      requestDigest: outputPacketDigest('root-eviction-request', request.body),
      targetIndex,
      target,
      advertisement,
      rawAdvertisementTransaction: original.fact.rawTransaction,
      verificationContext: snapshot,
      ...(original.placement ? { advertisementPlacement: original.placement } : {}),
      proof
    }
  }

  private async proof(
    target: OutputRootEvictionTarget,
    requester: string,
    advertiser: string,
    original: VerifiedTransaction,
    context: VerificationContext,
    signal: AbortSignal
  ): Promise<RootEvictionVerifiedEvidence['proof']> {
    const evidence = target.evidence
    if (evidence.kind === 'operator-policy') return { ...evidence }
    if (evidence.kind === 'owner-withdrawal') {
      outputAssert(
        requester === advertiser,
        'Withdrawal requester is not the advertiser',
        'unauthorized'
      )
      const owner = await this.transaction(evidence.advertisement, target, context, signal)
      outputAssert(
        owner.fact.rawTransaction === original.fact.rawTransaction,
        'Owner withdrawal differs from the original advertisement transaction'
      )
      return { kind: 'owner-withdrawal', advertiser }
    }
    const spent = await this.transaction(
      { txid: evidence.txid, outputIndex: 0, beef: evidence.beef },
      target,
      context,
      signal
    )
    const transaction = Transaction.fromBinary(decodeOutputBytes(spent.fact.rawTransaction))
    outputAssert(
      transaction.inputs.some(
        input =>
          input.sourceTXID === target.outpoint.txid &&
          input.sourceOutputIndex === target.outpoint.outputIndex
      ),
      'Spent evidence does not consume the exact advertisement'
    )
    return {
      kind: 'spent',
      rawTransaction: spent.fact.rawTransaction,
      ...(spent.placement ? { placement: spent.placement } : {})
    }
  }

  private async transaction(
    evidence: OutputEvidence,
    target: OutputRootEvictionTarget,
    context: VerificationContext,
    signal: AbortSignal
  ): Promise<VerifiedTransaction> {
    const result = await this.verifier.verify(
      {
        chain: target.outpoint.chain,
        evidence,
        variantId: Utils.toHex(Hash.sha256(decodeOutputBytes(evidence.beef)))
      },
      context,
      signal
    )
    if (result.status !== 'verified') {
      const code = result.status === 'unresolved' ? 'unavailable' : result.status
      throw new OutputProtocolError(
        code,
        `Root evidence verification ${result.status}`,
        ['unavailable', 'limited', 'cancelled', 'context-changed'].includes(code)
      )
    }
    return result
  }
}
