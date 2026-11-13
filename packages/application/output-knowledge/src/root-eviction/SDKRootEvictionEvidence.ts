import {
  decodeOutputBytes,
  outputAssert,
  outputPacketDigest,
  OutputProtocolError,
  parseOutputRootEvictionRequest,
  Transaction,
  verifyOutputPacket,
  type OutputRootEvictionTarget,
  type OverlayDiscoveryAdvertisement,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'

import {
  verifyRootAdvertisement,
  verifyRootEvidenceTransaction,
  type RootVerifiedAdvertisement
} from './SDKRootAdvertisementEvidence.js'

export { SDKRootAdvertisementEvidence } from './SDKRootAdvertisementEvidence.js'
export type {
  RootAdvertisementEvidenceInput,
  RootVerifiedAdvertisement
} from './SDKRootAdvertisementEvidence.js'

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
    const original = await verifyRootAdvertisement(
      this.verifier,
      {
        target: {
          service: target.service,
          outpoint: target.outpoint,
          advertisementDigest: target.advertisementDigest
        },
        advertisement: target.advertisement
      },
      snapshot,
      signal
    )
    const proof = await this.proof(
      target,
      request.body.requester,
      original.advertisement.identityKey,
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
      advertisement: original.advertisement,
      rawAdvertisementTransaction: original.rawAdvertisementTransaction,
      verificationContext: snapshot,
      ...(original.advertisementPlacement
        ? { advertisementPlacement: original.advertisementPlacement }
        : {}),
      proof
    }
  }

  private async proof(
    target: OutputRootEvictionTarget,
    requester: string,
    advertiser: string,
    original: RootVerifiedAdvertisement,
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
      const owner = await verifyRootEvidenceTransaction(
        this.verifier,
        evidence.advertisement,
        target.outpoint.chain,
        context,
        signal
      )
      outputAssert(
        owner.fact.rawTransaction === original.rawAdvertisementTransaction,
        'Owner withdrawal differs from the original advertisement transaction'
      )
      return { kind: 'owner-withdrawal', advertiser }
    }
    const spent = await verifyRootEvidenceTransaction(
      this.verifier,
      { txid: evidence.txid, outputIndex: 0, beef: evidence.beef },
      target.outpoint.chain,
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
}
