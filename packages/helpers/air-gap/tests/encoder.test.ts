import {
  AIR_GAP_PREFIX,
  AIR_GAP_WIRE_VERSION,
  DEFAULT_BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  MAX_BLOCK_COUNT,
  MAX_MESSAGE_BYTES,
  SESSION_ID_BYTES
} from '../src/constants'
import { crc32 } from '../src/crc32'
import { AirGapEncoder } from '../src/encoder'
import { AirGapError } from '../src/errors'
import { estimatePartCharLength } from '../src/helpers'
import { message, partBytes, readHeader, SESSION_A, toHex } from './helpers'

const enc = (len: number, blockBytes?: number) =>
  new AirGapEncoder(message(len), { blockBytes, sessionId: SESSION_A })

describe('AirGapEncoder', () => {
  it('emits parts of constant size with the right prefix', () => {
    const e = enc(5000, 1200)
    const first = e.partAt(0)
    const fountain = e.partAt(e.blockCount + 1)
    expect(first.startsWith(AIR_GAP_PREFIX)).toBe(true)
    expect(fountain.startsWith(AIR_GAP_PREFIX)).toBe(true)
    expect(first).toHaveLength(fountain.length)
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
    const e = new AirGapEncoder(message(MAX_MESSAGE_BYTES))
    expect(e.messageLength).toBe(MAX_MESSAGE_BYTES)
    expect(e.blockCount).toBe(Math.ceil(MAX_MESSAGE_BYTES / DEFAULT_BLOCK_BYTES))
  })

  it('refuses a block size that is not an integer in range', () => {
    expect(() => enc(10, 0)).toThrow(AirGapError)
    expect(() => enc(10, -1)).toThrow(AirGapError)
    expect(() => enc(10, 1.5)).toThrow(AirGapError)
    expect(() => enc(10, Number.NaN)).toThrow(AirGapError)
    expect(() => enc(10, 1.5)).toThrow(
      `blockBytes must be an integer between 1 and ${MAX_BLOCK_BYTES}, received 1.5`
    )
  })

  it('enforces the wire ceiling on the block size', () => {
    // MAX_BLOCK_BYTES is the largest block a single optical symbol can carry;
    // the decoder rejects anything bigger, so the encoder must too.
    expect(enc(10, MAX_BLOCK_BYTES).blockBytes).toBe(MAX_BLOCK_BYTES)
    expect(() => enc(10, MAX_BLOCK_BYTES + 1)).toThrow(AirGapError)
    expect(() => enc(10, MAX_BLOCK_BYTES + 1)).toThrow(
      `blockBytes must be an integer between 1 and ${MAX_BLOCK_BYTES}, received ${MAX_BLOCK_BYTES + 1}`
    )
  })

  it('refuses a block size needing more blocks than the u16 K field can carry', () => {
    // 65,536 bytes at one byte per block would need 65,536 blocks; K tops out
    // at 65,535, which one byte fewer hits exactly.
    expect(enc(MAX_BLOCK_COUNT, 1).blockCount).toBe(MAX_BLOCK_COUNT)
    expect(() => enc(MAX_MESSAGE_BYTES, 1)).toThrow(AirGapError)
    expect(() => enc(MAX_MESSAGE_BYTES, 1)).toThrow(
      `blockBytes of 1 needs ${MAX_MESSAGE_BYTES} blocks, over the ${MAX_BLOCK_COUNT} the header can carry`
    )
    expect(enc(MAX_MESSAGE_BYTES, 2).blockCount).toBe(32768)
  })

  it('refuses a session id that is not exactly SESSION_ID_BYTES long', () => {
    for (const length of [0, 7, 9, 16]) {
      expect(() => new AirGapEncoder(message(10), { sessionId: new Uint8Array(length) })).toThrow(
        `sessionId must be exactly ${SESSION_ID_BYTES} bytes, received ${length}`
      )
    }
  })

  it('generates a random session id when none is given', () => {
    const a = new AirGapEncoder(message(10))
    const b = new AirGapEncoder(message(10))
    expect(a.sessionId).toHaveLength(SESSION_ID_BYTES)
    // Two encoders of the same message are distinct sessions on the wire —
    // an 8-byte random collision is a once-per-2^64 event.
    expect(toHex(a.sessionId)).not.toBe(toHex(b.sessionId))
    expect(a.partAt(0)).not.toBe(b.partAt(0))
  })

  it('copies the session id in and out, so callers cannot mutate the stream', () => {
    const provided = Uint8Array.from(SESSION_A)
    const e = new AirGapEncoder(message(10), { sessionId: provided })
    const before = e.partAt(0)
    provided[0] ^= 0xff
    expect(e.partAt(0)).toBe(before)
    const exposed = e.sessionId
    exposed[0] ^= 0xff
    expect(toHex(e.sessionId)).toBe(toHex(SESSION_A))
  })

  it('computes blockCount as ceil(len / blockBytes)', () => {
    expect(enc(2400, 1200).blockCount).toBe(2)
    expect(enc(2401, 1200).blockCount).toBe(3)
    expect(enc(37, 1200).blockCount).toBe(1)
    expect(enc(1, 1200).blockCount).toBe(1)
  })

  it('exposes its configuration read-only', () => {
    const e = enc(2401, 1200)
    expect(e.blockBytes).toBe(1200)
    expect(e.messageLength).toBe(2401)
    expect(e.blockCount).toBe(3)
  })

  it('defaults blockBytes to DEFAULT_BLOCK_BYTES', () => {
    expect(new AirGapEncoder(message(10)).blockBytes).toBe(DEFAULT_BLOCK_BYTES)
  })

  it('writes the documented header for a systematic part', () => {
    const msg = message(2401)
    const e = enc(2401, 1200)
    expect(readHeader(e.partAt(2))).toEqual({
      version: AIR_GAP_WIRE_VERSION,
      sessionHex: toHex(SESSION_A),
      seq: 2,
      k: 3,
      msgLen: 2401,
      crc: crc32(msg),
      payloadLength: 1200
    })
  })

  it('repeats the same message-wide header fields on fountain parts', () => {
    const msg = message(2401)
    const e = enc(2401, 1200)
    const header = readHeader(e.partAt(9))
    expect(header.version).toBe(AIR_GAP_WIRE_VERSION)
    expect(header.sessionHex).toBe(toHex(SESSION_A))
    expect(header.seq).toBe(9)
    expect(header.k).toBe(3)
    expect(header.msgLen).toBe(2401)
    expect(header.crc).toBe(crc32(msg))
  })

  it('is deterministic across instances sharing a session id', () => {
    const a = enc(3700, 1200)
    const b = enc(3700, 1200)
    for (const seq of [0, 1, 3, 4, 17, 4096]) expect(a.partAt(seq)).toBe(b.partAt(seq))
  })

  it('is deterministic across repeated calls for the same seq', () => {
    const e = enc(3700, 1200)
    expect(e.partAt(11)).toBe(e.partAt(11))
  })

  it('zero-pads the final block rather than shortening the part', () => {
    const e = enc(1, 8)
    const header = readHeader(e.partAt(0))
    expect(header.payloadLength).toBe(8)
    expect(header.msgLen).toBe(1)
  })

  it('copies the message so later caller mutation cannot change the parts', () => {
    const msg = message(64)
    const e = new AirGapEncoder(msg, { blockBytes: 32, sessionId: SESSION_A })
    const before = e.partAt(0)
    msg[0] ^= 0xff
    expect(e.partAt(0)).toBe(before)
  })

  it('refuses a sequence number outside u32', () => {
    const e = enc(10, 8)
    expect(() => e.partAt(-1)).toThrow(AirGapError)
    expect(() => e.partAt(1.5)).toThrow(AirGapError)
    expect(() => e.partAt(2 ** 32)).toThrow(AirGapError)
    expect(() => e.partAt(Number.NaN)).toThrow(AirGapError)
    expect(() => e.partAt(-1)).toThrow(
      'part sequence must be a 32-bit unsigned integer, received -1'
    )
  })

  it('encodes the largest sequence number the header can carry', () => {
    const e = enc(10, 8)
    expect(readHeader(e.partAt(2 ** 32 - 1)).seq).toBe(2 ** 32 - 1)
  })

  it('produces parts of exactly the estimated character length', () => {
    for (const blockBytes of [1, 2, 3, 8, 100, 1200, 1500, MAX_BLOCK_BYTES]) {
      const e = enc(3000, blockBytes)
      expect(e.partAt(0)).toHaveLength(estimatePartCharLength(blockBytes))
    }
  })

  it('mixes several source blocks into parts past the systematic prefix', () => {
    // Some fountain payload must be a genuine XOR of two or more source blocks,
    // otherwise the fountain has degenerated into plain chunk cycling.
    const e = enc(4000, 1000)
    const payload = (seq: number) => partBytes(e.partAt(seq)).subarray(23).join(',')
    const sources = new Set([0, 1, 2, 3].map(payload))
    const mixes = Array.from({ length: 32 }, (_, i) => payload(4 + i))
    expect(mixes.some(mix => !sources.has(mix))).toBe(true)
    // ...and some fountain payload must be a degree-1 repeat of a source block,
    // which is what makes late joiners cheap.
    expect(mixes.some(mix => sources.has(mix))).toBe(true)
  })
})
