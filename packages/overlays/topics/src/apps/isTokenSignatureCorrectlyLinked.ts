import { PublicKey, ProtoWallet, PubKeyHex, WalletProtocol } from '@bsv/sdk'

export const isTokenSignatureCorrectlyLinked = async (
  lockingPublicKey: PublicKey,
  publisher: PubKeyHex,
  fields: number[][]
): Promise<boolean> => {
  const signature = fields.pop()!
  const protocolID: WalletProtocol = [1, 'metanet apps']
  const data = fields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  try {
    const { valid } = await anyoneWallet.verifySignature({
      data,
      signature,
      counterparty: publisher,
      protocolID,
      keyID: '1'
    })
    if (!valid) return false
  } catch (_e) {
    // Signature verification threw (e.g. malformed key/data) — treat as invalid
    return false
  }

  const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
    counterparty: publisher,
    protocolID,
    keyID: '1'
  })
  return expectedLockingPublicKey === lockingPublicKey.toString()
}
