import { WalletInterface, Curve, BigNumber, PublicKey, Hash, Utils } from '@bsv/sdk'
import { SpecificLinkage } from './types.js'

export async function verifyKeyLinkage (
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface
): Promise<{ identityKey: string, derivedKey: string, pubKeyHash: number[] }> {
  // 1. Decrypt the linkage scalar L. The prover encrypted it to the verifier
  //    under a derived "specific linkage revelation" protocol keyed by the
  //    original protocolID + keyID, with the prover as counterparty.
  const { plaintext } = await verifierWallet.decrypt({
    ciphertext: linkage.encryptedLinkage,
    protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })

  // 2. derivedKey = counterpartyIdentityKey + L*G  (secp256k1 point addition)
  const curve = new Curve()
  const L = new BigNumber(plaintext)
  const offset = curve.g.mul(L)
  const counterparty = PublicKey.fromString(linkage.counterparty)
  const sum = counterparty.add(offset)
  const derived = new PublicKey(sum.x, sum.y)
  const derivedKey = derived.toString()
  const pubKeyHash = Hash.hash160(Utils.toArray(derivedKey, 'hex'))

  return { identityKey: linkage.counterparty, derivedKey, pubKeyHash }
}

/**
 * Verify a linkage revealed for a coin BEING SPENT.
 *
 * For an OUTPUT the linkage declares the recipient, so the derived key is
 * `counterparty + L*G` and the party named is the counterparty
 * ({@link verifyKeyLinkage}). For an INPUT the revealer is the spender: the
 * coin was locked to the spender's own child key, so the key is
 * `prover + L*G` and the party is the prover.
 *
 * Checking an input against `counterparty` reconstructs the key of whoever
 * PAID that coin. It never matches the coin being spent, and under sender
 * blinding it is a one-time key that is not an identity at all.
 */
export async function verifyInputKeyLinkage (
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface
): Promise<{ identityKey: string, derivedKey: string, pubKeyHash: number[] }> {
  const { plaintext } = await verifierWallet.decrypt({
    ciphertext: linkage.encryptedLinkage,
    protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })
  const curve = new Curve()
  const L = new BigNumber(plaintext)
  const offset = curve.g.mul(L)
  const prover = PublicKey.fromString(linkage.prover)
  const sum = prover.add(offset)
  const derived = new PublicKey(sum.x, sum.y)
  return {
    identityKey: linkage.prover,
    derivedKey: derived.toString(),
    pubKeyHash: Hash.hash160(Utils.toArray(derived.toString(), 'hex'))
  }
}

export async function linkageControlsPubKeyHash (
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface,
  pubKeyHash: number[]
): Promise<boolean> {
  try {
    const { pubKeyHash: derivedHash } = await verifyKeyLinkage(linkage, verifierWallet)
    if (derivedHash.length !== pubKeyHash.length) return false
    return derivedHash.every((b, i) => b === pubKeyHash[i])
  } catch {
    return false
  }
}
