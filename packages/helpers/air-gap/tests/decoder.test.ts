import { blocksForPart } from '../src/coding'
import {
  AIR_GAP_PREFIX,
  MAX_BLOCK_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_INDICES,
  MAX_PENDING_PARTS,
  MAX_TRACKED_SEQS,
  SESSION_SWITCH_PARTS
} from '../src/constants'
import { crc32 } from '../src/crc32'
import { AirGapDecoder } from '../src/decoder'
import { AirGapEncoder } from '../src/encoder'
import { estimatePartCharLength } from '../src/helpers'
import { craftPart, drain, message, partBytes, SESSION_A, SESSION_B, toPart } from './helpers'

const enc = (len: number, blockBytes: number, sessionId: Uint8Array = SESSION_A) =>
  new AirGapEncoder(message(len), { blockBytes, sessionId })

describe('AirGapDecoder', () => {
  it('decodes from one clean systematic cycle', () => {
    const msg = message(5000) // K = 5 at 1200
    const dec = new AirGapDecoder()
    const out = drain(dec, enc(5000, 1200), [0, 1, 2, 3, 4])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('reports progress and ignores a duplicate seq', () => {
    const e = enc(5000, 1200)
    const dec = new AirGapDecoder()
    expect(dec.accept(e.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 })
    expect(dec.accept(e.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 })
    expect(dec.accept(e.partAt(1))).toEqual({ ok: true, done: false, have: 2, total: 5 })
  })

  it('reports total 0 before it has seen anything', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: false, have: 0, total: 0 })
    expect(dec.message()).toBeNull()
  })

  it('recovers a message when systematic parts are missed', () => {
    const msg = message(6000) // K = 5
    const dec = new AirGapDecoder()
    // Skip parts 1 and 3 entirely; feed the rest of the first two cycles.
    const out = drain(
      dec,
      enc(6000, 1200),
      [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    )
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('recovers a message from fountain parts alone', () => {
    // Every systematic part missed: recovery has to come from peeling mixes.
    const msg = message(6000) // K = 5
    const e = enc(6000, 1200)
    const dec = new AirGapDecoder()
    const out = drain(
      dec,
      e,
      Array.from({ length: 200 }, (_, i) => e.blockCount + i)
    )
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('handles out-of-order and interleaved duplicates', () => {
    const msg = message(3700) // K = 4, last block padded
    const dec = new AirGapDecoder()
    const out = drain(dec, enc(3700, 1200), [3, 3, 1, 6, 0, 1, 5, 2])
    expect(out).not.toBeNull()
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('decodes a message that is an exact multiple of the block size', () => {
    const msg = message(2400)
    const dec = new AirGapDecoder()
    const out = drain(dec, enc(2400, 1200), [0, 1])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('decodes a single-block message from one part', () => {
    const msg = message(37)
    const dec = new AirGapDecoder()
    const out = drain(dec, enc(37, 1200), [0])
    expect(Array.from(out!)).toEqual(Array.from(msg))
  })

  it('keeps decoding a single-block message from repeated fountain parts', () => {
    // K = 1 has no distinct mixes: every part is the one block. A static
    // display simply never advances seq, and a repeated seq must stay harmless.
    const msg = message(37)
    const dec = new AirGapDecoder()
    expect(drain(dec, enc(37, 1200), [7])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('returns null before assembly is complete', () => {
    const dec = new AirGapDecoder()
    dec.accept(enc(5000, 1200).partAt(0))
    expect(dec.message()).toBeNull()
  })

  it('returns a fresh copy each time, detached from the assembly buffer', () => {
    const msg = message(3700) // K = 4, so the assembly buffer is 4800 bytes
    const dec = new AirGapDecoder()
    drain(dec, enc(3700, 1200), [0, 1, 2, 3])
    const first = dec.message()!
    // Exactly msgLen bytes, not a window onto the zero-padded assembly.
    expect(first.byteLength).toBe(3700)
    expect(first.buffer.byteLength).toBe(3700)
    first[0] ^= 0xff
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('ignores strings that are not parts', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept('not-a-part').ok).toBe(false)
    expect(dec.accept('tkqr1:1/3/deadbeef').ok).toBe(false)
    expect(dec.accept('bsvpayf2:AAAAAAAAAAAAAAAA').ok).toBe(false)
    expect(dec.accept('').ok).toBe(false)
    expect(dec.accept(`${AIR_GAP_PREFIX}!!!not-base64!!!`).ok).toBe(false)
    expect(dec.accept(`${AIR_GAP_PREFIX}AAAA=`).ok).toBe(false)
    expect(dec.accept(`${AIR_GAP_PREFIX}A`).ok).toBe(false)
    expect(dec.accept(AIR_GAP_PREFIX).ok).toBe(false)
  })

  it('never throws on hostile input', () => {
    const dec = new AirGapDecoder()
    const hostile = [
      AIR_GAP_PREFIX,
      `${AIR_GAP_PREFIX}AAAAAAAAAAAAAAAAAAAA`.repeat(500),
      `${AIR_GAP_PREFIX}////`,
      `${AIR_GAP_PREFIX}${String.fromCodePoint(0)}`,
      `${AIR_GAP_PREFIX}${'A'.repeat(19)}`,
      'air-gap',
      'AIR-GAP:AAAA',
      undefined as unknown as string,
      null as unknown as string,
      42 as unknown as string,
      {} as unknown as string
    ]
    for (const text of hostile) expect(() => dec.accept(text)).not.toThrow()
    for (const text of hostile) expect(dec.accept(text).ok).toBe(false)
  })

  it('rejects a scanned string longer than any valid part before decoding it', () => {
    const dec = new AirGapDecoder()
    const limit = estimatePartCharLength(MAX_BLOCK_BYTES)
    // One past the limit: rejected on length alone, no base64 work.
    expect(dec.accept(`${AIR_GAP_PREFIX}${'A'.repeat(limit - AIR_GAP_PREFIX.length + 1)}`).ok).toBe(
      false
    )
    // A crafted part whose payload is one byte over the block ceiling.
    expect(
      dec.accept(
        craftPart(
          { seq: 0, k: 1, msgLen: MAX_BLOCK_BYTES + 1, crc: 0 },
          new Uint8Array(MAX_BLOCK_BYTES + 1)
        )
      ).ok
    ).toBe(false)
  })

  it('rejects any wire version other than 1', () => {
    const dec = new AirGapDecoder()
    const payload = new Uint8Array(8)
    for (const version of [0, 2, 255]) {
      expect(dec.accept(craftPart({ version, seq: 0, k: 1, msgLen: 8, crc: 0 }, payload)).ok).toBe(
        false
      )
    }
    expect(
      dec.accept(craftPart({ seq: 0, k: 1, msgLen: 8, crc: crc32(payload) }, payload)).ok
    ).toBe(true)
  })

  it('soft-rejects a body that is header-only or shorter', () => {
    const dec = new AirGapDecoder()
    expect(dec.accept(toPart(new Uint8Array(23))).ok).toBe(false)
    expect(dec.accept(toPart(new Uint8Array(22))).ok).toBe(false)
  })

  it('soft-rejects impossible header fields', () => {
    const dec = new AirGapDecoder()
    const payload = new Uint8Array(8)
    expect(dec.accept(craftPart({ seq: 0, k: 0, msgLen: 8, crc: 0 }, payload)).ok).toBe(false)
    expect(dec.accept(craftPart({ seq: 0, k: 1, msgLen: 0, crc: 0 }, payload)).ok).toBe(false)
    expect(
      dec.accept(craftPart({ seq: 0, k: 1, msgLen: MAX_MESSAGE_BYTES + 1, crc: 0 }, payload)).ok
    ).toBe(false)
  })

  it('soft-rejects impossible header fields that the agreement check would admit', () => {
    const dec = new AirGapDecoder()
    // ceil(0 / 8) === 0, so a zero-length message agrees with a zero K.
    expect(dec.accept(craftPart({ seq: 0, k: 0, msgLen: 0, crc: 0 }, new Uint8Array(8))).ok).toBe(
      false
    )
    // ceil(65537 / 2) === 32769, so an oversize message can agree too.
    expect(
      dec.accept(
        craftPart(
          { seq: 0, k: 32769, msgLen: MAX_MESSAGE_BYTES + 1, crc: 0 },
          new Uint8Array([1, 2])
        )
      ).ok
    ).toBe(false)
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: false, have: 0, total: 0 })
  })

  it('rejects a well-formed body carried under the wrong prefix', () => {
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()
    const body = e.partAt(0).slice(AIR_GAP_PREFIX.length)
    expect(dec.accept(`x${AIR_GAP_PREFIX.slice(1)}${body}`).ok).toBe(false)
    expect(dec.accept(`${'x'.repeat(AIR_GAP_PREFIX.length)}${body}`).ok).toBe(false)
    expect(dec.accept(`${AIR_GAP_PREFIX}${body}`).ok).toBe(true)
  })

  it('rejects a part whose body has whitespace spliced into it', () => {
    // `atob` strips ASCII whitespace, so without an explicit charset check this
    // would decode to a perfectly valid part on some runtimes.
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()
    const part = e.partAt(0)
    expect(dec.accept(`${part.slice(0, 20)} ${part.slice(20)}`).ok).toBe(false)
    expect(dec.accept(`${part}\n`).ok).toBe(false)
  })

  it('soft-rejects a header whose K disagrees with msgLen and the payload size', () => {
    const dec = new AirGapDecoder()
    // ceil(24 / 8) is 3, not 2.
    expect(dec.accept(craftPart({ seq: 0, k: 2, msgLen: 24, crc: 0 }, new Uint8Array(8))).ok).toBe(
      false
    )
  })

  it('leaves an in-progress session untouched when it rejects a read', () => {
    const e = enc(5000, 1200)
    const dec = new AirGapDecoder()
    dec.accept(e.partAt(0))
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: false, have: 1, total: 5 })
    const s = drain(dec, e, [1, 2, 3, 4])
    expect(s).not.toBeNull()
  })

  it('does not let one stray frame from another sender erase progress', () => {
    const a = enc(5000, 1200, SESSION_A)
    const b = enc(2400, 1200, SESSION_B)
    const dec = new AirGapDecoder()
    dec.accept(a.partAt(0))
    dec.accept(a.partAt(1))
    // One foreign frame: rejected, progress intact.
    const stray = dec.accept(b.partAt(0))
    expect(stray).toEqual({ ok: false, done: false, have: 2, total: 5 })
    // The locked session still completes.
    expect(drain(dec, a, [2, 3, 4])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(5000)))
  })

  it('switches to a new session after enough consecutive foreign parts', () => {
    const a = enc(5000, 1200, SESSION_A)
    const b = enc(2400, 1200, SESSION_B)
    const dec = new AirGapDecoder()
    dec.accept(a.partAt(0))
    // The first SESSION_SWITCH_PARTS - 1 sightings are rejected...
    for (let i = 0; i < SESSION_SWITCH_PARTS - 1; i++) {
      expect(dec.accept(b.partAt(i)).ok).toBe(false)
    }
    // ...the next consecutive one adopts the new session and is processed.
    const switched = dec.accept(b.partAt(SESSION_SWITCH_PARTS - 1))
    expect(switched.ok).toBe(true)
    expect(switched.total).toBe(2)
    // Finish the new session; parts 0 and 1 were only counted, not ingested.
    expect(drain(dec, b, [0, 1])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(2400)))
  })

  it('restarts the foreign count when the locked session interrupts it', () => {
    const a = enc(5000, 1200, SESSION_A)
    const b = enc(2400, 1200, SESSION_B)
    const dec = new AirGapDecoder()
    dec.accept(a.partAt(0))
    for (let round = 0; round < 4; round++) {
      // Two foreign sightings, then the locked sender again: never switches.
      expect(dec.accept(b.partAt(0)).ok).toBe(false)
      expect(dec.accept(b.partAt(1)).ok).toBe(false)
      expect(dec.accept(a.partAt(round % 5)).ok).toBe(true)
    }
    expect(dec.accept(a.partAt(1)).total).toBe(5)
  })

  it('restarts the foreign count when a different foreign session interrupts it', () => {
    const a = enc(5000, 1200, SESSION_A)
    const b = enc(2400, 1200, SESSION_B)
    const c = enc(3700, 1200, Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))
    const dec = new AirGapDecoder()
    dec.accept(a.partAt(0))
    expect(dec.accept(b.partAt(0)).ok).toBe(false)
    expect(dec.accept(b.partAt(1)).ok).toBe(false)
    expect(dec.accept(c.partAt(0)).ok).toBe(false) // resets the B count
    expect(dec.accept(b.partAt(2)).ok).toBe(false) // B count restarts at 1
    expect(dec.accept(b.partAt(3)).ok).toBe(false)
    expect(dec.accept(a.partAt(1)).total).toBe(5) // still locked to A
  })

  it('acknowledges but never mutates a completed session', () => {
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()
    dec.accept(e.partAt(0))
    expect(dec.accept(e.partAt(1)).done).toBe(true)
    // New unique parts of the same session change nothing.
    for (const seq of [2, 3, 4, 5]) {
      expect(dec.accept(e.partAt(seq))).toEqual({ ok: true, done: true, have: 2, total: 2 })
    }
    // Unusable reads report the completed state truthfully.
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: true, have: 2, total: 2 })
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(2400)))
  })

  it('can switch to a new sender after the current message completed', () => {
    const a = enc(2400, 1200, SESSION_A)
    const b = enc(3700, 1200, SESSION_B)
    const dec = new AirGapDecoder()
    drain(dec, a, [0, 1])
    expect(dec.message()).not.toBeNull()
    for (let i = 0; i < SESSION_SWITCH_PARTS; i++) dec.accept(b.partAt(i))
    expect(drain(dec, b, [0, 1, 2, 3])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(3700)))
  })

  it('bounds the number of buffered mixed parts', () => {
    // For K = 2, every degree-2 fountain part is the same equation {0, 1}:
    // nothing peels, so each distinct seq lands in the pending buffer until
    // the cap, after which mixes are rejected...
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()
    const degreeTwoSeqs: number[] = []
    for (let seq = 2; degreeTwoSeqs.length <= MAX_PENDING_PARTS; seq++) {
      if (blocksForPart(seq, 2).length === 2) degreeTwoSeqs.push(seq)
    }
    for (let i = 0; i < MAX_PENDING_PARTS; i++) {
      expect(dec.accept(e.partAt(degreeTwoSeqs[i])).ok).toBe(true)
    }
    expect(dec.accept(e.partAt(degreeTwoSeqs[MAX_PENDING_PARTS])).ok).toBe(false)
    // ...while systematic parts still land, keeping the session live: the
    // first solve peels every buffered equation at once.
    expect(dec.accept(e.partAt(0))).toEqual({ ok: true, done: true, have: 2, total: 2 })
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(2400)))
  })

  it('bounds the total block references across buffered parts', () => {
    // A large K drives the indices budget to its cap long before the
    // part-count cap: mean soliton degree grows with ln(K).
    const k = 5000
    const e = enc(k, 1, SESSION_A) // blockBytes 1 → K = 5000
    const dec = new AirGapDecoder()
    let accepted = 0
    let sawBudgetReject = false
    for (let seq = k; seq < k + 2 * MAX_PENDING_INDICES; seq++) {
      if (dec.accept(e.partAt(seq)).ok) {
        accepted++
      } else {
        sawBudgetReject = true
        break
      }
    }
    expect(sawBudgetReject).toBe(true)
    // The indices budget tripped, not the part-count cap.
    expect(accepted).toBeLessThan(MAX_PENDING_PARTS)
    // Systematic parts still complete the message despite the full buffer.
    let progress = dec.accept(e.partAt(0))
    for (let seq = 1; seq < k && !progress.done; seq++) progress = dec.accept(e.partAt(seq))
    expect(progress.done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(k)))
  })

  it('rejects a single over-budget mix before materializing its index set', () => {
    const dec = new AirGapDecoder()
    const k = 0xffff
    const seq = 67_433
    const payload = Uint8Array.of(1)
    expect(blocksForPart(seq, k).length).toBe(4241)

    expect(dec.accept(craftPart({ seq, k, msgLen: k, crc: 0 }, payload))).toEqual({
      ok: false,
      done: false,
      have: 0,
      total: k
    })
    // The high-degree rejection does not poison the session: the systematic
    // path remains available and grows solved state only as progress arrives.
    expect(dec.accept(craftPart({ seq: 0, k, msgLen: k, crc: 0 }, payload))).toEqual({
      ok: true,
      done: false,
      have: 1,
      total: k
    })
  })

  it('caps duplicate tracking and keeps the session live past the cap', () => {
    // K = 2 at one byte per block. Feed only fountain parts that resolve to
    // block 0 — pure redundancy once block 0 is solved — so the seen-set
    // grows without the session completing or the pending buffer filling.
    const e = enc(2, 1)
    const dec = new AirGapDecoder()
    expect(dec.accept(e.partAt(0)).have).toBe(1)
    const redundant: number[] = []
    // Bound fixture generation too: a broken mapping must fail this test,
    // not make the fixture search forever during mutation testing.
    for (
      let seq = 2;
      seq < MAX_TRACKED_SEQS * 16 && redundant.length < MAX_TRACKED_SEQS + 1;
      seq++
    ) {
      const blocks = blocksForPart(seq, 2)
      if (blocks.length === 1 && blocks[0] === 0) redundant.push(seq)
    }
    expect(redundant).toHaveLength(MAX_TRACKED_SEQS + 1)
    for (const seq of redundant) {
      const accepted = dec.accept(e.partAt(seq)).ok
      // Avoid allocating thousands of successful Jest matchers in every mutant.
      // Keep the same literal-true assertion, with full diagnostics on failure.
      if (accepted !== true) expect({ seq, accepted }).toEqual({ seq, accepted: true })
    }
    // The tracker is full; new and repeated sequence numbers are simply
    // re-processed as redundancy instead of being remembered, and the honest
    // part still completes the message.
    expect(dec.accept(e.partAt(redundant[redundant.length - 1])).ok).toBe(true)
    expect(dec.accept(e.partAt(1)).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(message(2)))
  })

  it('discards a corrupt assembly and keeps collecting', () => {
    const msg = message(2400) // K = 2
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()
    // Flip a payload byte of part 1 but keep its header, so the header crc no
    // longer matches the bytes that assemble.
    const bytes = partBytes(e.partAt(1))
    bytes[29] ^= 0xff
    const corrupt = toPart(bytes)

    dec.accept(e.partAt(0))
    expect(dec.accept(corrupt).done).toBe(true)
    expect(dec.message()).toBeNull()
    // The reset is total: progress restarts from zero.
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: false, have: 0, total: 0 })
    // The sender is still looping, so a clean cycle completes.
    dec.accept(e.partAt(0))
    expect(dec.accept(e.partAt(1)).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('rejects a part whose payload length disagrees with the pinned block size', () => {
    // Two honest encoders over the SAME message with the SAME session id but
    // different blockBytes both produce K = 2 for 2400 bytes, plus identical
    // msgLen and crc — so they collide on the exact same session key while
    // disagreeing on payload length.
    const msg = message(2400)
    const e1200 = new AirGapEncoder(msg, { blockBytes: 1200, sessionId: SESSION_A })
    const e1500 = new AirGapEncoder(msg, { blockBytes: 1500, sessionId: SESSION_A })
    const dec = new AirGapDecoder()

    dec.accept(e1200.partAt(0)) // pins the session block size at 1200
    const mismatched = dec.accept(e1500.partAt(0))
    expect(mismatched.ok).toBe(false)
    expect(mismatched.have).toBe(1)
    expect(mismatched.total).toBe(2)

    // The session survives the mismatch and the honest part still completes it.
    expect(dec.accept(e1200.partAt(1)).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('rejects a part whose payload was extended past the pinned block size', () => {
    const msg = message(2400) // K = 2
    const e = enc(2400, 1200)
    const dec = new AirGapDecoder()

    dec.accept(e.partAt(0)) // pins the session block size at 1200

    // Extend part 1's payload by 7 bytes with the header untouched: ceil(2400 /
    // 1207) is still 2, so the agreement check alone would let this through.
    const bytes = partBytes(e.partAt(1))
    const extended = new Uint8Array(bytes.length + 7)
    extended.set(bytes)

    const s = dec.accept(toPart(extended))
    expect(s.ok).toBe(false)
    expect(s.have).toBe(1)
    expect(s.total).toBe(2)

    expect(dec.accept(e.partAt(1)).done).toBe(true)
    expect(Array.from(dec.message()!)).toEqual(Array.from(msg))
  })

  it('clears progress on reset()', () => {
    const e = enc(5000, 1200)
    const dec = new AirGapDecoder()
    dec.accept(e.partAt(0))
    dec.accept(e.partAt(1))
    dec.reset()
    expect(dec.message()).toBeNull()
    expect(dec.accept('not-a-part')).toEqual({ ok: false, done: false, have: 0, total: 0 })
    // A reset decoder starts the same message over from scratch.
    expect(dec.accept(e.partAt(0))).toEqual({ ok: true, done: false, have: 1, total: 5 })
  })

  it('treats a same-session-id stream with a different crc as a foreign session', () => {
    // Same session id, K and msgLen, different crc: still a different message,
    // so the decoder must not blend the two — and being foreign, it takes
    // SESSION_SWITCH_PARTS consecutive parts to displace the original.
    const other = message(2400)
    other[0] ^= 0xff
    const encA = new AirGapEncoder(message(2400), { blockBytes: 1200, sessionId: SESSION_A })
    const encB = new AirGapEncoder(other, { blockBytes: 1200, sessionId: SESSION_A })
    expect(crc32(other)).not.toBe(crc32(message(2400)))

    const dec = new AirGapDecoder()
    dec.accept(encA.partAt(0))
    for (let i = 0; i < SESSION_SWITCH_PARTS; i++) dec.accept(encB.partAt(i))
    expect(drain(dec, encB, [0, 1])).not.toBeNull()
    expect(Array.from(dec.message()!)).toEqual(Array.from(other))
  })
})
