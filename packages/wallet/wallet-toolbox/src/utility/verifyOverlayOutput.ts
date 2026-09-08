import { ChainTracker, LockingScript, Transaction } from '@bsv/sdk'

/** Untrusted lookup evidence. A host's txid and context are never chain authority. */
export interface OverlayOutputEvidence {
  beef: number[]
  outputIndex: number
  txid?: string
  context?: number[]
}

/** A per-call verdict, for service validation now; not a reusable chain/cache verdict. */
export interface VerifiedOverlayOutput {
  readonly txid: string
  readonly outputIndex: number
  readonly lockingScript: LockingScript
}

/**
 * Independently verify a byte-bound output using the caller's canonical chain source.
 * No network defaults, scripts-only mode, verdict cache, or identity semantics live here.
 * Errors and false verdicts reject this evidence candidate, not its txid permanently.
 */
export async function verifyOverlayOutput(
  evidence: OverlayOutputEvidence,
  chainTracker: ChainTracker
): Promise<VerifiedOverlayOutput> {
  if (chainTracker == null || typeof chainTracker.isValidRootForHeight !== 'function') {
    throw new Error('Overlay verification requires a ChainTracker')
  }
  const { outputIndex, txid: hint } = evidence
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw new Error('Invalid overlay output index')
  }
  // Own the bytes before the first await: callers cannot change the candidate in flight.
  const bytes = evidence.beef.slice()
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Invalid overlay transaction bytes')
  }
  const tx = Transaction.fromBEEF(bytes)
  const txid = tx.id('hex')
  if (hint !== undefined && (typeof hint !== 'string' || hint.toLowerCase() !== txid)) {
    throw new Error('Overlay txid does not match transaction bytes')
  }
  if (outputIndex >= tx.outputs.length) throw new Error('Overlay output does not exist')

  // SDK graph verification checks scripts and values. Also require every unconfirmed
  // branch to have inputs, so a fabricated zero-value, input-free leaf cannot anchor it.
  const pending = [tx]
  const visited = new Set<string>()
  const spentOutpoints = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    const currentTxid = current.id('hex')
    if (visited.has(currentTxid)) continue
    visited.add(currentTxid)
    if (current.merklePath != null) continue
    if (current.inputs.length === 0) throw new Error('Unconfirmed transaction has no ancestry')
    for (const input of current.inputs) {
      if (input.sourceTransaction == null) throw new Error('Overlay transaction ancestry is missing')
      const sourceTxid = input.sourceTransaction.id('hex')
      if (input.sourceTXID !== undefined && input.sourceTXID !== sourceTxid) {
        throw new Error('Overlay input does not match its source transaction')
      }
      const outpoint = `${sourceTxid}.${input.sourceOutputIndex}`
      // Script verification alone can count the same value twice. Reject both
      // duplicate inputs and conflicting spends among unconfirmed ancestors.
      if (spentOutpoints.has(outpoint)) throw new Error('Overlay transaction graph spends an outpoint twice')
      spentOutpoints.add(outpoint)
      pending.push(input.sourceTransaction)
    }
  }

  const canonicalTracker: ChainTracker = {
    currentHeight: async () => await chainTracker.currentHeight(),
    isValidRootForHeight: async (root, height) => (await chainTracker.isValidRootForHeight(root, height)) === true
  }
  if ((await tx.verify(canonicalTracker)) !== true) throw new Error('Overlay transaction verification failed')
  return { txid, outputIndex, lockingScript: tx.outputs[outputIndex].lockingScript }
}
