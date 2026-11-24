import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import type Point from '@bsv/sdk/primitives/Point'
import * as Utils from '@bsv/sdk/primitives/utils'
import { point64, scalar32 } from '../encoding.js'
import {
  challenge,
  challengeFor,
  deriveScalar,
  proveDleq,
  proveOr,
  proveSchnorr,
  requestDigest,
  streamScalar,
  verifyDleq,
  verifyOr,
  verifySchnorr
} from '../sigma.js'

const filled = (length: number, value: number): number[] => Array.from({ length }, () => value)

describe('sigma scalar derivation and stream', () => {
  it('challenge reads the digest little-endian and reduces mod n', () => {
    const digest = Hash.sha256([1, 2, 3])
    const expected = new BigNumber([...digest].reverse()).umod(new Curve().n)
    expect(challenge([1, 2, 3]).eq(expected)).toBe(true)
  })
  it('deriveScalar follows the fixed HKDF layout', () => {
    const d = new PrivateKey(5)
    const prk = Hash.sha256hmac(Utils.toArray('p sigma v1', 'utf8'), d.toArray('be', 32))
    const okm = Hash.sha256hmac(prk, [...Utils.toArray('p sigma v1 scalar', 'utf8'), 0, 1])
    expect(Utils.toHex(scalar32(deriveScalar(d)))).toBe(Utils.toHex(okm))
  })
  it('deriveScalar is not the child key', () => {
    expect(deriveScalar(new PrivateKey(5)).eq(new BigNumber(5))).toBe(false)
  })
  it('streamScalar is deterministic, in range, and separated by every input', () => {
    const x = deriveScalar(new PrivateKey(5))
    const q = requestDigest(1, filled(64, 1), [9])
    const base = streamScalar(x, q, 0, 1, 0)
    expect(streamScalar(x, q, 0, 1, 0).eq(base)).toBe(true)
    expect(base.gtn(0) && base.lt(new Curve().n)).toBe(true)
    for (const other of [
      streamScalar(x, q, 1, 1, 0),
      streamScalar(x, q, 0, 2, 0),
      streamScalar(x, q, 0, 1, 1),
      streamScalar(x, requestDigest(1, filled(64, 1), [8]), 0, 1, 0)
    ]) {
      expect(other.eq(base)).toBe(false)
    }
  })
  it('requestDigest length-prefixes ctx', () => {
    expect(requestDigest(1, [1], [2, 3])).not.toEqual(requestDigest(1, [1, 2], [3]))
  })
  // Literals produced independently with node:crypto from the specified layout.
  it('matches known answers computed with node:crypto', () => {
    const x = deriveScalar(new PrivateKey(5))
    expect(Utils.toHex(scalar32(x))).toBe(
      '5c7314aa3cf073631b2d9f6d9f589863682e924733ca525c03e22d85d36201cd'
    )
    const q = requestDigest(1, filled(64, 1), [9])
    expect(Utils.toHex(q)).toBe('caf33561629551952c149054c03214565b306dfe5cfcd4f24a128e9685769c17')
    expect(Utils.toHex(scalar32(streamScalar(x, q, 0, 1, 0)))).toBe(
      '109bb891f974d7ea2fc46b98d8c66b891d32221e7ebe1eb1016ec7ba74cee227'
    )
    expect(Utils.toHex(scalar32(streamScalar(x, q, 1, 1, 0)))).toBe(
      '6346bc9c75f8641706db2e70bdc1c48088923db023c9350b8c03f307448789ac'
    )
  })
})

describe('schnorr and dleq proofs', () => {
  const curve = new Curve()
  const x = deriveScalar(new PrivateKey(5))
  const P = curve.g.mul(x)
  const H = curve.g.mul(new BigNumber(7))
  const ctx = filled(68, 3)

  it('schnorr proof verifies, is 96 bytes and repeats exactly', () => {
    const proof = proveSchnorr(x, ctx)
    expect(proof).toHaveLength(96)
    expect(verifySchnorr(P, ctx, proof)).toBe(true)
    expect(proveSchnorr(x, ctx)).toEqual(proof)
  })
  it('schnorr rejects another context, another key and a flipped bit', () => {
    const proof = proveSchnorr(x, ctx)
    expect(verifySchnorr(P, [...ctx.slice(1), 4], proof)).toBe(false)
    expect(verifySchnorr(curve.g.mul(new BigNumber(9)), ctx, proof)).toBe(false)
    expect(verifySchnorr(P, ctx, [...proof.slice(0, 95), proof[95] ^ 1])).toBe(false)
    expect(verifySchnorr(P, ctx, proof.slice(1))).toBe(false)
  })
  it('schnorr verifier returns false for an off-curve commitment and out-of-range scalars', () => {
    const proof = proveSchnorr(x, ctx)
    expect(verifySchnorr(P, ctx, [...proof.slice(0, 63), proof[63] ^ 1, ...proof.slice(64)])).toBe(
      false
    )
    expect(verifySchnorr(P, ctx, [...proof.slice(0, 64), ...filled(32, 0)])).toBe(false)
    expect(verifySchnorr(P, ctx, [...proof.slice(0, 64), ...filled(32, 255)])).toBe(false)
  })
  it('dleq proof verifies, starts with x·H and is 224 bytes', () => {
    const proof = proveDleq(x, H, ctx)
    expect(proof).toHaveLength(224)
    expect(proof.slice(0, 64)).toEqual(point64(H.mul(x)))
    expect(verifyDleq(P, H, ctx, proof)).toBe(true)
    expect(proveDleq(x, H, ctx)).toEqual(proof)
  })
  it('dleq rejects a proof whose P2 belongs to another scalar', () => {
    const forged = [...point64(H.mul(new BigNumber(9))), ...proveDleq(x, H, ctx).slice(64)]
    expect(verifyDleq(P, H, ctx, forged)).toBe(false)
  })
  it('dleq rejects a result whose first equation holds and whose second does not', () => {
    const k = new BigNumber(23)
    const R1 = point64(curve.g.mul(k))
    const R2 = point64(H.mul(k))
    const P2 = point64(H.mul(x.addn(1)))
    const e = challengeFor('dleq', [...R1, ...R2, ...point64(P), ...P2, ...point64(H), ...ctx])
    const s = k.add(e.mul(x)).umod(curve.n)
    expect(curve.g.mul(s).eq(curve.g.mul(k).add(P.mul(e)))).toBe(true)
    expect(H.mul(s).eq(H.mul(k).add(H.mul(x.addn(1)).mul(e)))).toBe(false)
    expect(verifyDleq(P, H, ctx, [...P2, ...R1, ...R2, ...scalar32(s)])).toBe(false)
  })
  it('dleq verifier returns false for a wrong length, off-curve P2 and bad scalars', () => {
    const proof = proveDleq(x, H, ctx)
    expect(verifyDleq(P, H, ctx, proof.slice(1))).toBe(false)
    expect(verifyDleq(P, H, [...ctx.slice(1), 4], proof)).toBe(false)
    expect(verifyDleq(P, H, ctx, [...proof.slice(0, 63), proof[63] ^ 1, ...proof.slice(64)])).toBe(
      false
    )
    expect(verifyDleq(P, H, ctx, [...proof.slice(0, 192), ...filled(32, 0)])).toBe(false)
    expect(verifyDleq(P, H, ctx, [...proof.slice(0, 192), ...filled(32, 255)])).toBe(false)
  })

  const others = [11, 13, 17].map(k => curve.g.mul(new BigNumber(k)))
  it.each([
    [2, 1],
    [2, 2],
    [4, 3]
  ])('ring of %i with the prover at %i verifies', (n, index) => {
    const ring = others.slice(0, n - 1)
    ring.splice(index - 1, 0, P)
    const proof = proveOr(x, ring, index, ctx)
    expect(proof).toHaveLength(64 * n + 32 * n + 32 * (n - 1))
    expect(verifyOr(ring, ctx, proof)).toBe(true)
    expect(proveOr(x, ring, index, ctx)).toEqual(proof)
  })
  it('rejects a prover who is not in the ring', () => {
    expect(verifyOr([others[0], others[1]], ctx, proveOr(x, [P, others[1]], 1, ctx))).toBe(false)
  })
  it('every returned scalar is in [1, n)', () => {
    const proof = proveOr(x, [others[0], P], 2, ctx)
    for (let o = 128; o < proof.length; o += 32) {
      const v = new BigNumber(proof.slice(o, o + 32))
      expect(v.gtn(0) && v.lt(curve.n)).toBe(true)
    }
  })
  it('rejects a ring reordered after proving', () => {
    expect(verifyOr([P, others[0]], ctx, proveOr(x, [others[0], P], 2, ctx))).toBe(false)
  })
  it('or verifier returns false for a wrong length, off-curve R and bad scalars', () => {
    const ring = [others[0], P]
    const proof = proveOr(x, ring, 2, ctx)
    expect(verifyOr(ring, ctx, proof.slice(1))).toBe(false)
    expect(verifyOr(ring, ctx, [...proof.slice(0, 63), proof[63] ^ 1, ...proof.slice(64)])).toBe(
      false
    )
    expect(
      verifyOr(ring, ctx, [...proof.slice(0, 128), ...filled(32, 0), ...proof.slice(160)])
    ).toBe(false)
    expect(
      verifyOr(ring, ctx, [...proof.slice(0, 128), ...filled(32, 255), ...proof.slice(160)])
    ).toBe(false)
    expect(verifyOr(ring, ctx, [...proof.slice(0, 192), ...filled(32, 0)])).toBe(false)
  })
  describe('or rejects one changed s_j or returned e_j, simulated or real', () => {
    // Ring of three with the prover at 2: branches 1 and 3 are simulated, 2 is real.
    // Layout: R_1..R_3 (192) || s_1..s_3 (96) || e_1, e_2 (64).
    const ring = [others[0], P, others[1]]
    const proof = proveOr(x, ring, 2, ctx)
    const bump = (start: number): number[] => {
      const v = new BigNumber(proof.slice(start, start + 32)).addn(1).umod(curve.n)
      return [...proof.slice(0, start), ...scalar32(v), ...proof.slice(start + 32)]
    }
    it('the honest proof verifies', () => {
      expect(verifyOr(ring, ctx, proof)).toBe(true)
    })
    it.each([
      ['s_1, simulated', 192],
      ['s_2, real', 224],
      ['e_1, simulated', 288],
      ['e_2, real', 320]
    ])('%s', (_label, start) => {
      const changed = bump(start)
      const v = new BigNumber(changed.slice(start, start + 32))
      expect(v.gtn(0) && v.lt(curve.n)).toBe(true)
      expect(verifyOr(ring, ctx, changed)).toBe(false)
    })
  })
  it('refuses to prove for an out-of-range position', () => {
    expect(() => proveOr(x, [others[0], P], 3, ctx)).toThrow()
  })
  it('every verifier returns false for a result that is not an array', () => {
    const ring = [others[0], P]
    for (const result of ['abc', null, undefined, 42, { length: 96 }] as never[]) {
      expect(verifySchnorr(P, ctx, result)).toBe(false)
      expect(verifyDleq(P, H, ctx, result)).toBe(false)
      expect(verifyOr(ring, ctx, result)).toBe(false)
    }
  })
  it('every verifier returns false for a result containing a non-byte element', () => {
    const ring = [others[0], P]
    const replaceLast = (proof: number[], value: unknown): number[] =>
      [...proof.slice(0, -1), value] as number[]
    const schnorr = proveSchnorr(x, ctx)
    const dleq = proveDleq(x, H, ctx)
    const or = proveOr(x, ring, 2, ctx)
    for (const value of [schnorr[95] + 256, -1, 1.5, '1']) {
      expect(verifySchnorr(P, ctx, replaceLast(schnorr, value))).toBe(false)
    }
    for (const value of [dleq[223] + 256, -1, 1.5, '1']) {
      expect(verifyDleq(P, H, ctx, replaceLast(dleq, value))).toBe(false)
    }
    for (const value of [or[or.length - 1] + 256, -1, 1.5, '1']) {
      expect(verifyOr(ring, ctx, replaceLast(or, value))).toBe(false)
    }
  })
})

describe('operation tag', () => {
  const curve = new Curve()
  const x = deriveScalar(new PrivateKey(5))
  const P = curve.g.mul(x)
  const H = curve.g.mul(new BigNumber(7))
  const ctx = filled(68, 3)
  const others = [11, 13, 17].map(k => curve.g.mul(new BigNumber(k)))
  const ascii = [...Buffer.from('p sigma v1 challenge', 'ascii')]
  // Any nonce will do: a verifier does not see how it was chosen.
  const k = new BigNumber(23)

  /**
   * A one-of-n result assembled by hand: branches other than `index` simulated with fixed
   * e_j and s_j, the real branch closed against `total`, the challenge over the transcript.
   */
  const assembleOr = (
    ring: Point[],
    index: number,
    total: (transcript: number[]) => BigNumber
  ): { result: number[]; e: BigNumber[]; s: BigNumber[]; R: Point[]; total: BigNumber } => {
    const e: BigNumber[] = []
    const s: BigNumber[] = []
    const R: Point[] = []
    let sum = new BigNumber(0)
    ring.forEach((Pj, i) => {
      if (i === index - 1) {
        e.push(new BigNumber(0))
        s.push(new BigNumber(0))
        R.push(curve.g.mul(k))
        return
      }
      const ej = new BigNumber(100 + i)
      const sj = new BigNumber(200 + i)
      e.push(ej)
      s.push(sj)
      R.push(curve.g.mul(sj).add(Pj.mul(ej).neg()))
      sum = sum.add(ej).umod(curve.n)
    })
    const t = total([...R.flatMap(point64), ...ring.flatMap(point64), ...ctx])
    e[index - 1] = t.sub(sum).umod(curve.n)
    s[index - 1] = k.add(e[index - 1].mul(x)).umod(curve.n)
    const result = [
      ...R.flatMap(point64),
      ...s.flatMap(scalar32),
      ...e.slice(0, ring.length - 1).flatMap(scalar32)
    ]
    return { result, e, s, R, total: t }
  }

  /** Every equation a verifier checks holds for the hand-assembled result. */
  const orEquationsHold = (ring: Point[], a: ReturnType<typeof assembleOr>): boolean => {
    const sum = a.e.reduce((acc, ej) => acc.add(ej).umod(curve.n), new BigNumber(0))
    return (
      sum.eq(a.total) &&
      a.e.every(ej => !ej.isZero()) &&
      ring.every((Pj, j) => curve.g.mul(a.s[j]).eq(a.R[j].add(Pj.mul(a.e[j]))))
    )
  }

  const ringWith = (size: number, index: number): Point[] => {
    const ring = others.slice(0, size - 1)
    ring.splice(index - 1, 0, P)
    return ring
  }

  it('challengeFor prefixes the BRC-230 tag', () => {
    const t = [1, 2, 3]
    expect(Utils.toHex(ascii)).toBe('70207369676d61207631206368616c6c656e6765')
    expect(challengeFor('schnorr', t).eq(challenge([...ascii, 1, ...t]))).toBe(true)
    expect(challengeFor('dleq', t).eq(challenge([...ascii, 2, ...t]))).toBe(true)
    expect(challengeFor('or', t, 3).eq(challenge([...ascii, 3, 3, ...t]))).toBe(true)
    expect(() => challengeFor('or', t)).toThrow()
  })

  it('challengeFor refuses a ring size that is not one byte from 1 to 255', () => {
    for (const ringSize of [0, 256, 1.5, -1]) {
      expect(() => challengeFor('or', [1, 2, 3], ringSize)).toThrow()
    }
    expect(challengeFor('or', [1, 2, 3], 255).eq(challenge([...ascii, 3, 255, 1, 2, 3]))).toBe(true)
  })

  it('verifySchnorr rejects a proof made without the tag', () => {
    const R = point64(curve.g.mul(k))
    const e = challenge([...R, ...point64(P), ...ctx])
    const s = k.add(e.mul(x)).umod(curve.n)
    expect(curve.g.mul(s).eq(curve.g.mul(k).add(P.mul(e)))).toBe(true)
    expect(verifySchnorr(P, ctx, [...R, ...scalar32(s)])).toBe(false)
    expect(verifySchnorr(P, ctx, proveSchnorr(x, ctx))).toBe(true)
  })

  it('verifyDleq rejects a proof made without the tag', () => {
    const R1 = point64(curve.g.mul(k))
    const R2 = point64(H.mul(k))
    const P2 = point64(H.mul(x))
    const e = challenge([...R1, ...R2, ...point64(P), ...P2, ...point64(H), ...ctx])
    const s = k.add(e.mul(x)).umod(curve.n)
    expect(curve.g.mul(s).eq(curve.g.mul(k).add(P.mul(e)))).toBe(true)
    expect(H.mul(s).eq(H.mul(k).add(H.mul(x).mul(e)))).toBe(true)
    expect(verifyDleq(P, H, ctx, [...P2, ...R1, ...R2, ...scalar32(s)])).toBe(false)
    expect(verifyDleq(P, H, ctx, proveDleq(x, H, ctx))).toBe(true)
  })

  it.each([
    [2, 1],
    [2, 2],
    [3, 2]
  ])('verifyOr rejects an untagged proof (n=%i, position %i)', (size, index) => {
    const ring = ringWith(size, index)
    const untagged = assembleOr(ring, index, challenge)
    expect(orEquationsHold(ring, untagged)).toBe(true)
    expect(verifyOr(ring, ctx, untagged.result)).toBe(false)
    expect(verifyOr(ring, ctx, proveOr(x, ring, index, ctx))).toBe(true)
  })

  it('verifyOr rejects a proof tagged for another ring size', () => {
    const ring = ringWith(2, 2)
    const wrongSize = assembleOr(ring, 2, t => challengeFor('or', t, 3))
    expect(orEquationsHold(ring, wrongSize)).toBe(true)
    expect(verifyOr(ring, ctx, wrongSize.result)).toBe(false)
    // The same assembly with the right ring size is accepted.
    expect(verifyOr(ring, ctx, assembleOr(ring, 2, t => challengeFor('or', t, 2)).result)).toBe(
      true
    )
  })

  it('an or request cannot hash the bytes of a dleq transcript', () => {
    const c = ctx
    const P2 = H.mul(x)
    const R1 = point64(curve.g.mul(k))
    const R2 = point64(H.mul(k))
    // dleq over (P, P2, H) with ctx c, and or over the ring [P, P2] with ctx H64 || c.
    const dleqTranscript = [...R1, ...R2, ...point64(P), ...point64(P2), ...point64(H), ...c]
    const orTranscript = [...R1, ...R2, ...[P, P2].flatMap(point64), ...point64(H), ...c]
    expect(orTranscript).toEqual(dleqTranscript)
    const dleqInput = [...ascii, 2, ...dleqTranscript]
    const orInput = [...ascii, 3, 2, ...orTranscript]
    expect(challengeFor('dleq', dleqTranscript).eq(challenge(dleqInput))).toBe(true)
    expect(challengeFor('or', orTranscript, 2).eq(challenge(orInput))).toBe(true)
    expect(orInput).not.toEqual(dleqInput)
  })
})
