import { PublicKey, ProtoWallet, Utils } from '@bsv/sdk'

export const isTokenSignatureCorrectlyLinked = async (
  lockingPublicKey: PublicKey,
  fields: number[][]
): Promise<boolean> => {
  const signature = fields.pop() as number[]
  const protocolID: [2, string] = [2, 'uhrp advertisement']
  const identityKey = Utils.toHex(fields[0])
  const data = fields.reduce((a, e) => [...a, ...e], [])
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
  } catch (e) {
    return false
  }

  const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
    counterparty: identityKey,
    protocolID,
    keyID: '1'
  })
  return expectedLockingPublicKey === lockingPublicKey.toString()
}
