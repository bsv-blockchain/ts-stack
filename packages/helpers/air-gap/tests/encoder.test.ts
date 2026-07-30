import {
  AIR_GAP_PREFIX,
  DEFAULT_BLOCK_BYTES,
  MAX_BLOCK_COUNT,
  MAX_MESSAGE_BYTES
} from '../src/constants'
import { crc32 } from '../src/crc32'
import { AirGapEncoder } from '../src/encoder'
import { AirGapError } from '../src/errors'
import { estimatePartCharLength } from '../src/helpers'
import { message, partBytes, readHeader } from './helpers'

describe('AirGapEncoder', () => {
  it('emits parts of constant size with the right prefix', () => {
    const enc = new AirGapEncoder(message(5000), 1200)
    const first = enc.partAt(0)
    const fountain = enc.partAt(enc.blockCount + 1)
    expect(first.startsWith(AIR_GAP_PREFIX)).toBe(true)
    expect(fountain.startsWith(AIR_GAP_PREFIX)).toBe(true)
    expect(first.length).toBe(fountain.length)
  })

  it('refuses an empty message', () => {
    expect(() => new AirGapEncoder(new Uint8Array(0))).toThrow(AirGapError)
    expect(() => new AirGapEncoder(new Uint8Array(0))).toThrow(/empty message/)
  })

  it('refuses an oversize message and says by how much', () => {
    expect(() => new AirGapEncoder(message(MAX_MESSAGE_BYTES + 1))).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(MAX_MESSAGE_BYTES + 1))).toThrow(
      `message of ${MAX_MESSAGE_BYTES + 1} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte maximum`
    )
  })

  it('accepts exactly the maximum message size', () => {
    const enc = new AirGapEncoder(message(MAX_MESSAGE_BYTES))
    expect(enc.messageLength).toBe(MAX_MESSAGE_BYTES)
    expect(enc.blockCount).toBe(Math.ceil(MAX_MESSAGE_BYTES / DEFAULT_BLOCK_BYTES))
  })

  it('refuses a block size that is not a positive integer', () => {
    expect(() => new AirGapEncoder(message(10), 0)).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(10), -1)).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(10), 1.5)).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(10), Number.NaN)).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(10), 1.5)).toThrow(
      'blockBytes must be a positive integer, received 1.5'
    )
  })

  it('refuses a block size needing more blocks than the u16 K field can carry', () => {
    // 65,536 bytes at one byte per block would need 65,536 blocks; K tops out
    // at 65,535, which one byte fewer hits exactly.
    expect(new AirGapEncoder(message(MAX_BLOCK_COUNT), 1).blockCount).toBe(MAX_BLOCK_COUNT)
    expect(() => new AirGapEncoder(message(MAX_MESSAGE_BYTES), 1)).toThrow(AirGapError)
    expect(() => new AirGapEncoder(message(MAX_MESSAGE_BYTES), 1)).toThrow(
      `blockBytes of 1 needs ${MAX_MESSAGE_BYTES} blocks, over the ${MAX_BLOCK_COUNT} the header can carry`
    )
    expect(new AirGapEncoder(message(MAX_MESSAGE_BYTES), 2).blockCount).toBe(32768)
  })

  it('computes blockCount as ceil(len / blockBytes)', () => {
    expect(new AirGapEncoder(message(2400), 1200).blockCount).toBe(2)
    expect(new AirGapEncoder(message(2401), 1200).blockCount).toBe(3)
    expect(new AirGapEncoder(message(37), 1200).blockCount).toBe(1)
    expect(new AirGapEncoder(message(1), 1200).blockCount).toBe(1)
  })

  it('exposes its configuration read-only', () => {
    const enc = new AirGapEncoder(message(2401), 1200)
    expect(enc.blockBytes).toBe(1200)
    expect(enc.messageLength).toBe(2401)
    expect(enc.blockCount).toBe(3)
  })

  it('defaults blockBytes to DEFAULT_BLOCK_BYTES', () => {
    expect(new AirGapEncoder(message(10)).blockBytes).toBe(DEFAULT_BLOCK_BYTES)
  })

  it('writes the documented header for a systematic part', () => {
    const msg = message(2401)
    const enc = new AirGapEncoder(msg, 1200)
    const header = readHeader(enc.partAt(2))
    expect(header).toEqual({
      seq: 2,
      k: 3,
      msgLen: 2401,
      crc: crc32(msg),
      payloadLength: 1200
    })
  })

  it('repeats the same message-wide header fields on fountain parts', () => {
    const msg = message(2401)
    const enc = new AirGapEncoder(msg, 1200)
    const header = readHeader(enc.partAt(9))
    expect(header.seq).toBe(9)
    expect(header.k).toBe(3)
    expect(header.msgLen).toBe(2401)
    expect(header.crc).toBe(crc32(msg))
  })

  it('is deterministic across instances', () => {
    const a = new AirGapEncoder(message(3700), 1200)
    const b = new AirGapEncoder(message(3700), 1200)
    for (const seq of [0, 1, 3, 4, 17, 4096]) expect(a.partAt(seq)).toBe(b.partAt(seq))
  })

  it('is deterministic across repeated calls for the same seq', () => {
    const enc = new AirGapEncoder(message(3700), 1200)
    expect(enc.partAt(11)).toBe(enc.partAt(11))
  })

  it('zero-pads the final block rather than shortening the part', () => {
    const enc = new AirGapEncoder(message(1), 8)
    const header = readHeader(enc.partAt(0))
    expect(header.payloadLength).toBe(8)
    expect(header.msgLen).toBe(1)
  })

  it('copies the message so later caller mutation cannot change the parts', () => {
    const msg = message(64)
    const enc = new AirGapEncoder(msg, 32)
    const before = enc.partAt(0)
    msg[0] ^= 0xff
    expect(enc.partAt(0)).toBe(before)
  })

  it('refuses a sequence number outside u32', () => {
    const enc = new AirGapEncoder(message(10), 8)
    expect(() => enc.partAt(-1)).toThrow(AirGapError)
    expect(() => enc.partAt(1.5)).toThrow(AirGapError)
    expect(() => enc.partAt(2 ** 32)).toThrow(AirGapError)
    expect(() => enc.partAt(Number.NaN)).toThrow(AirGapError)
    expect(() => enc.partAt(-1)).toThrow(
      'part sequence must be a 32-bit unsigned integer, received -1'
    )
  })

  it('encodes the largest sequence number the header can carry', () => {
    const enc = new AirGapEncoder(message(10), 8)
    expect(readHeader(enc.partAt(2 ** 32 - 1)).seq).toBe(2 ** 32 - 1)
  })

  it('produces parts of exactly the estimated character length', () => {
    for (const blockBytes of [1, 2, 3, 8, 100, 1200, 1500]) {
      const enc = new AirGapEncoder(message(3000), blockBytes)
      expect(enc.partAt(0).length).toBe(estimatePartCharLength(blockBytes))
    }
  })

  it('mixes several source blocks into parts past the systematic prefix', () => {
    // Some fountain payload must be a genuine XOR of two or more source blocks,
    // otherwise the fountain has degenerated into plain chunk cycling.
    const enc = new AirGapEncoder(message(4000), 1000)
    const payload = (seq: number) => partBytes(enc.partAt(seq)).subarray(14).join(',')
    const sources = new Set([0, 1, 2, 3].map(payload))
    const mixes = Array.from({ length: 32 }, (_, i) => payload(4 + i))
    expect(mixes.some(mix => !sources.has(mix))).toBe(true)
    // ...and some fountain payload must be a degree-1 repeat of a source block,
    // which is what makes late joiners cheap.
    expect(mixes.some(mix => sources.has(mix))).toBe(true)
  })
})
