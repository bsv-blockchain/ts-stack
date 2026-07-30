import { DEFAULT_BLOCK_BYTES, MAX_MESSAGE_BYTES } from '../src/constants'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { drain, lcg, message, SESSION_A, shuffled } from './helpers'

/** Feeds parts until the message decodes or `limit` parts have been sent. */
function transmit(
  msg: Uint8Array,
  blockBytes: number,
  keep: (seq: number) => boolean,
  limit: number
): Uint8Array | null {
  const enc = new AirGapEncoder(msg, { blockBytes, sessionId: SESSION_A })
  const dec = new AirGapDecoder()
  for (let seq = 0; seq < limit; seq++) {
    if (!keep(seq)) continue
    if (dec.accept(enc.partAt(seq)).done) return dec.message()
  }
  return null
}

describe('round trip', () => {
  it('carries every message length across a block boundary', () => {
    const blockBytes = 16
    for (const len of [1, 15, 16, 17, 31, 32, 33, 47, 48, 49, 64]) {
      const msg = message(len)
      const out = transmit(msg, blockBytes, () => true, 200)
      expect(out).not.toBeNull()
      expect(Array.from(out!)).toEqual(Array.from(msg))
    }
  })

  it('carries a message at every small block size', () => {
    const msg = message(101)
    for (const blockBytes of [1, 2, 3, 7, 8, 100, 101, 102, 1200]) {
      const out = transmit(msg, blockBytes, () => true, 4000)
      expect(out).not.toBeNull()
      expect(Array.from(out!)).toEqual(Array.from(msg))
    }
  })

  it('carries the largest allowed message at the default block size', () => {
    const msg = message(MAX_MESSAGE_BYTES)
    const out = transmit(msg, DEFAULT_BLOCK_BYTES, () => true, 500)
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('survives heavy, deterministically random frame loss', () => {
    const random = lcg(0x5eed)
    for (const [len, blockBytes] of [
      [700, 100],
      [2400, 1200],
      [6000, 1200],
      [20000, 900]
    ]) {
      const msg = message(len)
      // Drop three frames in five, the far side of what a shaky camera does.
      const out = transmit(msg, blockBytes, () => random() > 0.6, 20000)
      expect(out).not.toBeNull()
      expect(Array.from(out!)).toEqual(Array.from(msg))
    }
  })

  it('survives arbitrary frame ordering', () => {
    const random = lcg(0xc0ffee)
    const msg = message(9000) // K = 8 at 1200
    const enc = new AirGapEncoder(msg, { blockBytes: 1200, sessionId: SESSION_A })
    for (let trial = 0; trial < 20; trial++) {
      const dec = new AirGapDecoder()
      // Two cycles' worth of parts, shuffled: a receiver that starts mid-cycle.
      const out = drain(dec, enc, shuffled(2 * enc.blockCount, random))
      expect(out).not.toBeNull()
      expect(Array.from(out!)).toEqual(Array.from(msg))
    }
  })

  it('needs only a small overhead over K parts on average', () => {
    // The whole point of the fountain: a receiver that catches parts at random
    // finishes in barely more than K reads *on average*. Individual runs can
    // stall on linearly dependent parts — recovery is probabilistic, which is
    // why receivers keep scanning and senders keep looping.
    const random = lcg(0xa11ce)
    const msg = message(24000) // K = 20 at 1200
    const enc = new AirGapEncoder(msg, { blockBytes: 1200, sessionId: SESSION_A })
    let sent = 0
    const trials = 40
    for (let trial = 0; trial < trials; trial++) {
      const dec = new AirGapDecoder()
      // Start each receiver at a different point in an endless sender loop.
      const offset = Math.floor(random() * 500)
      let count = 0
      for (let i = 0; i < 4000; i++) {
        count++
        if (dec.accept(enc.partAt(offset + i)).done) break
      }
      expect(dec.message()).not.toBeNull()
      sent += count
    }
    expect(sent / trials).toBeLessThan(enc.blockCount * 2)
  })

  it('stalls on linearly dependent parts, then recovers from later ones', () => {
    // Six distinct fountain parts that all resolve to source block 0 for
    // K = 3: after all six, progress is still 1/3 — "any K + ε distinct parts"
    // is provably NOT an absolute guarantee. The stream itself then completes
    // recovery, because the sender keeps emitting and later parts carry the
    // missing blocks. Pinned as a regression so no doc or port reintroduces
    // the absolute claim.
    const msg = message(30) // K = 3 at 10
    const enc = new AirGapEncoder(msg, { blockBytes: 10, sessionId: SESSION_A })
    const dec = new AirGapDecoder()
    const dependent = [4, 27, 38, 56, 63, 72]
    let progress = dec.accept(enc.partAt(dependent[0]))
    for (const seq of dependent.slice(1)) progress = dec.accept(enc.partAt(seq))
    expect(progress).toEqual({ ok: true, done: false, have: 1, total: 3 })
    // The sender keeps looping; the receiver keeps scanning; recovery lands.
    const out = drain(dec, enc, [73, 74, 75, 76, 77, 78, 79, 80])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('recovers after a corrupt part while the sender keeps looping', () => {
    const msg = message(3700)
    const enc = new AirGapEncoder(msg, { blockBytes: 1200, sessionId: SESSION_A })
    const dec = new AirGapDecoder()
    for (let seq = 0; seq < 60; seq++) {
      // Every third read comes back mangled, as a marginal scan does.
      const text = seq % 3 === 0 ? `${enc.partAt(seq).slice(0, -4)}!!!!` : enc.partAt(seq)
      if (dec.accept(text).done) break
    }
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('never blends two senders in view of the same camera', () => {
    const msgA = message(2400) // K = 2
    const msgB = message(3700) // K = 4
    const encA = new AirGapEncoder(msgA, { blockBytes: 1200, sessionId: SESSION_A })
    const encB = new AirGapEncoder(msgB, {
      blockBytes: 1200,
      sessionId: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2])
    })
    const dec = new AirGapDecoder()
    // Strictly alternating parts never build a SESSION_SWITCH_PARTS run of
    // the foreign sender, so the decoder stays locked to whichever it saw
    // first — and completes it despite the interference.
    let done = false
    for (let seq = 0; seq < 40 && !done; seq++) {
      done = dec.accept(encA.partAt(seq % 2)).done
      if (!done) expect(dec.accept(encB.partAt(seq)).ok).toBe(false)
    }
    expect(done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msgA))
  })
})
