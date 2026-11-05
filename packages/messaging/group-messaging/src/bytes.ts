/** Byte/hex helpers. `@bsv/sdk` speaks `number[]`; MLS speaks `Uint8Array`. */

export const toHex = (bytes: Uint8Array | number[]): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

/** `parseInt` decodes a prefix, so every pair is validated before it is parsed. */
const HEX_PAIR = /^[0-9a-fA-F]{2}$/

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error(`Odd-length hex string: ${hex.length}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2)
    if (!HEX_PAIR.test(pair)) throw new Error(`Invalid hex at offset ${i * 2}`)
    out[i] = Number.parseInt(pair, 16)
  }
  return out
}

export const toNumbers = (bytes: Uint8Array): number[] => Array.from(bytes)

export const fromNumbers = (bytes: number[]): Uint8Array => Uint8Array.from(bytes)

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Constant-time-ish equality. Not a substitute for a real CT primitive. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** 128 bits of randomness as hex. For local handles and wire correlators. */
export const randomId = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}
