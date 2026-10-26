import { KeyDeriver } from '../wallet/KeyDeriver.js'
import ProtoWallet from '../wallet/ProtoWallet.js'
import PublicKey from '../primitives/PublicKey.js'
import { toUTF8Strict } from '../primitives/utils.js'
import LockingScript from '../script/LockingScript.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import type { WalletProtocol } from '../wallet/Wallet.interfaces.js'
import type { DefinitionType } from './types/index.js'

const MAX_REGISTRY_FIELD_BYTES = 16 * 1024
const MAX_REGISTRY_TOKEN_BYTES = 64 * 1024

const tokenShape: Record<DefinitionType, { dataFields: number; protocolID: WalletProtocol }> = {
  basket: { dataFields: 6, protocolID: [1, 'basketmap'] },
  protocol: { dataFields: 6, protocolID: [1, 'protomap'] },
  certificate: { dataFields: 7, protocolID: [1, 'certmap'] }
}

/** Decode and cryptographically authenticate a canonical operator-signed PushDrop token. */
export async function decodeAndVerifySignedPushDropToken(
  lockingScript: LockingScript,
  dataFieldCount: number,
  protocolID: WalletProtocol
): Promise<string[]> {
  if (!Number.isSafeInteger(dataFieldCount) || dataFieldCount < 1 || dataFieldCount > 64) {
    throw new Error('Registry token field count is invalid')
  }
  const { fields, lockingPublicKey } = decodeCanonicalPushDrop(lockingScript, {
    fieldCount: dataFieldCount + 1,
    maximumFieldBytes: MAX_REGISTRY_FIELD_BYTES,
    maximumPayloadBytes: MAX_REGISTRY_TOKEN_BYTES
  })

  const decoded = fields.slice(0, -1).map(field => toUTF8Strict(field))
  const registryOperator = decoded.at(-1)!
  PublicKey.fromString(registryOperator)
  const expectedLockingKey = new KeyDeriver('anyone').derivePublicKey(
    protocolID,
    '1',
    registryOperator
  )
  if (expectedLockingKey.toString() !== lockingPublicKey.toString()) {
    throw new Error('Registry token locking key is not linked to its operator')
  }
  const { valid } = await new ProtoWallet('anyone').verifySignature({
    data: fields.slice(0, -1).flat(),
    signature: fields.at(-1)!,
    counterparty: registryOperator,
    protocolID,
    keyID: '1'
  })
  if (valid !== true) throw new Error('Registry token signature is invalid')
  return decoded
}

/** Decode and cryptographically authenticate one canonical registry token. */
export async function decodeAndVerifyRegistryToken(
  definitionType: DefinitionType,
  lockingScript: LockingScript
): Promise<string[]> {
  const shape = tokenShape[definitionType]
  if (shape == null) throw new Error('Unsupported registry definition type')
  return await decodeAndVerifySignedPushDropToken(lockingScript, shape.dataFields, shape.protocolID)
}
