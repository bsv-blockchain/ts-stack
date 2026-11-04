import {
  LockingScript,
  MerklePath,
  OP,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript
} from '@bsv/sdk'
import type { PublicKey } from '@bsv/sdk'

/**
 * Builds a payment transaction as Atomic BEEF without any network access.
 *
 * The parent is a coinbase-style transaction proven by a single-leaf `MerklePath`
 * (it is the only transaction in its block, so its txid is the merkle root). The
 * child spends the parent's P2PKH output and pays `satoshis` to P2PKH of `payTo`
 * at output 0. Scripts are never executed, so the child's unlocking script is an
 * empty placeholder rather than a real signature.
 *
 * `padBytes` adds a zero-value `OP_FALSE OP_RETURN` output (output 1) carrying that
 * many filler bytes, to make a large transaction.
 */
export function makePaymentTx(
  payTo: PublicKey,
  satoshis: number,
  o: { padBytes?: number } = {}
): { beef: number[]; txid: string } {
  const funding = PrivateKey.fromRandom().toPublicKey()

  const parent = new Transaction()
  parent.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: new UnlockingScript()
  })
  parent.addOutput({ lockingScript: new P2PKH().lock(funding.toHash()), satoshis: satoshis + 1000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 1)

  const child = new Transaction()
  child.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  child.addOutput({ lockingScript: new P2PKH().lock(payTo.toHash()), satoshis })
  if (o.padBytes !== undefined && o.padBytes > 0) {
    const data = Array.from({ length: o.padBytes }, (_, i) => (i * 31 + 7) & 255)
    const lockingScript = new LockingScript()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_RETURN)
      .writeBin(data)
    child.addOutput({ lockingScript, satoshis: 0 })
  }

  return { beef: child.toAtomicBEEF(), txid: child.id('hex') }
}
