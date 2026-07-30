/**
 * Frozen conformance vectors.
 *
 * These strings ARE the wire format. A change to the header layout, the base64
 * variant, the RNG, the degree distribution or the shuffle will break them, and
 * that is the point: any implementation in any language must produce these exact
 * strings for the same `(message, blockBytes, seq)`. Never regenerate a vector
 * to make a test pass — a mismatch means the change is a protocol change.
 */
import { blocksForPart } from '../src/coding'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { crc32 } from '../src/crc32'
import { drain, message, readHeader } from './helpers'

describe('vector V0 — CRC-32 check value', () => {
  it('crc32("123456789") is the IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('the frozen part-to-blocks mapping', () => {
  it('pins the block sets the wire format depends on', () => {
    // These are the sets a decoder rebuilds from `seq` alone. They are the
    // coding half of the vectors above; changing them changes the protocol.
    expect(blocksForPart(3, 3)).toEqual([1, 2])
    expect(blocksForPart(4, 3)).toEqual([0])
    expect(blocksForPart(5, 5)).toEqual([2, 1, 3])
  })

  it('always draws degree 1 when there is one source block', () => {
    for (const seq of [1, 2, 7, 4096, 2 ** 31]) expect(blocksForPart(seq, 1)).toEqual([0])
  })

  it('falls back to a fixed seed rather than a zero RNG state', () => {
    // seq 0 is the only input whose xorshift seed would be 0, and a zeroed
    // xorshift32 never leaves 0 — every draw would collapse to the same value.
    // Unreachable from the encoder (seq 0 is systematic), pinned here so the
    // fallback cannot be dropped from a port.
    expect(blocksForPart(0, 4)).toEqual([2, 0])
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
})

describe('vector V1 — K = 1, "Hello" at blockBytes 8', () => {
  const hello = new TextEncoder().encode('Hello') // 48 65 6c 6c 6f
  const PART_0 = 'air-gap:AAAAAAABAAAABffRiYJIZWxsbwAAAA'
  const PART_1 = 'air-gap:AAAAAQABAAAABffRiYJIZWxsbwAAAA'
  const CRC = 0xf7d18982

  it('has the pinned crc and block count', () => {
    const enc = new AirGapEncoder(hello, 8)
    expect(crc32(hello)).toBe(CRC)
    expect(enc.blockCount).toBe(1)
  })

  it('renders the frozen part strings', () => {
    const enc = new AirGapEncoder(hello, 8)
    expect(enc.partAt(0)).toBe(PART_0)
    // With one source block every part carries that block; only seq differs.
    expect(enc.partAt(1)).toBe(PART_1)
  })

  it('carries the documented header fields', () => {
    expect(readHeader(PART_0)).toEqual({
      seq: 0,
      k: 1,
      msgLen: 5,
      crc: CRC,
      payloadLength: 8
    })
  })

  it('decodes to exactly the five message bytes from that part alone', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept(PART_0).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f])
  })

  it('decodes from a later part just as well', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept(PART_1).done).toBe(true)
    expect(new TextDecoder().decode(dec.message()!)).toBe('Hello')
  })
})

describe('vector V2 — K = 3, message(10) at blockBytes 4', () => {
  // m[i] = (i * 31 + 7) & 0xff → 7,38,69,100,131,162,193,224,255,30
  const BYTES = [7, 38, 69, 100, 131, 162, 193, 224, 255, 30]
  const CRC = 0x72c21f0b
  const SYSTEMATIC = [
    'air-gap:AAAAAAADAAAACnLCHwsHJkVk',
    'air-gap:AAAAAQADAAAACnLCHwuDosHg',
    'air-gap:AAAAAgADAAAACnLCHwv_HgAA'
  ]
  /** A degree-2 mix. */
  const PART_3 = 'air-gap:AAAAAwADAAAACnLCHwt8vMHg'
  /** A degree-1 draw: the same payload as source block 0, under a later seq. */
  const PART_4 = 'air-gap:AAAABAADAAAACnLCHwsHJkVk'

  it('has the pinned message bytes, crc and block count', () => {
    const msg = message(10)
    expect(Array.from(msg)).toEqual(BYTES)
    expect(crc32(msg)).toBe(CRC)
    expect(new AirGapEncoder(msg, 4).blockCount).toBe(3)
  })

  it('renders the frozen systematic and fountain part strings', () => {
    const enc = new AirGapEncoder(message(10), 4)
    expect([enc.partAt(0), enc.partAt(1), enc.partAt(2)]).toEqual(SYSTEMATIC)
    expect(enc.partAt(3)).toBe(PART_3)
    expect(enc.partAt(4)).toBe(PART_4)
  })

  it('zero-pads the last block and still reports msgLen 10', () => {
    expect(readHeader(SYSTEMATIC[2])).toEqual({
      seq: 2,
      k: 3,
      msgLen: 10,
      crc: CRC,
      payloadLength: 4
    })
  })

  it('decodes from the three systematic parts alone', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept(SYSTEMATIC[0]).done).toBe(false)
    expect(dec.accept(SYSTEMATIC[1]).done).toBe(false)
    expect(dec.accept(SYSTEMATIC[2]).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(BYTES)
  })

  it('substitutes a fountain part for a missed systematic one', () => {
    const dec = new AirGapDecoder()
    dec.accept(SYSTEMATIC[0])
    dec.accept(SYSTEMATIC[2])
    // Block 1 was never sent directly; PART_3 mixes it and peels out.
    expect(dec.accept(PART_3).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(BYTES)
  })

  it('treats a degree-1 fountain part as pure redundancy once its block is known', () => {
    const dec = new AirGapDecoder()
    dec.accept(SYSTEMATIC[0])
    const s = dec.accept(PART_4)
    expect(s).toEqual({ ok: true, done: false, have: 1, total: 3 })
  })

  it('recovers from the frozen strings in any order', () => {
    const enc = new AirGapEncoder(message(10), 4)
    const dec = new AirGapDecoder()
    expect(drain(dec, enc, [4, 3, 2, 1, 0])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(BYTES)
  })
})
