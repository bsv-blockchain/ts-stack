import { Utils } from '@bsv/sdk'

export const MARKER = 0x21

export const createMinimallyEncodedScriptChunk = (
  data: number[]
): { op: number, data?: number[] } => {
  if (data.length === 0) return { op: 0 }
  if (data.length === 1 && data[0] === 0) return { op: 0 }
  if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] }
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 255) return { op: 0x4c, data }
  if (data.length <= 65535) return { op: 0x4d, data }
  return { op: 0x4e, data }
}

// Bitcoin script number: minimal little-endian, sign in the high bit of the last byte.
export const encodeScriptNum = (value: number): number[] => {
  if (value === 0) return []
  const negative = value < 0
  let abs = Math.abs(value)
  const result: number[] = []
  while (abs > 0) {
    result.push(abs & 0xff)
    abs = Math.floor(abs / 256)
  }
  if ((((result.at(-1)) ?? 0) & 0x80) !== 0) {
    result.push(negative ? 0x80 : 0x00)
  } else if (negative) {
    result[result.length - 1] |= 0x80
  }
  return result
}

export const decodeScriptNum = (data: number[]): number => {
  if (data.length === 0) return 0
  let result = 0
  for (let i = 0; i < data.length; i++) {
    result += (i === data.length - 1 ? (data[i] & 0x7f) : data[i]) * Math.pow(256, i)
  }
  if ((((data.at(-1)) ?? 0) & 0x80) !== 0) result = -result
  return result
}

// Reads a Bitcoin script number from a chunk that may be either a data push or a
// minimally-encoded small-integer opcode. createMinimallyEncodedScriptChunk
// collapses 0, -1 and 1..16 to OP_0 / OP_1NEGATE / OP_1..OP_16 (no data bytes),
// so a decoder that only reads chunk.data would mis-read those as 0. This reads
// both encodings symmetrically.
export const decodeScriptNumChunk = (chunk: { op: number, data?: number[] }): number => {
  if (chunk.op === 0) return 0 // OP_0 / OP_FALSE
  if (chunk.op === 0x4f) return -1 // OP_1NEGATE
  if (chunk.op >= 0x51 && chunk.op <= 0x60) return chunk.op - 0x50 // OP_1..OP_16
  return decodeScriptNum(chunk.data ?? [])
}

export const encodeAssetId = (assetId: string): number[] => {
  const dot = assetId.lastIndexOf('.')
  if (dot === -1) throw new Error('assetId must be "<txid>.<vout>"')
  const txid = assetId.slice(0, dot)
  const vout = Number(assetId.slice(dot + 1))
  if (txid.length !== 64) throw new Error('assetId txid must be 32 bytes (64 hex chars)')
  if (!Number.isInteger(vout) || vout < 0) throw new Error('assetId vout must be a non-negative integer')
  const txidBytes = Utils.toArray(txid, 'hex')
  const voutBytes = [vout & 0xff, (vout >> 8) & 0xff, (vout >> 16) & 0xff, (vout >> 24) & 0xff]
  return [...txidBytes, ...voutBytes]
}

export const decodeAssetId = (bytes: number[]): string => {
  if (bytes.length !== 36) throw new Error('assetId bytes must be exactly 36 bytes')
  const txid = Utils.toHex(bytes.slice(0, 32))
  const v = bytes.slice(32)
  const vout = (v[0] + (v[1] << 8) + (v[2] << 16) + (v[3] << 24)) >>> 0
  return `${txid}.${vout}`
}
