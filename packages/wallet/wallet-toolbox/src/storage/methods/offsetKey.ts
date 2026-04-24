import { PublicKey, BigNumber, PrivateKey, Curve, P2PKH, PubKeyHex, CreateActionInput } from '@bsv/sdk'
import { TableCommission } from '../schema/tables/TableCommission'
import { sha256Hash } from '../../utility/utilityHelpers'

export function keyOffsetToHashedSecret(
  pub: PublicKey,
  keyOffset?: string
): { hashedSecret: BigNumber; keyOffset: string } {
  let offset: PrivateKey
  if (keyOffset !== undefined && typeof keyOffset === 'string') {
    if (keyOffset.length === 64) offset = PrivateKey.fromString(keyOffset, 'hex')
    else offset = PrivateKey.fromWif(keyOffset)
  } else {
    offset = PrivateKey.fromRandom()
    keyOffset = offset.toWif()
  }

  const sharedSecret = pub.mul(offset).encode(true, undefined) as number[]
  const hashedSecret = sha256Hash(sharedSecret)

  return { hashedSecret: new BigNumber(hashedSecret), keyOffset }
}

export function offsetPrivKey(privKey: string, keyOffset?: string): { offsetPrivKey: string; keyOffset: string } {
  const priv = PrivateKey.fromWif(privKey)

  const pub = priv.toPublicKey()

  const r = keyOffsetToHashedSecret(pub, keyOffset)

  const bn = priv.add(r.hashedSecret).mod(new Curve().n)

  const offsetPrivKey = new PrivateKey(bn).toWif()

  return { offsetPrivKey, keyOffset: r.keyOffset }
}

export function offsetPubKey(pubKey: string, keyOffset?: string): { offsetPubKey: string; keyOffset: string } {
  const pub = PublicKey.fromString(pubKey)

  const r = keyOffsetToHashedSecret(pub, keyOffset)

  // The hashed secret is multiplied by the generator point.
  const point = new Curve().g.mul(r.hashedSecret)

  // The resulting point is added to the recipient public key.
  const offsetPubKey = new PublicKey(pub.add(point))

  return { offsetPubKey: offsetPubKey.toString(), keyOffset: r.keyOffset }
}

export function lockScriptWithKeyOffsetFromPubKey(
  pubKey: string,
  keyOffset?: string
): { script: string; keyOffset: string } {
  const r = offsetPubKey(pubKey, keyOffset)

  const offsetPub = PublicKey.fromString(r.offsetPubKey)

  const hash = offsetPub.toHash() as number[]

  const script = new P2PKH().lock(hash).toHex()

  return { script, keyOffset: r.keyOffset }
}

export function createStorageServiceChargeScript(pubKeyHex: PubKeyHex): {
  script: string
  keyOffset: string
} {
  return lockScriptWithKeyOffsetFromPubKey(pubKeyHex)
}

export function redeemServiceCharges(privateKeyWif: string, charges: TableCommission[]): {}[] {
  const priv = PrivateKey.fromWif(privateKeyWif)
  const pub = priv.toPublicKey()
  const p2pkh = new P2PKH()

  const inputs: CreateActionInput[] = []

  for (const c of charges) {
    const { hashedSecret } = keyOffsetToHashedSecret(pub, c.keyOffset)
    const bn = priv.add(hashedSecret).mod(new Curve().n)
    const offsetPrivKey = new PrivateKey(bn)
    //const unlock = p2pkh.unlock(offsetPrivKey, signOutputs, anyoneCanPay)
  }

  return []
}
