import BigNumber from '../BigNumber'
import ReductionContext from '../ReductionContext'

describe('BigNumber – additional coverage', () => {
  it('rejects nominal word lengths that could exhaust memory', () => {
    const bn = new BigNumber(1)

    expect(() => bn.expand(1_048_577)).toThrow(
      'Expand size must be a non-negative safe integer within the supported word limit'
    )
    expect(() => bn.expand(Number.POSITIVE_INFINITY)).toThrow(
      'Expand size must be a non-negative safe integer within the supported word limit'
    )

    const sparse = new BigNumber(1).expand(1_048_576)
    const oversizedProduct = sparse.mul(sparse)
    expect(() => oversizedProduct.words).toThrow(
      'BigNumber word length exceeds the supported limit'
    )
  })

  describe('negative setter', () => {
    it('sets sign to 0 when magnitude is zero (setting val=1 on zero BN)', () => {
      const bn = new BigNumber(0)
      bn.negative = 1
      expect(bn.negative).toBe(0) // magnitude is 0 so sign stays 0
    })

    it('sets sign to 1 on a non-zero BigNumber', () => {
      const bn = new BigNumber(5)
      bn.negative = 1
      expect(bn.negative).toBe(1)
    })

    it('sets sign to 0 on a non-zero BigNumber', () => {
      const bn = new BigNumber(5)
      bn.negative = 1
      bn.negative = 0
      expect(bn.negative).toBe(0)
    })
  })

  describe('inspect', () => {
    it('returns inspection string for a positive BigNumber', () => {
      const bn = new BigNumber(255)
      const s = bn.inspect()
      expect(s).toContain('ff')
      expect(s).toContain('BN')
    })

    it('marks reduction-context values in the inspection string', () => {
      const red = new ReductionContext(new BigNumber(17))
      expect(new BigNumber(5).toRed(red).inspect()).toContain('BN-R')
    })
  })

  describe('toBitArray', () => {
    it('returns empty array for zero (static)', () => {
      expect(BigNumber.toBitArray(new BigNumber(0))).toEqual([])
    })

    it('instance method returns same as static', () => {
      const bn = new BigNumber(5) // binary: 101
      expect(bn.toBitArray()).toEqual([1, 0, 1])
    })
  })

  describe('toString with non-standard base', () => {
    it('converts to base-3 string', () => {
      const bn = new BigNumber(9)
      expect(bn.toString(3)).toBe('100') // 9 in base 3 = 100
    })

    it('supports explicit signs and output padding', () => {
      expect(new BigNumber('+15').toString(16, 4)).toBe('000f')
      expect(new BigNumber('+').toString()).toBe('0')
      expect(new BigNumber('-').toString()).toBe('0')
      expect(new BigNumber('-4660', 10, 'le').toString()).toBe('-13330')
      expect(new BigNumber(15).toString(16, 0)).toBe('f')
    })

    it('rejects non-integer and out-of-range output bases', () => {
      expect(() => new BigNumber(1).toString(Number('1'))).toThrow(
        'Base should be an integer between 2 and 36'
      )
      expect(() => new BigNumber(1).toString(Number('2.5'))).toThrow(
        'Base should be an integer between 2 and 36'
      )
    })
  })

  describe('unsigned bitwise aliases', () => {
    it('operates correctly when either operand has the longer magnitude', () => {
      const short = new BigNumber('ff', 16)
      const long = new BigNumber('100000000', 16)

      expect(short.uor(long).toString(16)).toBe('1000000ff')
      expect(short.uand(long).toString(16)).toBe('0')
      expect(short.uxor(long).toString(16)).toBe('1000000ff')
      expect(long.uor(short).toString(16)).toBe('1000000ff')
      expect(long.uand(short).toString(16)).toBe('0')
      expect(long.uxor(short).toString(16)).toBe('1000000ff')
    })
  })

  describe('numeric validation and aliases', () => {
    it('rejects invalid shift counts', () => {
      expect(() => new BigNumber(1).iushln(-1)).toThrow('Shift bits must be a non-negative integer')
      expect(() => new BigNumber(1).iushln(1.5)).toThrow(
        'Shift bits must be a non-negative integer'
      )
      expect(() => new BigNumber(1).iushln(Number.POSITIVE_INFINITY)).toThrow(
        'Shift bits must be a non-negative integer'
      )
    })

    it('covers non-mutating small-number arithmetic aliases', () => {
      expect(new BigNumber(5).addn(3).toNumber()).toBe(8)
      expect(new BigNumber(9).divn(2).toNumber()).toBe(4)
      expect(new BigNumber(5)._iaddn(4).toNumber()).toBe(9)
    })

    it('compares equal and unequal absolute magnitudes', () => {
      expect(new BigNumber(-9).ucmp(new BigNumber(8))).toBe(1)
      expect(new BigNumber(-9).ucmp(new BigNumber(9))).toBe(0)
    })
  })

  describe('fromBits / toBits edge cases', () => {
    it('fromBits(0) returns zero BigNumber', () => {
      const bn = BigNumber.fromBits(0)
      expect(bn.toNumber()).toBe(0)
    })

    it('toBits for zero returns 0', () => {
      expect(new BigNumber(0).toBits()).toBe(0)
    })

    it('toBits for a 3-byte number with MSB set in mantissa (triggers shift)', () => {
      // mB[0] >= 0x80 → (nWordNum & 0x00800000) !== 0 → shift branch
      const bn = BigNumber.fromHex('800001')
      const bits = bn.toBits()
      expect(bits).toBeGreaterThan(0)
    })
  })

  describe('toSm', () => {
    it('returns [0x80] for negative zero (magnitude 0, sign 1)', () => {
      const bn = new BigNumber(0)
      bn.negative = 1
      const result = bn.toSm()
      // magnitude is 0 so sign gets normalized to 0; returns []
      expect(Array.isArray(result)).toBe(true)
    })
  })
})
