import { DEFAULTS } from '../../src/types.js'
import { utf8Encode } from '../../src/util/bytes.js'

/** Build a raw frame by hand so tests do not depend on the encoder under test. */
export function rawFrame(
  seq: number,
  final: boolean,
  payload: Uint8Array | string,
  header: { version?: number; flags?: number } = {}
): Uint8Array {
  const body = typeof payload === 'string' ? utf8Encode(payload) : payload
  const out = new Uint8Array(6 + body.length)
  out[0] = header.version ?? 1
  out[1] = header.flags ?? (final ? 1 : 0)
  new DataView(out.buffer).setUint32(2, seq, false)
  out.set(body, 6)
  return out
}

/**
 * Split message text into raw frames by hand. Unlike `encodeMessage` it takes the JSON text
 * as is, so it can carry text that `JSON.stringify` would never produce (a deeply nested
 * bomb, malformed JSON). Always yields at least one frame; only the last is final.
 */
export function rawFramesOf(
  text: string,
  seq = 0,
  chunkBytes: number = DEFAULTS.chunkBytes
): Uint8Array[] {
  const body = utf8Encode(text)
  const per = chunkBytes - 6
  const frames: Uint8Array[] = []
  let start = 0
  do {
    const end = Math.min(start + per, body.length)
    frames.push(rawFrame(seq, end === body.length, body.subarray(start, end)))
    start = end
  } while (start < body.length)
  return frames
}

/** Deepest nesting of objects and arrays in a parsed JSON value: `{"a":1}` is 1. */
export function nestingDepth(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  let deepest = 0
  for (const child of Object.values(value)) deepest = Math.max(deepest, nestingDepth(child))
  return 1 + deepest
}

/**
 * Structural tokens `JSON.stringify(value)` contains: one `{` or `[` per container, one `:`
 * per object member and one `,` between neighbouring members or elements. Counted from the
 * parsed value, so a text with duplicate keys has more tokens than this reports.
 */
export function structuralTokens(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const children = Object.values(value)
  const own = 1 + Math.max(0, children.length - 1) + (Array.isArray(value) ? 0 : children.length)
  return children.reduce<number>((sum, child) => sum + structuralTokens(child), own)
}
