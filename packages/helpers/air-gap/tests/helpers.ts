import { AIR_GAP_PREFIX } from '../src/constants'
import type { AirGapDecoder } from '../src/decoder'
import type { AirGapEncoder } from '../src/encoder'

/** Deterministic pseudo-random payload, sized to span several blocks. */
export function message(len: number): Uint8Array {
  const m = new Uint8Array(len)
  for (let i = 0; i < len; i++) m[i] = (i * 31 + 7) & 0xff
  return m
}

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

/** The four header fields of a rendered part, read straight off the wire bytes. */
export function readHeader(raw: string): {
  seq: number
  k: number
  msgLen: number
  crc: number
  payloadLength: number
} {
  const bytes = partBytes(raw)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    seq: view.getUint32(0),
    k: view.getUint16(4),
    msgLen: view.getUint32(6),
    crc: view.getUint32(10),
    payloadLength: bytes.length - 14
  }
}

/** Builds a wire part from explicit header fields, for negative tests. */
export function craftPart(
  header: { seq: number; k: number; msgLen: number; crc: number },
  payload: Uint8Array
): string {
  const bytes = new Uint8Array(14 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, header.seq)
  view.setUint16(4, header.k)
  view.setUint32(6, header.msgLen)
  view.setUint32(10, header.crc)
  bytes.set(payload, 14)
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
