import { Beef } from '@bsv/sdk'

/**
 * Restricts an AtomicBEEF envelope to the transaction named by its BRC-95
 * prefix and that transaction's recursive dependency closure.
 *
 * Older senders could serialize unrelated, otherwise valid BEEF branches into
 * an AtomicBEEF envelope. Those branches are not part of the payment proof and
 * must not influence internalization. Proof and transaction validation still
 * run against the returned closure at each wallet trust boundary.
 */
export function canonicalizeAtomicBeef(bytes: number[] | Uint8Array): Beef {
  const received = bytes instanceof Uint8Array ? Beef.fromBinaryView(bytes) : Beef.fromBinary(bytes)
  const txid = received.atomicTxid

  // Preserve the existing validation path and error identity for malformed
  // envelopes whose subject is absent or cannot be resolved.
  if (txid == null || received.findTxid(txid) == null || received.isAtomic(txid)) return received

  return Beef.fromBinary(received.toBinaryAtomic(txid))
}
