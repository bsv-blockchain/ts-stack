import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import * as Utils from '@bsv/sdk/primitives/utils'
import { point64, scalar32 } from '../encoding.js'
import {
  challenge,
  deriveScalar,
  proveDleq,
  proveSchnorr,
  requestDigest,
  streamScalar,
  verifyDleq,
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
})
