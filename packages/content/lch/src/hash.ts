import { LCH_OBJECT_TYPES } from './constants.js'
import { encodeDeterministicCbor } from './cbor.js'
import { lchAssert } from './errors.js'
import type { LCHObjectType, LCHValue } from './types.js'

const textEncoder = new TextEncoder()

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(value: string): Uint8Array {
  lchAssert(/^(?:[\da-f]{2})+$/u.test(value), 'ERR_LCH_CBOR', 'Invalid lowercase hexadecimal')
  return Uint8Array.from(value.match(/../gu) ?? [], pair => Number.parseInt(pair, 16))
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  let encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_')
  while (encoded.endsWith('=')) encoded = encoded.slice(0, -1)
  return encoded
}

export function fromBase64Url(value: string): Uint8Array {
  lchAssert(/^[\w-]*$/u.test(value), 'ERR_LCH_CBOR', 'Invalid unpadded base64url')
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
  return Uint8Array.from(binary, character => character.codePointAt(0) ?? 0)
}

export function objectPreimage(type: LCHObjectType, body: LCHValue): Uint8Array {
  lchAssert(LCH_OBJECT_TYPES.includes(type), 'ERR_LCH_CBOR', `Unsupported LCH object type: ${type}`)
  return concatBytes(textEncoder.encode(`LCH/${type}/1\0`), encodeDeterministicCbor(body))
}

export async function objectId(type: LCHObjectType, body: LCHValue): Promise<Uint8Array> {
  return sha256(objectPreimage(type, body))
}

export async function objectIri(type: LCHObjectType, body: LCHValue): Promise<string> {
  return `lch:${type}:sha256:${toHex(await objectId(type, body))}`
}

export function uint64be(value: number | bigint): Uint8Array {
  let remaining = typeof value === 'number' ? BigInt(value) : value
  lchAssert(
    remaining >= 0n && remaining <= 0xffffffffffffffffn,
    'ERR_LCH_CBOR',
    'uint64 out of range'
  )
  const result = new Uint8Array(8)
  for (let index = 7; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

export function readUint64be(bytes: Uint8Array): bigint {
  lchAssert(bytes.length === 8, 'ERR_LCH_FRAMING', 'Expected eight-byte uint64')
  let result = 0n
  for (const byte of bytes) result = (result << 8n) | BigInt(byte)
  return result
}
