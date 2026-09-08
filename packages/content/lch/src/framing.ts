import { decodeDeterministicCbor, encodeDeterministicCbor } from './cbor.js'
import { LCH_LIMITS, LCH_MAGIC } from './constants.js'
import { lchAssert } from './errors.js'
import { concatBytes, readUint64be, uint64be } from './hash.js'
import type { LCHValue } from './types.js'

export interface ParsedLCH {
  header: Record<string, LCHValue>
  headerBytes: Uint8Array
  ciphertext?: Uint8Array
}

export function frameLCH(header: Record<string, LCHValue>, ciphertext?: Uint8Array): Uint8Array {
  const headerBytes = encodeDeterministicCbor(header)
  lchAssert(
    headerBytes.length <= LCH_LIMITS.headerBytes,
    'ERR_LCH_FRAMING',
    'LCH header limit exceeded'
  )
  return concatBytes(
    LCH_MAGIC,
    uint64be(headerBytes.length),
    headerBytes,
    ciphertext ?? new Uint8Array()
  )
}

export function parseLCH(bytes: Uint8Array): ParsedLCH {
  lchAssert(bytes.length >= 12, 'ERR_LCH_FRAMING', 'Truncated LCH prefix')
  for (let index = 0; index < LCH_MAGIC.length; index += 1) {
    lchAssert(bytes[index] === LCH_MAGIC[index], 'ERR_LCH_FRAMING', 'Invalid LCH magic or version')
  }
  const length = readUint64be(bytes.slice(4, 12))
  lchAssert(
    length <= BigInt(LCH_LIMITS.headerBytes),
    'ERR_LCH_FRAMING',
    'LCH header limit exceeded'
  )
  lchAssert(length <= BigInt(bytes.length - 12), 'ERR_LCH_FRAMING', 'Truncated LCH header')
  const end = 12 + Number(length)
  const headerBytes = bytes.slice(12, end)
  const decoded = decodeDeterministicCbor(headerBytes)
  lchAssert(
    decoded !== null &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      !(decoded instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    'LCH header must be a map'
  )
  return {
    header: decoded,
    headerBytes,
    ...(end < bytes.length ? { ciphertext: bytes.slice(end) } : {})
  }
}
