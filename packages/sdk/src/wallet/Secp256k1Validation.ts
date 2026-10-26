const fieldPrime = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const groupOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  while (exponent > 0n) {
    if ((exponent & 1n) !== 0n) result = (result * base) % fieldPrime
    base = (base * base) % fieldPrime
    exponent >>= 1n
  }
  return result
}

/** Validate one canonical compressed SEC1 secp256k1 public key. */
export function isValidCompressedPublicKey(value: string): boolean {
  if (!/^0[23][0-9a-f]{64}$/iu.test(value)) return false
  const x = BigInt(`0x${value.slice(2)}`)
  if (x >= fieldPrime) return false
  const square = (x * x * x + 7n) % fieldPrime
  const y = modPow(square, (fieldPrime + 1n) >> 2n)
  return (y * y) % fieldPrime === square
}

function bytesToBigInt(bytes: ArrayLike<number>, offset: number, length: number): bigint {
  let result = 0n
  for (let index = offset; index < offset + length; index++) {
    result = (result << 8n) | BigInt(bytes[index])
  }
  return result
}

/** Validate a strict, minimally encoded DER ECDSA signature with in-range scalars. */
export function isCanonicalDERSignature(bytes: ArrayLike<number>): boolean {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) {
    return false
  }
  let offset = 2
  for (let integer = 0; integer < 2; integer++) {
    if (bytes[offset++] !== 0x02) return false
    const length = bytes[offset++]
    if (length < 1 || length > 33 || offset + length > bytes.length) return false
    const first = bytes[offset]
    if ((first & 0x80) !== 0 || (length > 1 && first === 0 && (bytes[offset + 1] & 0x80) === 0)) {
      return false
    }
    const scalar = bytesToBigInt(bytes, offset, length)
    if (scalar === 0n || scalar >= groupOrder) return false
    offset += length
  }
  return offset === bytes.length
}
