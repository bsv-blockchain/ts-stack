export const createMinimallyEncodedScriptChunk = (
  data: number[]
): { op: number; data?: number[] } => {
  if (data.length === 0) return { op: 0 }
  if (data.length === 1 && data[0] === 0) return { op: 0 }
  if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] }
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 255) return { op: 0x4c, data }
  if (data.length <= 65535) return { op: 0x4d, data }
  return { op: 0x4e, data }
}

export const decodeScriptNum = (data: number[]): number => {
  if (data.length === 0) return 0
  let result = 0
  for (let i = 0; i < data.length; i++) {
    result += (i === data.length - 1 ? data[i] & 0x7f : data[i]) * Math.pow(256, i)
  }
  if (((data.at(-1) ?? 0) & 0x80) !== 0) result = -result
  return result
}

// Reads a Bitcoin script number from a chunk that may be either a data push or a
// minimally-encoded small-integer opcode. createMinimallyEncodedScriptChunk
// collapses 0, -1 and 1..16 to OP_0 / OP_1NEGATE / OP_1..OP_16 (no data bytes),
// so a decoder that only reads chunk.data would mis-read those as 0. This reads
// both encodings symmetrically.
export const decodeScriptNumChunk = (chunk: { op: number; data?: number[] }): number => {
  if (chunk.op === 0) return 0 // OP_0 / OP_FALSE
  if (chunk.op === 0x4f) return -1 // OP_1NEGATE
  if (chunk.op >= 0x51 && chunk.op <= 0x60) return chunk.op - 0x50 // OP_1..OP_16
  return decodeScriptNum(chunk.data ?? [])
}
