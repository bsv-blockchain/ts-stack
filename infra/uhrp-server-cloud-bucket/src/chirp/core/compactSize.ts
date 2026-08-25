import { CHIRPError } from './errors.js'

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn

export function encodeCompactSize(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT64) {
    throw new CHIRPError('ERR_CHIRP_INTEGER_RANGE', 'CompactSize value is outside uint64.')
  }
  if (value <= 252n) return Uint8Array.of(Number(value))
  if (value <= 0xffffn) return concat(Uint8Array.of(0xfd), littleEndian(value, 2))
  if (value <= 0xffff_ffffn) return concat(Uint8Array.of(0xfe), littleEndian(value, 4))
  return concat(Uint8Array.of(0xff), littleEndian(value, 8))
}

export function decodeCompactSize(
  bytes: Uint8Array,
  offset = 0
): { value: bigint; offset: number } {
  if (offset >= bytes.byteLength) truncated()
  const prefix = bytes[offset]
  if (prefix < 0xfd) return { value: BigInt(prefix), offset: offset + 1 }
  const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8
  if (offset + 1 + width > bytes.byteLength) truncated()
  let value = 0n
  for (let index = 0; index < width; index += 1) {
    value |= BigInt(bytes[offset + 1 + index]) << BigInt(index * 8)
  }
  if (
    (width === 2 && value < 0xfdn) ||
    (width === 4 && value <= 0xffffn) ||
    (width === 8 && value <= 0xffff_ffffn)
  ) {
    throw new CHIRPError(
      'ERR_CHIRP_COMPACT_SIZE_NON_MINIMAL',
      'CompactSize must use its shortest encoding.'
    )
  }
  return { value, offset: offset + 1 + width }
}

export function bigEndian(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) {
    throw new CHIRPError('ERR_CHIRP_INTEGER_RANGE', 'Integer does not fit its field.')
  }
  const result = new Uint8Array(width)
  let remaining = value
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

export function readBigEndian(bytes: Uint8Array, offset: number, width: number): bigint {
  if (offset + width > bytes.byteLength) truncated()
  let result = 0n
  for (let index = 0; index < width; index += 1) {
    result = (result << 8n) | BigInt(bytes[offset + index])
  }
  return result
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function littleEndian(value: bigint, width: number): Uint8Array {
  const result = new Uint8Array(width)
  let remaining = value
  for (let index = 0; index < width; index += 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

function truncated(): never {
  throw new CHIRPError('ERR_CHIRP_TRUNCATED', 'CHIRP serialization is truncated.')
}
