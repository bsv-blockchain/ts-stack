import { LCH_LIMITS } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import type { LCHValue } from './types.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const MAX_UINT64 = 0xffffffffffffffffn

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function encodeHead(major: number, input: number | bigint): Uint8Array {
  const value = typeof input === 'number' ? BigInt(input) : input
  lchAssert(value >= 0n && value <= MAX_UINT64, 'ERR_LCH_CBOR', 'CBOR uint exceeds uint64')
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value))
  if (value <= 0xffn) return Uint8Array.of((major << 5) | 24, Number(value))
  if (value <= 0xffffn) {
    return Uint8Array.of((major << 5) | 25, Number(value >> 8n), Number(value & 0xffn))
  }
  if (value <= 0xffffffffn) {
    return Uint8Array.of(
      (major << 5) | 26,
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn)
    )
  }
  const output = new Uint8Array(9)
  output[0] = (major << 5) | 27
  let remaining = value
  for (let index = 8; index >= 1; index -= 1) {
    output[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return output
}

function encode(value: LCHValue, depth: number): Uint8Array {
  lchAssert(depth <= LCH_LIMITS.cborDepth, 'ERR_LCH_CBOR', 'CBOR nesting limit exceeded')
  if (value === null) return Uint8Array.of(0xf6)
  if (value === false) return Uint8Array.of(0xf4)
  if (value === true) return Uint8Array.of(0xf5)
  if (typeof value === 'number') {
    lchAssert(
      Number.isSafeInteger(value) && value >= 0,
      'ERR_LCH_CBOR',
      'CBOR numbers must be safe uints'
    )
    return encodeHead(0, value)
  }
  if (typeof value === 'bigint') return encodeHead(0, value)
  if (typeof value === 'string') {
    lchAssert(value.normalize('NFC') === value, 'ERR_LCH_CBOR', 'CBOR text must be NFC')
    const bytes = textEncoder.encode(value)
    return concat([encodeHead(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return concat([encodeHead(2, value.length), value])
  if (Array.isArray(value)) {
    lchAssert(value.length <= LCH_LIMITS.cborEntries, 'ERR_LCH_CBOR', 'CBOR array limit exceeded')
    return concat([encodeHead(4, value.length), ...value.map(item => encode(item, depth + 1))])
  }
  lchAssert(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'ERR_LCH_CBOR',
    'CBOR maps must be plain objects'
  )
  const entries = Object.entries(value)
  lchAssert(entries.length <= LCH_LIMITS.cborEntries, 'ERR_LCH_CBOR', 'CBOR map limit exceeded')
  const encoded = entries.map(([key, item]) => {
    lchAssert(item !== undefined, 'ERR_LCH_CBOR', `Undefined CBOR map value: ${key}`)
    return [encode(key, depth + 1), encode(item, depth + 1)] as const
  })
  encoded.sort((left, right) => compareBytes(left[0], right[0]))
  return concat([encodeHead(5, encoded.length), ...encoded.flat()])
}

export function encodeDeterministicCbor(value: LCHValue): Uint8Array {
  return encode(value, 0)
}

class Decoder {
  private offset = 0
  private entries = 0

  constructor(private readonly bytes: Uint8Array) {}

  decode(depth = 0): LCHValue {
    lchAssert(depth <= LCH_LIMITS.cborDepth, 'ERR_LCH_CBOR', 'CBOR nesting limit exceeded')
    lchAssert(this.offset < this.bytes.length, 'ERR_LCH_CBOR', 'Truncated CBOR')
    this.entries += 1
    lchAssert(this.entries <= LCH_LIMITS.cborEntries, 'ERR_LCH_CBOR', 'CBOR item limit exceeded')
    const head = this.bytes[this.offset]
    this.offset += 1
    const major = head >> 5
    const additional = head & 31
    if (major === 7) return this.decodeSimple(additional)
    const length = this.readLength(additional)
    if (major === 0) return length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : length
    lchAssert(
      length <= BigInt(Number.MAX_SAFE_INTEGER),
      'ERR_LCH_CBOR',
      'CBOR allocation exceeds platform limit'
    )
    const count = Number(length)
    if (major === 2) return this.read(count)
    if (major === 3) return this.decodeText(count)
    if (major === 4) return this.decodeArray(count, depth)
    if (major === 5) return this.decodeMap(count, depth)
    throw new LCHError('ERR_LCH_CBOR', `Unsupported CBOR major type ${major}`)
  }

  private decodeSimple(additional: number): LCHValue {
    if (additional === 20) return false
    if (additional === 21) return true
    if (additional === 22) return null
    throw new LCHError('ERR_LCH_CBOR', 'Unsupported CBOR simple or floating-point value')
  }

  private decodeText(count: number): string {
    let text: string
    try {
      text = textDecoder.decode(this.read(count))
    } catch (error) {
      throw new LCHError('ERR_LCH_CBOR', 'CBOR text is not valid UTF-8', { cause: error })
    }
    lchAssert(text.normalize('NFC') === text, 'ERR_LCH_CBOR', 'CBOR text must be NFC')
    return text
  }

  private decodeArray(count: number, depth: number): LCHValue[] {
    const result: LCHValue[] = []
    for (let index = 0; index < count; index += 1) result.push(this.decode(depth + 1))
    return result
  }

  private decodeMap(count: number, depth: number): Record<string, LCHValue> {
    const result: Record<string, LCHValue> = Object.create(null) as Record<string, LCHValue>
    let previousKey: Uint8Array | undefined
    for (let index = 0; index < count; index += 1) {
      const start = this.offset
      const key = this.decode(depth + 1)
      const encodedKey = this.bytes.slice(start, this.offset)
      lchAssert(typeof key === 'string', 'ERR_LCH_CBOR', 'LCH CBOR map keys must be text')
      if (previousKey !== undefined) {
        lchAssert(
          compareBytes(previousKey, encodedKey) < 0,
          'ERR_LCH_CBOR',
          'CBOR map keys are duplicated or unordered'
        )
      }
      previousKey = encodedKey
      result[key] = this.decode(depth + 1)
    }
    return result
  }

  done(): boolean {
    return this.offset === this.bytes.length
  }

  private readLength(additional: number): bigint {
    if (additional < 24) return BigInt(additional)
    if (additional === 24) {
      const value = BigInt(this.read(1)[0])
      lchAssert(value >= 24n, 'ERR_LCH_CBOR', 'Non-shortest CBOR length')
      return value
    }
    if (additional === 25) {
      const bytes = this.read(2)
      const value = BigInt((bytes[0] << 8) | bytes[1])
      lchAssert(value > 0xffn, 'ERR_LCH_CBOR', 'Non-shortest CBOR length')
      return value
    }
    if (additional === 26) {
      const bytes = this.read(4)
      let value = 0n
      for (const byte of bytes) value = (value << 8n) | BigInt(byte)
      lchAssert(value > 0xffffn, 'ERR_LCH_CBOR', 'Non-shortest CBOR length')
      return value
    }
    if (additional === 27) {
      const bytes = this.read(8)
      let value = 0n
      for (const byte of bytes) value = (value << 8n) | BigInt(byte)
      lchAssert(value > 0xffffffffn, 'ERR_LCH_CBOR', 'Non-shortest CBOR length')
      return value
    }
    throw new LCHError('ERR_LCH_CBOR', 'Indefinite-length or reserved CBOR item')
  }

  private read(length: number): Uint8Array {
    lchAssert(this.offset + length <= this.bytes.length, 'ERR_LCH_CBOR', 'Truncated CBOR')
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }
}

export function decodeDeterministicCbor(bytes: Uint8Array): LCHValue {
  const decoder = new Decoder(bytes)
  const value = decoder.decode()
  lchAssert(decoder.done(), 'ERR_LCH_CBOR', 'Trailing bytes after CBOR value')
  const encoded = encodeDeterministicCbor(value)
  lchAssert(compareBytes(encoded, bytes) === 0, 'ERR_LCH_CBOR', 'CBOR is not deterministic')
  return value
}
