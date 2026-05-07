import { PublicKey, ProtoWallet, Utils } from '@bsv/sdk'

export const isTokenSignatureCorrectlyLinked = async (
  lockingPublicKey: PublicKey,
  fields: number[][]
): Promise<boolean> => {
  const signature = fields.pop()!
  const protocolID: [2, string] = [2, 'uhrp advertisement']
  const identityKey = Utils.toHex(fields[0])
  const data = fields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  try {
    const { valid } = await anyoneWallet.verifySignature({
      data,
      signature,
      counterparty: identityKey,
      protocolID,
      keyID: '1'
    })
    if (!valid) return false
  } catch (_e) {
    // Signature verification threw (e.g. malformed key/data) — treat as invalid
    return false
  }

  const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
    counterparty: identityKey,
    protocolID,
    keyID: '1'
  })
  return expectedLockingPublicKey === lockingPublicKey.toString()
}
