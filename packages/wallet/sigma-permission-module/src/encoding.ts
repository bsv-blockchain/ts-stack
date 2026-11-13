import type BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import Point from '@bsv/sdk/primitives/Point'
import type { ParsedPlaintext, SigmaOperation } from './types.js'

export type { ParsedPlaintext, SigmaOperation } from './types.js'

const curve = new Curve()
const MAX_CTX = 4096
const MIN_RING = 2
const MAX_RING = 8

const bytesToHex = (bytes: number[]): string =>
  bytes.map(b => b.toString(16).padStart(2, '0')).join('')

/** True for an array whose every index holds an integer from 0 to 255. */
export function isBytes(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  for (let i = 0; i < value.length; i++) {
    const b: unknown = value[i]
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return false
  }
  return true
}

/** Parses a 33-byte canonical compressed point: on the curve, not the identity. */
export function parsePoint33(bytes: number[], label: string): Point {
  if (!isBytes(bytes)) throw new TypeError(`${label} must be an array of integers from 0 to 255`)
  if (bytes.length !== 33) throw new Error(`${label} must be 33 bytes`)
  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) throw new Error(`${label} must be a compressed point`)
  const x = bigIntOf(bytes.slice(1))
  if (x >= BigInt('0x' + curve.p.toString(16)))
    throw new Error(`${label} x is not below the field prime`)
  let point: Point
  try {
    point = Point.fromX(bytesToHex(bytes.slice(1)), bytes[0] === 0x03)
  } catch {
    throw new Error(`${label} is not on the curve`)
  }
  if (point.isInfinity() || !point.validate()) throw new Error(`${label} is not on the curve`)
  return point
}

function bigIntOf(bytes: number[]): bigint {
  return BigInt('0x' + bytesToHex(bytes))
}

/** x then y, 32 bytes each, big-endian. */
export function point64(p: Point): number[] {
  return [...p.getX().toArray('be', 32), ...p.getY().toArray('be', 32)]
}

export function scalar32(k: BigNumber): number[] {
  return k.toArray('be', 32)
}

function parseCtx(ctx: number[]): number[] {
  if (ctx.length < 1 || ctx.length > MAX_CTX) throw new Error(`ctx must be 1 to ${MAX_CTX} bytes`)
  return ctx
}

const notG = (p: Point, label: string): Point => {
  if (p.eq(curve.g)) throw new Error(`${label} must not be the generator`)
  return p
}

export function parsePlaintext(operation: SigmaOperation, plaintext: number[]): ParsedPlaintext {
  switch (operation) {
    case 'key':
      if (plaintext.length === 0) return { operation }
      return { operation, H: notG(parsePoint33(plaintext, 'H'), 'H') }
    case 'schnorr':
      return { operation, ctx: parseCtx(plaintext) }
    case 'dleq': {
      const H = notG(parsePoint33(plaintext.slice(0, 33), 'H'), 'H')
      return { operation, H, ctx: parseCtx(plaintext.slice(33)) }
    }
    case 'or': {
      const n = plaintext[0]
      const index = plaintext[1]
      if (n === undefined || index === undefined || n < MIN_RING || n > MAX_RING) {
        throw new Error(`ring size must be ${MIN_RING} to ${MAX_RING}`)
      }
      if (index < 1 || index > n) throw new Error('ring position must be 1 to n')
      const others: Point[] = []
      for (let j = 0; j < n - 1; j++) {
        others.push(
          parsePoint33(plaintext.slice(2 + 33 * j, 2 + 33 * (j + 1)), `ring point ${j + 1}`)
        )
      }
      const keys = new Set(others.map(p => bytesToHex(point64(p))))
      if (keys.size !== others.length) throw new Error('ring points must be distinct')
      return { operation, n, index, others, ctx: parseCtx(plaintext.slice(2 + 33 * (n - 1))) }
    }
  }
}
