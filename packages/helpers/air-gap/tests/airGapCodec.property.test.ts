/**
 * Property tests for the wire boundary.
 *
 * The decoder's input is whatever a barcode library thought it saw through a
 * camera, which makes it the one surface in this package that is genuinely
 * adversarial: arbitrary strings, arbitrary bit flips, arbitrary frame loss.
 * These properties pin the two guarantees that matter there — total functions
 * that never throw, and bytes that are either exactly what was sent or nothing
 * at all — over inputs no hand-written fixture would think to try.
 */
import fc from 'fast-check'

import { AIR_GAP_PREFIX, MAX_BLOCK_BYTES, MAX_MESSAGE_BYTES } from '../src/constants'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { estimatePartCharLength } from '../src/helpers'
import { partBytes, SESSION_A, toPart } from './helpers'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

/**
 * Payloads big enough to span several blocks, small enough to stay quick.
 *
 * The explicit size bias matters: fast-check's default keeps arrays around a
 * dozen bytes, which would leave every multi-block path untested.
 */
const payloadUpTo = (maxLength: number) =>
  fc.uint8Array({ minLength: 1, maxLength, size: 'medium' })
const payload = payloadUpTo(2048)
/** Block sizes from "absurdly small" up to the default. */
const blockBytes = fc.integer({ min: 1, max: 1200 })
/** An arbitrary but explicit 8-byte session identity. */
const sessionId = fc.uint8Array({ minLength: 8, maxLength: 8 })

describe('air-gap wire properties', () => {
  it('round-trips arbitrary bytes through one systematic cycle', () => {
    fc.assert(
      fc.property(payload, blockBytes, sessionId, (bytes, block, session) => {
        const enc = new AirGapEncoder(bytes, { blockBytes: block, sessionId: session })
        const dec = new AirGapDecoder()
        for (let seq = 0; seq < enc.blockCount; seq++) {
          const progress = dec.accept(enc.partAt(seq))
          expect(progress.ok).toBe(true)
          expect(progress.total).toBe(enc.blockCount)
          expect(progress.have).toBe(seq + 1)
        }
        expect(Array.from(dec.message()!)).toEqual(Array.from(bytes))
      })
    )
  })

  it('recovers arbitrary bytes through arbitrary frame loss', () => {
    fc.assert(
      fc.property(
        payloadUpTo(1024),
        fc.integer({ min: 32, max: 600 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 64 }),
        (bytes, block, mask) => {
          const enc = new AirGapEncoder(bytes, { blockBytes: block, sessionId: SESSION_A })
          const dec = new AirGapDecoder()
          // A mask that drops every frame is a camera pointed at the floor.
          if (!mask.includes(true)) return
          // Otherwise a repeating keep/drop mask stands in for a camera that
          // misses frames. The sender loops through its systematic cycle
          // (seq wraps over 4K), so recovery is guaranteed eventually even if
          // the fountain parts that get through are linearly dependent.
          const cycle = 4 * enc.blockCount
          const budget = 30 * enc.blockCount + 200
          for (let tick = 0, seen = 0; seen < budget; tick++) {
            if (!mask[tick % mask.length]) continue
            seen++
            if (dec.accept(enc.partAt(tick % cycle)).done) break
          }
          expect(Array.from(dec.message()!)).toEqual(Array.from(bytes))
        }
      ),
      // Loss sweeps are the slowest property here; the mask space is small.
      { numRuns: Math.min(MIN_PROPERTY_RUNS, 120) }
    )
  })

  it('never throws and never emits a message for arbitrary text', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.string({ unit: 'binary' }),
          fc.string().map(s => AIR_GAP_PREFIX + s),
          fc.uint8Array({ maxLength: 64 }).map(bytes => toPart(bytes)),
          // Far past any valid part length: must be rejected by the length
          // gate before any base64 work happens.
          fc
            .integer({ min: estimatePartCharLength(MAX_BLOCK_BYTES) + 1, max: 20000 })
            .map(n => AIR_GAP_PREFIX + 'A'.repeat(n))
        ),
        text => {
          const dec = new AirGapDecoder()
          const progress = dec.accept(text)
          // Nothing short of a real part can complete a message, and nothing at
          // all can make the decoder throw inside a camera callback.
          if (!progress.done) expect(dec.message()).toBeNull()
          expect(progress.have).toBeLessThanOrEqual(progress.total)
        }
      )
    )
  })

  it('emits the original bytes or nothing when a part is corrupted', () => {
    fc.assert(
      fc.property(
        payloadUpTo(512),
        fc.integer({ min: 8, max: 128 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, block, position, delta) => {
          const enc = new AirGapEncoder(bytes, { blockBytes: block, sessionId: SESSION_A })
          const dec = new AirGapDecoder()
          // Corrupt one payload byte of the last systematic part, leaving its
          // header — and therefore the session identity and the crc — untouched.
          const raw = partBytes(enc.partAt(enc.blockCount - 1))
          const index = 23 + (position % (raw.length - 23))
          raw[index] = (raw[index] + delta) & 0xff
          for (let seq = 0; seq < enc.blockCount - 1; seq++) dec.accept(enc.partAt(seq))
          dec.accept(toPart(raw))
          const out = dec.message()
          // Either the flip landed in the zero padding past msgLen and the
          // payload is untouched, or the crc catches it and nothing is emitted.
          if (out !== null) expect(Array.from(out)).toEqual(Array.from(bytes))
        }
      )
    )
  })

  it('renders every part at exactly the predicted length', () => {
    fc.assert(
      fc.property(payload, blockBytes, sessionId, fc.nat(), (bytes, block, session, seq) => {
        const enc = new AirGapEncoder(bytes, { blockBytes: block, sessionId: session })
        const part = enc.partAt(seq)
        expect(part.startsWith(AIR_GAP_PREFIX)).toBe(true)
        expect(part).toHaveLength(estimatePartCharLength(block))
      })
    )
  })

  it('reports a block count and message length that agree with its input', () => {
    fc.assert(
      fc.property(payload, blockBytes, (bytes, block) => {
        const enc = new AirGapEncoder(bytes, { blockBytes: block, sessionId: SESSION_A })
        expect(enc.messageLength).toBe(bytes.length)
        expect(enc.blockCount).toBe(Math.ceil(bytes.length / block))
        expect(enc.blockCount * enc.blockBytes).toBeGreaterThanOrEqual(bytes.length)
        expect(enc.messageLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
      })
    )
  })

  it('never lets a single foreign frame erase progress', () => {
    fc.assert(
      fc.property(
        payloadUpTo(256),
        payloadUpTo(256),
        fc.integer({ min: 8, max: 64 }),
        (bytesA, bytesB, block) => {
          const encA = new AirGapEncoder(bytesA, { blockBytes: block, sessionId: SESSION_A })
          const encB = new AirGapEncoder(bytesB, {
            blockBytes: block,
            sessionId: Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248])
          })
          const dec = new AirGapDecoder()
          const first = dec.accept(encA.partAt(0))
          // One stray frame from a different session must not reset anything.
          const stray = dec.accept(encB.partAt(0))
          expect(stray.have).toBe(first.have)
          expect(stray.total).toBe(first.total)
          if (encA.blockCount === 1) return
          expect(stray.ok).toBe(false)
          // The locked session keeps decoding to exactly its own bytes.
          for (let seq = 1; seq < encA.blockCount; seq++) dec.accept(encA.partAt(seq))
          expect(Array.from(dec.message()!)).toEqual(Array.from(bytesA))
        }
      )
    )
  })
})
