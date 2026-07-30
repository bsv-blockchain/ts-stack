import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AIR_GAP_PREFIX, AIR_GAP_WIRE_VERSION, HEADER_BYTES } from '../src/constants'
import type { AirGapDecoder } from '../src/decoder'
import type { AirGapEncoder } from '../src/encoder'

/** Deterministic pseudo-random payload, sized to span several blocks. */
export function message(len: number): Uint8Array {
  const m = new Uint8Array(len)
  for (let i = 0; i < len; i++) m[i] = (i * 31 + 7) & 0xff
  return m
}

/** A fixed session identity so vector-adjacent tests stay deterministic. */
export const SESSION_A = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
/** A second fixed session identity, for two-sender tests. */
export const SESSION_B = Uint8Array.from([0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18])

/** Feeds `seqs` into `decoder` and returns the message the moment it completes. */
export function drain(
  decoder: AirGapDecoder,
  encoder: AirGapEncoder,
  seqs: Iterable<number>
): Uint8Array | null {
  for (const seq of seqs) {
    const s = decoder.accept(encoder.partAt(seq))
    if (s.done) return decoder.message()
  }
  return null
}

/** Decodes a rendered part back to raw header ‖ payload bytes, for hand-corrupting it. */
export function partBytes(raw: string): Uint8Array {
  const b64 = raw.slice(AIR_GAP_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/')
  const binary = globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(binary, c => c.codePointAt(0)!)
}

/** Re-renders raw header ‖ payload bytes as a wire part string. */
export function toPart(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCodePoint(byte)
  const base64 = globalThis.btoa(bin)
  return (
    AIR_GAP_PREFIX +
    base64
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/={0,2}$/, '')
  )
}

/** The header fields of a rendered part, read straight off the wire bytes. */
export function readHeader(raw: string): {
  version: number
  sessionHex: string
  seq: number
  k: number
  msgLen: number
  crc: number
  payloadLength: number
} {
  const bytes = partBytes(raw)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sessionHex = ''
  for (let i = 1; i <= 8; i++) sessionHex += bytes[i].toString(16).padStart(2, '0')
  return {
    version: view.getUint8(0),
    sessionHex,
    seq: view.getUint32(9),
    k: view.getUint16(13),
    msgLen: view.getUint32(15),
    crc: view.getUint32(19),
    payloadLength: bytes.length - HEADER_BYTES
  }
}

/** Builds a wire part from explicit header fields, for negative tests. */
export function craftPart(
  header: {
    version?: number
    session?: Uint8Array
    seq: number
    k: number
    msgLen: number
    crc: number
  },
  payload: Uint8Array
): string {
  const bytes = new Uint8Array(HEADER_BYTES + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, header.version ?? AIR_GAP_WIRE_VERSION)
  bytes.set(header.session ?? SESSION_A, 1)
  view.setUint32(9, header.seq)
  view.setUint16(13, header.k)
  view.setUint32(15, header.msgLen)
  view.setUint32(19, header.crc)
  bytes.set(payload, HEADER_BYTES)
  return toPart(bytes)
}

/** A tiny deterministic LCG, so randomized sweeps stay reproducible. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** `[0, count)` shuffled deterministically by `random`. */
export function shuffled(count: number, random: () => number): number[] {
  const items = Array.from({ length: count }, (_, i) => i)
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const t = items[i]
    items[i] = items[j]
    items[j] = t
  }
  return items
}

/** One entry of the shared conformance fixture file. */
export interface ConformanceVector {
  id: string
  description: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
  tags?: string[]
}

/**
 * The implementation-neutral fixtures this package shares with every port.
 *
 * The file under the repository-root `conformance/` corpus is the contract;
 * these tests and the cross-language conformance runner execute the same
 * vectors, so the wire format cannot drift between the two. The corpus is
 * located by walking up from this file, because sandboxed runs (mutation
 * testing copies the package elsewhere in the repository) change how many
 * levels up the repository root sits.
 */
export function loadConformanceVectors(): ConformanceVector[] {
  const relative = join('conformance', 'vectors', 'transport', 'air-gap-optical.json')
  let directory = __dirname
  for (;;) {
    const candidate = join(directory, relative)
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        vectors: ConformanceVector[]
      }
      return parsed.vectors
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`conformance corpus not found above ${__dirname}`)
    directory = parent
  }
}

/** Lowercase-hex → bytes, for conformance vector payloads. */
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Bytes → lowercase hex, for conformance vector payloads. */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
