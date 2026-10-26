import { toHex } from '@bsv/sdk/primitives/utils'
import { PublicKey, ProtoWallet } from '@bsv/sdk'
export const isTokenSignatureCorrectlyLinked = async (
  lockingPublicKey: PublicKey,
  fields: number[][]
): Promise<boolean> => {
  if (!Array.isArray(fields) || fields.length !== 6) return false
  const dataFields = fields.slice(0, -1)
  const signature = fields.at(-1)!
  const protocolID: [2, string] = [2, 'uhrp advertisement']
  const identityKey = toHex(dataFields[0])
  const data = dataFields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  try {
    const { valid } = await anyoneWallet.verifySignature({
      data,
      signature,
      counterparty: identityKey,
      protocolID,
      keyID: '1'
    })
    if (valid !== true) return false
  } catch {
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
