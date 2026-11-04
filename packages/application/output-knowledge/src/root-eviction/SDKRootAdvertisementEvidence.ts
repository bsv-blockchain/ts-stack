import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputRootAdvertisementDigest,
  OverlayAdminTokenTemplate,
  OutputProtocolError,
  parseOutputJSON,
  Transaction,
  Utils,
  type OutputEvidence,
  type OverlayDiscoveryAdvertisement,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext, VerificationResult } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import { rootTarget } from './RootEvictionCodec.js'
import type { RootEvictionServingTarget } from './RootEvictionStorage.js'

export interface RootAdvertisementEvidenceInput {
  target: RootEvictionServingTarget
  advertisement: OutputEvidence
}

/** Authenticated advertisement facts, without an assertion of current unspentness or permission to serve. */
export interface RootVerifiedAdvertisement {
  target: RootEvictionServingTarget
  advertisement: OverlayDiscoveryAdvertisement
  rawAdvertisementTransaction: string
  verificationContext: VerificationContext
  advertisementPlacement?: { blockHash: string; height: string }
}

type VerifiedTransaction = Extract<VerificationResult, { status: 'verified' }>

/** Internal shared transaction check; callers first own and validate their target/evidence. */
export async function verifyRootEvidenceTransaction(
  verifier: SDKEvidenceVerifier,
  evidence: OutputEvidence,
  chain: RootEvictionServingTarget['outpoint']['chain'],
  context: VerificationContext,
  signal: AbortSignal
): Promise<VerifiedTransaction> {
  const result = await verifier.verify(
    {
      chain,
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

/** Internal composition point, preserving one bounded verifier for an entire peer request. */
export async function verifyRootAdvertisement(
  verifier: SDKEvidenceVerifier,
  input: RootAdvertisementEvidenceInput,
  context: VerificationContext,
  signal: AbortSignal
): Promise<RootVerifiedAdvertisement> {
  const owned = parseOutputJSON(canonicalOutputJSON(input, { bytes: 1048576 }))
  closedOutputObject(owned, ['target', 'advertisement'])
  closedOutputObject(owned.target, ['service', 'outpoint', 'advertisementDigest'])
  closedOutputObject(owned.target.outpoint, ['chain', 'txid', 'outputIndex'])
  closedOutputObject(owned.target.outpoint.chain, ['network', 'genesisHash'])
  const target = rootTarget(owned.target as unknown as RootEvictionServingTarget)
  closedOutputObject(owned.advertisement, ['txid', 'outputIndex', 'beef'])
  const evidence = owned.advertisement as unknown as OutputEvidence
  outputAssert(
    evidence.txid === target.outpoint.txid && evidence.outputIndex === target.outpoint.outputIndex,
    'Advertisement selects another output'
  )
  const snapshot = parseVerificationContext(context)
  const original = await verifyRootEvidenceTransaction(
    verifier,
    evidence,
    target.outpoint.chain,
    snapshot,
    signal
  )
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
  if (signal.aborted)
    throw new OutputProtocolError('cancelled', 'Root evidence verification cancelled', true)
  return {
    target,
    advertisement,
    rawAdvertisementTransaction: original.fact.rawTransaction,
    verificationContext: snapshot,
    ...(original.placement ? { advertisementPlacement: original.placement } : {})
  }
}

/**
 * Independently verifies bounded current-format SHIP/SLAP evidence for local
 * admission and reassessment. It needs no fabricated peer request or requester
 * signature. The advertisement's own authentication and Bitcoin evidence are
 * checked against the selected immutable chain view. Installed currentness,
 * topic rules, local policy and final serving fences remain separate obligations.
 */
export class SDKRootAdvertisementEvidence {
  private readonly verifier: SDKEvidenceVerifier

  constructor(chains: ChainViewResolver, limits: Partial<TransactionEvidenceLimits> = {}) {
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }

  async verify(
    input: RootAdvertisementEvidenceInput,
    context: VerificationContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RootVerifiedAdvertisement> {
    return await verifyRootAdvertisement(this.verifier, input, context, signal)
  }
}
