import { ChainTracker, TransactionEvidence, TransactionEvidenceCoordinator, VerifiedTransactionOutput } from '@bsv/sdk'

/** Untrusted lookup evidence. A host's txid and context are never chain authority. */
export interface OverlayOutputEvidence extends TransactionEvidence {
  context?: number[]
}

export type VerifiedOverlayOutput = VerifiedTransactionOutput

/**
 * Independently verify one byte-bound output using the caller's canonical chain
 * source. Repeated consumers can use the SDK TransactionEvidenceCoordinator.
 */
export async function verifyOverlayOutput(
  evidence: OverlayOutputEvidence,
  chainTracker: ChainTracker
): Promise<VerifiedOverlayOutput> {
  const coordinator = new TransactionEvidenceCoordinator({
    chainTracker,
    chainNamespace: 'caller-chain-tracker',
    policyId: 'sdk-spv-overlay-graph-v1'
  })
  try {
    return await coordinator.verify(evidence)
  } finally {
    coordinator.dispose()
  }
}
