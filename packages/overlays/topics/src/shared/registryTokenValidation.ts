import {
  KeyDeriver,
  ProtoWallet,
  PublicKey,
  Utils,
  WalletProtocol
} from '@bsv/sdk'

export function decodeRegistryUtf8Fields(fields: number[][], fieldCount: number): string[] {
  if (fields.length < fieldCount + 1) throw new Error('Registry token fields are missing')
  return fields.slice(0, fieldCount).map(field => Utils.toUTF8(field))
}

interface VerifyRegistryTokenOptions {
  fields: number[][]
  lockingPublicKey: PublicKey
  registryOperator: string
  protocolID: WalletProtocol
  linkageError: string
}

export async function verifyRegistryToken({
  fields,
  lockingPublicKey,
  registryOperator,
  protocolID,
  linkageError
}: VerifyRegistryTokenOptions): Promise<void> {
  const keyDeriver = new KeyDeriver('anyone')
  const expected = keyDeriver.derivePublicKey(protocolID, '1', registryOperator)
  if (expected.toString() !== lockingPublicKey.toString()) throw new Error(linkageError)

  const signature = fields.at(-1)!
  const data = fields.slice(0, -1).flat()
  const anyoneWallet = new ProtoWallet('anyone')
  const { valid } = await anyoneWallet.verifySignature({
    data,
    signature,
    counterparty: registryOperator,
    protocolID,
    keyID: '1'
  })
  if (!valid) throw new Error('Invalid signature!')
}
