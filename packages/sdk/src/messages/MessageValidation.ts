import BigNumber from '../primitives/BigNumber.js'
import Point from '../primitives/Point.js'
import PrivateKey from '../primitives/PrivateKey.js'
import PublicKey from '../primitives/PublicKey.js'
import { toHex } from '../primitives/utils.js'

export const MAX_MESSAGE_PAYLOAD_BYTES = 16 * 1024 * 1024
export const MAX_ENCRYPTED_MESSAGE_BYTES = MAX_MESSAGE_PAYLOAD_BYTES + 150
export const MIN_ENCRYPTED_MESSAGE_BYTES = 150
export const MIN_SIGNED_MESSAGE_BYTES = 78
export const MAX_SIGNED_MESSAGE_BYTES = 174

export function copyMessageBytes(
  value: number[],
  name: string,
  maximum: number = MAX_MESSAGE_PAYLOAD_BYTES,
  minimum: number = 0
): number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new RangeError(`${name} length is outside the permitted range.`)
  }
  const copy = Array.from({ length: value.length }, () => 0)
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      throw new TypeError(`${name} must be a dense byte array.`)
    }
    const byte = value[i]
    if (!Number.isSafeInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`${name} must contain only byte values.`)
    }
    copy[i] = byte
  }
  return copy
}

export function copyPrivateKey(value: PrivateKey, name: string): PrivateKey {
  if (!(value instanceof PrivateKey)) throw new TypeError(`${name} must be a PrivateKey.`)
  const bytes = BigNumber.prototype.toArray.call(value, 'be', 32)
  const copy = new PrivateKey(toHex(bytes), 'hex', 'be', 'error')
  if (copy.isZero()) throw new TypeError(`${name} must be a non-zero private key.`)
  return copy
}

export function copyPublicKey(value: PublicKey, name: string): PublicKey {
  if (!(value instanceof PublicKey)) throw new TypeError(`${name} must be a PublicKey.`)
  if (Point.prototype.validate.call(value) !== true) {
    throw new TypeError(`${name} must be a valid secp256k1 public key.`)
  }
  const encoded = Point.prototype.encode.call(value, true) as number[]
  return PublicKey.fromDER(copyMessageBytes(encoded, name, 33, 33))
}
