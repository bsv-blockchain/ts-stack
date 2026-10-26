import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray } from '@bsv/sdk/primitives/utils'
import { WalletInterface, Curve, BigNumber, PublicKey } from '@bsv/sdk'
import { SpecificLinkage } from './types.js'

interface VerifiedLinkage {
  identityKey: string
  derivedKey: string
  pubKeyHash: number[]
}

/**
 * Decrypt the linkage scalar L and reconstruct `base + L*G`.
 *
 * The prover encrypted L to the verifier under a derived "specific linkage
 * revelation" protocol keyed by the original protocolID + keyID, with the
 * prover as counterparty. Which key is the base — and therefore which party
 * the linkage names — is the one thing an output linkage and an input linkage
 * disagree on, so the caller supplies it.
 */
async function deriveLinkedKey(
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface,
  identityKey: string
): Promise<VerifiedLinkage> {
  const { plaintext } = await verifierWallet.decrypt({
    ciphertext: linkage.encryptedLinkage,
    protocolID: [
      2,
      `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`
    ],
    keyID: linkage.keyID,
    counterparty: linkage.prover
  })
  const offset = new Curve().g.mul(new BigNumber(plaintext))
  const sum = PublicKey.fromString(identityKey).add(offset)
  const derivedKey = new PublicKey(sum.x, sum.y).toString()
  return { identityKey, derivedKey, pubKeyHash: hash160(toArray(derivedKey, 'hex')) }
}

/**
 * Verify a linkage revealed for an OUTPUT: the linkage declares the recipient,
 * so the derived key is `counterparty + L*G` and the party named is the
 * counterparty.
 */
export async function verifyKeyLinkage(
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface
): Promise<VerifiedLinkage> {
  return await deriveLinkedKey(linkage, verifierWallet, linkage.counterparty)
}

/**
 * Verify a linkage revealed for a coin BEING SPENT.
 *
 * For an INPUT the revealer is the spender: the coin was locked to the
 * spender's own child key, so the key is `prover + L*G` and the party is the
 * prover. Checking an input against `counterparty` instead would reconstruct
 * the key of whoever PAID that coin — it never matches the coin being spent,
 * and under sender blinding it is a one-time key that is not an identity at all.
 */
export async function verifyInputKeyLinkage(
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface
): Promise<VerifiedLinkage> {
  return await deriveLinkedKey(linkage, verifierWallet, linkage.prover)
}

export async function linkageControlsPubKeyHash(
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
