import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import * as Hash from '@bsv/sdk/primitives/Hash'
import PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import * as Utils from '@bsv/sdk/primitives/utils'
import { scalar32 } from '../encoding.js'
import { challenge, deriveScalar, requestDigest, streamScalar } from '../sigma.js'

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
})
