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

import { AIR_GAP_PREFIX, MAX_MESSAGE_BYTES } from '../src/constants'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { estimatePartCharLength } from '../src/helpers'
import { partBytes, toPart } from './helpers'

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

describe('air-gap wire properties', () => {
  it('round-trips arbitrary bytes through one systematic cycle', () => {
    fc.assert(
      fc.property(payload, blockBytes, (bytes, block) => {
        const enc = new AirGapEncoder(bytes, block)
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
          const enc = new AirGapEncoder(bytes, block)
          const dec = new AirGapDecoder()
          // A mask that drops every frame is a camera pointed at the floor.
          if (!mask.includes(true)) return
          // Otherwise a repeating keep/drop mask stands in for a camera that
          // misses frames; the sender keeps looping, so seq climbs regardless
          // and the receiver only ever sees the parts the mask lets through.
          const budget = 30 * enc.blockCount + 200
          for (let seq = 0, seen = 0; seen < budget; seq++) {
            if (!mask[seq % mask.length]) continue
            seen++
            if (dec.accept(enc.partAt(seq)).done) break
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
          fc.uint8Array({ maxLength: 64 }).map(bytes => toPart(bytes))
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
          const enc = new AirGapEncoder(bytes, block)
          const dec = new AirGapDecoder()
          // Corrupt one payload byte of the last systematic part, leaving its
          // header — and therefore the session key and the crc — untouched.
          const raw = partBytes(enc.partAt(enc.blockCount - 1))
          const index = 14 + (position % (raw.length - 14))
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
      fc.property(payload, blockBytes, fc.nat(), (bytes, block, seq) => {
        const enc = new AirGapEncoder(bytes, block)
        const part = enc.partAt(seq)
        expect(part.startsWith(AIR_GAP_PREFIX)).toBe(true)
        expect(part.length).toBe(estimatePartCharLength(block))
      })
    )
  })

  it('reports a block count and message length that agree with its input', () => {
    fc.assert(
      fc.property(payload, blockBytes, (bytes, block) => {
        const enc = new AirGapEncoder(bytes, block)
        expect(enc.messageLength).toBe(bytes.length)
        expect(enc.blockCount).toBe(Math.ceil(bytes.length / block))
        expect(enc.blockCount * enc.blockBytes).toBeGreaterThanOrEqual(bytes.length)
        expect(enc.messageLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES)
      })
    )
  })
})
