import BigNumber from '@bsv/sdk/primitives/BigNumber'
import * as Utils from '@bsv/sdk/primitives/utils'
import { parsePlaintext, parsePoint33, point64, scalar32 } from '../encoding.js'

const filled = (length: number, value: number): number[] => Array.from({ length }, () => value)
const G33 = Utils.toArray(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex'
)
const H33 = Utils.toArray(
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  'hex'
) // 2·G

describe('sigma encoding', () => {
  it('round-trips a compressed point to 64 bytes', () => {
    expect(Utils.toHex(point64(parsePoint33(G33, 'point')))).toBe(
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
        '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
    )
  })

  it.each([
    ['wrong length', G33.slice(0, 32)],
    ['uncompressed prefix', [0x04, ...G33.slice(1)]],
    ['x not below the field prime', [0x02, ...filled(32, 0xff)]],
    ['x not on the curve', [0x02, ...filled(31, 0), 0x05]]
  ])('rejects a point with %s', (_n, bytes) => {
    expect(() => parsePoint33(bytes, 'point')).toThrow()
  })

  it('pads a scalar to 32 bytes', () => {
    expect(scalar32(new BigNumber(1))).toEqual([...filled(31, 0), 1])
  })

  it('key accepts empty or exactly one point other than G', () => {
    expect(parsePlaintext('key', [])).toEqual({ operation: 'key' })
    expect(parsePlaintext('key', H33)).toMatchObject({ operation: 'key' })
    expect(() => parsePlaintext('key', G33)).toThrow()
    expect(() => parsePlaintext('key', [1, 2, 3])).toThrow()
  })

  it('schnorr bounds ctx at 1 and 4096 bytes', () => {
    expect(() => parsePlaintext('schnorr', [])).toThrow()
    expect(parsePlaintext('schnorr', filled(4096, 7))).toMatchObject({ operation: 'schnorr' })
    expect(() => parsePlaintext('schnorr', filled(4097, 7))).toThrow()
  })

  it('dleq needs H then a non-empty ctx, and H must not be G', () => {
    expect(() => parsePlaintext('dleq', G33)).toThrow()
    expect(() => parsePlaintext('dleq', [...G33, 1])).toThrow()
    expect(parsePlaintext('dleq', [...H33, 1])).toMatchObject({ operation: 'dleq', ctx: [1] })
  })

  it('or reads n, i, n-1 points, then ctx', () => {
    expect(parsePlaintext('or', [2, 1, ...H33, 9])).toMatchObject({ n: 2, index: 1, ctx: [9] })
    for (const bad of [
      [1, 1, 9],
      [9, 1, 9],
      [2, 0, ...H33, 9],
      [2, 3, ...H33, 9],
      [2, 1, ...H33]
    ]) {
      expect(() => parsePlaintext('or', bad)).toThrow()
    }
    expect(() => parsePlaintext('or', [3, 1, ...H33, ...H33, 9])).toThrow()
  })
})
