const HEX = /^[0-9a-f]*$/

/** Overwrites a buffer this module owns. Immutable copies may still exist until collection. */
export function wipe(bytes: Uint8Array | null | undefined): void {
  bytes?.fill(0)
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase()
  if (normalized.length % 2 !== 0 || !HEX.test(normalized)) {
    throw new Error('Rabin: expected even-length lowercase hex')
  }
  const out = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function beToBigint(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

export function bigintToBe(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new RangeError('Rabin: expected a non-negative integer')
  const out = new Uint8Array(length)
  let remaining = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) throw new RangeError('Rabin: integer does not fit in the encoded length')
  return out
}

export function leToBigint(bytes: Uint8Array): bigint {
  let value = 0n
  for (let i = 0; i < bytes.length; i++) value |= BigInt(bytes[i] as number) << BigInt(i * 8)
  return value
}

export function bitLength(value: bigint): number {
  if (value <= 0n) return 0
  return value.toString(2).length
}

export function bytesToNumbers(bytes: Uint8Array): number[] {
  return [...bytes]
}
