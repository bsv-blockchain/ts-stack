import PublicKey from '../../primitives/PublicKey'
import PrivateKey from '../../primitives/PrivateKey'
import BRC42Private from './BRC42.private.vectors'
import Curve from '../../primitives/Curve'
import BigNumber from '../../primitives/BigNumber'
import Point from '../../primitives/Point'

describe('PrivateKey', () => {
  describe('BRC42 vectors', () => {
    BRC42Private.forEach((vector, index) => {
      it(`Passes BRC42 private vector #${index + 1}`, () => {
        const publicKey = PublicKey.fromString(vector.senderPublicKey)
        const privateKey = PrivateKey.fromString(vector.recipientPrivateKey)
        const derived = privateKey.deriveChild(publicKey, vector.invoiceNumber)
        expect(derived.toHex()).toEqual(vector.privateKey)
      })
    })
  })

  describe('PrivateKey Validation and Conversion', () => {
    const curve = new Curve()

    const isValidPrivateKey = (key: string): boolean => {
      try {
        const keyAsNumber = new BigNumber(key, 16)
        return (
          !keyAsNumber.isZero() &&
          keyAsNumber.cmp(curve.n) < 0 &&
          key.length === 64
        )
      } catch {
        return false
      }
    }

    it('Validates and converts valid private keys between hex and string', () => {
      const validKeys = [
        '0000000000000000000000000000000000000000000000000000000000000001',
        'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140',
        '8a2f85e08360a04c8a36b7c22c5e9e9a0d3bcf2f95c97db2b8bd90fc5f5ff66a',
        '1b5a8f2392e6959a7de2b0a58f8a64cc528c9bfc1788ee0d32e1455063e71545'
      ]

      validKeys.forEach((key) => {
        const privateKeyFromHex = PrivateKey.fromHex(key)
        const privateKeyFromString = PrivateKey.fromString(key, 'hex')
        const privateKeyToHex = privateKeyFromHex.toHex()
        const privateKeyToString = privateKeyFromString.toString('hex')
        expect(isValidPrivateKey(privateKeyToHex)).toBe(true)
        expect(isValidPrivateKey(privateKeyToString)).toBe(true)

        // Round-trip conversion checks
        expect(privateKeyToHex).toEqual(key)
        expect(privateKeyToString).toEqual(key)
      })
    })

    // it('Rejects invalid private keys during validation and conversion', () => {
    //   const invalidKeys = [
    //     '0000000000000000000000000000000000000000000000000000000000000000',
    //     'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    //     'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    //     'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe',
    //     '1234567890abcdef',
    //     'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd03641',
    //     'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364',
    //   ]

    //   invalidKeys.forEach((key, index) => {
    //     const isValid = isValidPrivateKey(key)
    //     expect(isValid).toBe(false)
    //     // Ensure invalid keys throw an error during conversion
    //     expect(() => PrivateKey.fromHex(key)).toThrow()
    //     expect(() => PrivateKey.fromString(key, 'hex')).toThrow()
    //   })
    // })

    it('Tests 10,000 random private keys for valid conversions', () => {
      for (let i = 0; i < 10000; i++) {
        const privateKey = PrivateKey.fromRandom()
        const privateKeyHex = privateKey.toHex()
        const privateKeyString = privateKey.toString('hex')

        // Validate the random key's format
        expect(isValidPrivateKey(privateKeyHex)).toBe(true)
        expect(isValidPrivateKey(privateKeyString)).toBe(true)

        // Round-trip conversion checks
        const roundTripHex = PrivateKey.fromHex(privateKeyHex).toHex()
        const roundTripString = PrivateKey.fromString(
          privateKeyString,
          'hex'
        ).toString('hex')
        expect(roundTripHex).toEqual(privateKeyHex)
        expect(roundTripString).toEqual(privateKeyString)
      }
    })
  })
})

describe('PrivateKey public key cache', () => {
  it('returns the same public key as a fresh computation on every call', () => {
    const key = PrivateKey.fromRandom()
    const expected = new Curve().g.mulCT(key)
    const first = key.toPublicKey()
    const second = key.toPublicKey()
    expect(first.toString()).toEqual(second.toString())
    expect(first.eq(expected)).toBe(true)
  })

  it('returns independent objects, so mutating one cannot affect later calls', () => {
    const key = PrivateKey.fromRandom()
    const expected = key.toPublicKey().toString()
    const returned = key.toPublicKey()
    returned.x?.iaddn(1)
    expect(key.toPublicKey().toString()).toEqual(expected)
  })

  it('computes k·G once per key value', () => {
    const mulCT = jest.spyOn(Point.prototype, 'mulCT')
    try {
      const key = PrivateKey.fromRandom()
      mulCT.mockClear()
      key.toPublicKey()
      key.toPublicKey()
      key.toPublicKey()
      expect(mulCT).toHaveBeenCalledTimes(1)
      key.iaddn(1)
      key.toPublicKey()
      key.toPublicKey()
      expect(mulCT).toHaveBeenCalledTimes(2)
    } finally {
      mulCT.mockRestore()
    }
  })

  it('returns the point at infinity for a zero key, as before caching', () => {
    expect(new PrivateKey().toPublicKey().toString()).toEqual('00')
    expect(new PrivateKey(0).toPublicKey().toString()).toEqual('00')
  })

  it('recomputes after an in-place sign change', () => {
    const fresh = (k: PrivateKey): string => new Curve().g.mulCT(k).encode(true, 'hex') as string
    const negated = new PrivateKey(7)
    negated.toPublicKey()
    negated.ineg()
    expect(negated.toPublicKey().toString()).toEqual(fresh(negated))
    const crossed = new PrivateKey(7)
    crossed.toPublicKey()
    crossed.isubn(14)
    expect(crossed.toPublicKey().toString()).toEqual(fresh(crossed))
  })

  it('handles keys wider than 32 bytes', () => {
    const fresh = (k: PrivateKey): string => new Curve().g.mulCT(k).encode(true, 'hex') as string
    const wide = new PrivateKey('01' + 'ab'.repeat(32), 16, 'be', 'nocheck')
    expect(wide.toPublicKey().toString()).toEqual(fresh(wide))
    const grown = new PrivateKey('ff'.repeat(31), 16)
    grown.toPublicKey()
    grown.imul(grown)
    expect(grown.toPublicKey().toString()).toEqual(fresh(grown))
  })

  it('recomputes after the key value changes in place', () => {
    const key = new PrivateKey(7)
    const before = key.toPublicKey().toString()
    key.iaddn(1)
    expect(key.toPublicKey().toString()).not.toEqual(before)
    expect(key.toPublicKey().toString()).toEqual(new PrivateKey(8).toPublicKey().toString())
  })
})
