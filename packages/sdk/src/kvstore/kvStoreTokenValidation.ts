import PublicKey from '../primitives/PublicKey.js'
import { toHex, toUTF8Strict } from '../primitives/utils.js'
import LockingScript from '../script/LockingScript.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import { KeyDeriver } from '../wallet/KeyDeriver.js'
import ProtoWallet from '../wallet/ProtoWallet.js'
import type { WalletProtocol } from '../wallet/Wallet.interfaces.js'
import { utf8ByteLength } from '../primitives/UTF8.js'

const MAX_KEY_BYTES = 800
const MAX_VALUE_BYTES = 1024 * 1024
const MAX_TAGS = 32
const MAX_TAG_BYTES = 256

export interface AuthenticatedKVStoreToken {
  protocolID: WalletProtocol
  protocolIDText: string
  key: string
  value: string
  controller: string
  tags?: string[]
}

function utf8Length(value: string): number {
  return utf8ByteLength(value)
}

export function validateKVStoreProtocol(value: unknown): WalletProtocol {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('KVStore protocol ID must contain exactly two fields')
  }
  const security = value[0]
  const name = value[1]
  if ((security !== 0 && security !== 1 && security !== 2) || typeof name !== 'string') {
    throw new Error('KVStore protocol ID is invalid')
  }
  const nameBytes = utf8Length(name)
  if (nameBytes < 5 || nameBytes > 400) throw new Error('KVStore protocol name is invalid')
  return [security, name]
}

export function validateKVStoreKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('KVStore key must be a string')
  const length = utf8Length(value)
  if (length < 1 || length > MAX_KEY_BYTES) throw new Error('KVStore key has an invalid length')
  return value
}

export function validateKVStoreValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('KVStore value must be a string')
  const length = utf8Length(value)
  if (length < 1 || length > MAX_VALUE_BYTES) {
    throw new Error('KVStore value has an invalid length')
  }
  return value
}

export function validateKVStoreTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new Error('KVStore tags must be a bounded array')
  }
  const tags: string[] = []
  const seen = new Set<string>()
  for (const tag of value) {
    if (typeof tag !== 'string' || utf8Length(tag) < 1 || utf8Length(tag) > MAX_TAG_BYTES) {
      throw new Error('KVStore tag has an invalid length')
    }
    if (seen.has(tag)) throw new Error('KVStore tags must be unique')
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

export function validateKVStoreController(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 66) {
    throw new Error('KVStore controller must be a compressed public key')
  }
  PublicKey.fromString(value)
  return value.toLowerCase()
}

/** Decode and authenticate a public, controller-signed GlobalKVStore token. */
export async function decodeAndVerifyKVStoreToken(
  lockingScript: LockingScript
): Promise<AuthenticatedKVStoreToken> {
  const { fields, lockingPublicKey } = decodeCanonicalPushDrop(lockingScript, {
    fieldCount: [5, 6],
    maximumFieldBytes: MAX_VALUE_BYTES,
    maximumPayloadBytes: MAX_VALUE_BYTES + 64 * 1024
  })
  const hasTags = fields.length === 6
  const dataFields = fields.slice(0, -1)
  const protocolIDText = toUTF8Strict(dataFields[0])
  const protocolID = validateKVStoreProtocol(JSON.parse(protocolIDText))
  if (JSON.stringify(protocolID) !== protocolIDText) {
    throw new Error('KVStore protocol ID must use canonical JSON')
  }
  const key = validateKVStoreKey(toUTF8Strict(dataFields[1]))
  const value = validateKVStoreValue(toUTF8Strict(dataFields[2]))
  if (dataFields[3].length !== 33) throw new Error('KVStore controller is invalid')
  const controller = validateKVStoreController(toHex(dataFields[3]))
  const tags = hasTags ? validateKVStoreTags(JSON.parse(toUTF8Strict(dataFields[4]))) : undefined

  const expectedLockingKey = new KeyDeriver('anyone').derivePublicKey(protocolID, key, controller)
  if (expectedLockingKey.toString() !== lockingPublicKey.toString()) {
    throw new Error('KVStore token locking key is not linked to its controller')
  }
  const { valid } = await new ProtoWallet('anyone').verifySignature({
    data: dataFields.flat(),
    signature: fields.at(-1)!,
    counterparty: controller,
    protocolID,
    keyID: key
  })
  if (valid !== true) throw new Error('KVStore token signature is invalid')
  return { protocolID, protocolIDText, key, value, controller, tags }
}
