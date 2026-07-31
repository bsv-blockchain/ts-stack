/**
 * Conformance vectors — the wire format's contract, executed from the shared
 * corpus.
 *
 * The fixtures under `conformance/vectors/transport/air-gap-optical.json` ARE
 * the wire format: any implementation in any language must reproduce them
 * exactly, and the cross-language conformance runner executes the same file.
 * Never regenerate a vector to make a test pass — a mismatch means the change
 * is a protocol change, which requires a new wire version and a spec update
 * (BRC-141 / `specs/transport/air-gap-optical.md`).
 *
 * The mapping pins at the bottom freeze the internal part-to-blocks function
 * directly, including the u32-seed boundary cases a floating-point port gets
 * wrong.
 */
import { blocksForPart } from '../src/coding'
import { crc32 } from '../src/crc32'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { estimatePartCharLength } from '../src/helpers'
import { fromHex, loadConformanceVectors, toHex, type ConformanceVector } from './helpers'

const vectors = loadConformanceVectors()
const byOperation = (operation: string): ConformanceVector[] =>
  vectors.filter(v => v.input.operation === operation)

describe('shared conformance corpus', () => {
  it('is present and non-trivial', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(25)
  })

  describe('crc32 vectors', () => {
    it.each(byOperation('crc32').map(v => [v.id, v] as const))('%s', (_id, v) => {
      const bytes = fromHex(v.input.message_hex as string)
      expect(crc32(bytes).toString(16).padStart(8, '0')).toBe(v.expected.crc32_hex)
    })
  })

  describe('part-char-length vectors', () => {
    it.each(byOperation('part-char-length').map(v => [v.id, v] as const))('%s', (_id, v) => {
      expect(estimatePartCharLength(v.input.block_bytes as number)).toBe(v.expected.chars)
    })
  })

  describe('encode-part vectors', () => {
    it.each(byOperation('encode-part').map(v => [v.id, v] as const))('%s', (_id, v) => {
      const encoder = new AirGapEncoder(fromHex(v.input.message_hex as string), {
        blockBytes: v.input.block_bytes as number,
        sessionId: fromHex(v.input.session_id_hex as string)
      })
      expect(encoder.partAt(v.input.seq as number)).toBe(v.expected.part)
    })
  })

  describe('decode vectors', () => {
    it.each(byOperation('decode').map(v => [v.id, v] as const))('%s', (_id, v) => {
      const decoder = new AirGapDecoder()
      let done = false
      for (const part of v.input.parts as string[]) done = decoder.accept(part).done || done
      expect(done).toBe(true)
      const out = decoder.message()
      expect(out).not.toBeNull()
      expect(toHex(out!)).toBe(v.expected.message_hex)
    })
  })

  describe('progress vectors', () => {
    it.each(byOperation('progress').map(v => [v.id, v] as const))('%s', (_id, v) => {
      const decoder = new AirGapDecoder()
      let last = decoder.accept('')
      for (const part of v.input.parts as string[]) last = decoder.accept(part)
      expect(last.have).toBe(v.expected.have)
      expect(last.total).toBe(v.expected.total)
      expect(last.done).toBe(v.expected.done)
    })
  })

  describe('accept-one rejection vectors', () => {
    it.each(byOperation('accept-one').map(v => [v.id, v] as const))('%s', (_id, v) => {
      const decoder = new AirGapDecoder()
      expect(decoder.accept(v.input.text as string).ok).toBe(v.expected.ok)
      expect(decoder.message()).toBeNull()
    })
  })

  it('covers every operation the corpus defines', () => {
    const operations = new Set(vectors.map(v => v.input.operation))
    expect([...operations].sort()).toEqual([
      'accept-one',
      'crc32',
      'decode',
      'encode-part',
      'part-char-length',
      'progress'
    ])
  })
})

describe('the frozen part-to-blocks mapping', () => {
  it('pins the block sets the wire format depends on', () => {
    // These are the sets a decoder rebuilds from `seq` alone. They are the
    // coding half of the corpus; changing them changes the protocol.
    expect(blocksForPart(3, 3)).toEqual([2, 1])
    expect(blocksForPart(4, 3)).toEqual([0])
    expect(blocksForPart(5, 5)).toEqual([1, 3])
  })

  it('pins the u32 modular seed across the float-precision boundary', () => {
    // 3,393,265 is the first seq where naive JavaScript multiplication
    // (seq * 0x9e3779b1) has already lost low bits that Math.imul keeps. A
    // port using native u32 arithmetic agrees with these sets; a port using
    // doubles does not.
    expect(blocksForPart(3393264, 5)).toEqual([2, 4])
    expect(blocksForPart(3393265, 5)).toEqual([2, 0])
    expect(blocksForPart(0x7fffffff, 5)).toEqual([3, 0])
    expect(blocksForPart(0xffffffff, 5)).toEqual([1, 0, 3, 2])
  })

  it('always draws degree 1 when there is one source block', () => {
    for (const seq of [1, 2, 7, 4096, 2 ** 31]) expect(blocksForPart(seq, 1)).toEqual([0])
  })

  it('falls back to a fixed seed rather than a zero RNG state', () => {
    // seq 0 is the only input whose xorshift seed would be 0, and a zeroed
    // xorshift32 never leaves 0 — every draw would collapse to the same value.
    // Unreachable from the wire (seq 0 is systematic on both sides), pinned
    // here so the fallback cannot be dropped from a port that exposes the
    // mapping directly.
    expect(blocksForPart(0, 4)).toEqual([2, 0, 1, 3])
  })

  it('always returns distinct in-range indices, at most one per block', () => {
    for (const k of [1, 2, 3, 5, 8, 55]) {
      for (let seq = k; seq < k + 60; seq++) {
        const indices = blocksForPart(seq, k)
        expect(indices.length).toBeGreaterThanOrEqual(1)
        expect(indices.length).toBeLessThanOrEqual(k)
        expect(new Set(indices).size).toBe(indices.length)
        for (const index of indices) {
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(k)
        }
      }
    }
  })

  it('samples the ideal soliton distribution, not an approximation of it', () => {
    // Frequencies over a fixed window of the deterministic mapping. The old
    // two-draw sampler put ~20% of K=5 draws on degree 5 instead of 5%; this
    // pins the corrected inverse-CDF sampler within a tolerance no accidental
    // distribution passes.
    const k = 5
    const samples = 20000
    const counts = new Map<number, number>()
    for (let seq = k; seq < k + samples; seq++) {
      const d = blocksForPart(seq, k).length
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    const frequency = (d: number): number => (counts.get(d) ?? 0) / samples
    expect(frequency(1)).toBeGreaterThan(0.18)
    expect(frequency(1)).toBeLessThan(0.22)
    expect(frequency(2)).toBeGreaterThan(0.47)
    expect(frequency(2)).toBeLessThan(0.53)
    expect(frequency(5)).toBeGreaterThan(0.035)
    expect(frequency(5)).toBeLessThan(0.065)
  })
})
