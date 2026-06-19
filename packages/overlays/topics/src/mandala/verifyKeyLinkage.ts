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
