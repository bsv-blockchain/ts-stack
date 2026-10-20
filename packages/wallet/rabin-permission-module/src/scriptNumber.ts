import { bytesToNumbers } from './bytes.js'

/** On-chain Rúnar padding bound: `0 <= padding < 65536`. */
export const RABIN_PADDING_LIMIT = 65536n

/** Minimal non-negative Bitcoin script-number encoding. Zero is the empty encoding. */
export function encodeScriptNumber(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('Rabin: script numbers are non-negative')
  if (value === 0n) return new Uint8Array()
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0n) {
    bytes.push(Number(remaining & 0xffn))
    remaining >>= 8n
  }
  const last = bytes[bytes.length - 1] as number
  if ((last & 0x80) !== 0) bytes.push(0)
  return Uint8Array.from(bytes)
}

/** Decodes a minimal non-negative script number and rejects a sign bit or extra zero byte. */
export function decodeScriptNumber(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  const last = bytes[bytes.length - 1] as number
  if ((last & 0x80) !== 0) throw new Error('Rabin: negative script number')
  if (bytes.length > 1 && last === 0 && ((bytes[bytes.length - 2] as number) & 0x80) === 0) {
    throw new Error('Rabin: non-minimal script number')
  }
  let value = 0n
  for (let i = 0; i < bytes.length; i++) value |= BigInt(bytes[i] as number) << BigInt(8 * i)
  return value
}

/** One minimal Bitcoin push of `data`, using OP_0, OP_1–OP_16, OP_1NEGATE, or a data push. */
export function encodePush(data: Uint8Array): Uint8Array {
  if (data.length === 1) {
    const byte = data[0] as number
    if (byte >= 1 && byte <= 16) return Uint8Array.of(0x50 + byte)
    if (byte === 0x81) return Uint8Array.of(0x4f)
  }
  if (data.length < 76) {
    const out = new Uint8Array(1 + data.length)
    out[0] = data.length
    out.set(data, 1)
    return out
  }
  if (data.length <= 0xff) {
    const out = new Uint8Array(2 + data.length)
    out[0] = 0x4c
    out[1] = data.length
    out.set(data, 2)
    return out
  }
  if (data.length <= 0xffff) {
    const out = new Uint8Array(3 + data.length)
    out[0] = 0x4d
    out[1] = data.length & 0xff
    out[2] = (data.length >> 8) & 0xff
    out.set(data, 3)
    return out
  }
  throw new Error('Rabin: script push exceeds PUSHDATA2')
}

export function decodePushes(bytes: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.length) {
    const opcode = bytes[offset++] as number
    if (opcode === 0x4f) {
      pushes.push(Uint8Array.of(0x81))
      continue
    }
    if (opcode >= 0x51 && opcode <= 0x60) {
      pushes.push(Uint8Array.of(opcode - 0x50))
      continue
    }
    let length: number
    if (opcode < 76) {
      length = opcode
    } else if (opcode === 0x4c) {
      if (offset >= bytes.length) throw new Error('Rabin: truncated PUSHDATA1')
      length = bytes[offset++] as number
    } else if (opcode === 0x4d) {
      if (offset + 1 >= bytes.length) throw new Error('Rabin: truncated PUSHDATA2')
      length = (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8)
      offset += 2
    } else {
      throw new Error('Rabin: ciphertext contains a non-push opcode')
    }
    if (offset + length > bytes.length) throw new Error('Rabin: truncated script push')
    pushes.push(bytes.slice(offset, offset + length))
    offset += length
  }
  return pushes
}

export function pushScriptNumber(value: bigint): Uint8Array {
  return encodePush(encodeScriptNumber(value))
}

export function pushesToNumbers(bytes: Uint8Array): number[] {
  return bytesToNumbers(bytes)
}
