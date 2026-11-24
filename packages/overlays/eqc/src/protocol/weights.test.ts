import { describe, expect, it } from 'vitest'

import {
  computePayouts,
  minimumFeeForAllRanks,
  requiredShare,
  squareRootWeights,
  sumOfWeights
} from './weights.js'

describe('squareRootWeights', () => {
  it('weights rank i of k by sqrt(k - i + 1), largest first', () => {
    expect(squareRootWeights(1)).toEqual([1])
    expect(squareRootWeights(5)).toEqual([Math.sqrt(5), 2, Math.sqrt(3), Math.SQRT2, 1])
    // BRC-178 worked example: S for k = 5 summed in rank order.
    expect(sumOfWeights(5)).toBe(8.38233234744176)
    expect(sumOfWeights(3)).toBe(4.146264369941973)
  })

  it('rejects k outside 1..64', () => {
    expect(() => squareRootWeights(0)).toThrow(RangeError)
    expect(() => squareRootWeights(65)).toThrow(RangeError)
    expect(() => squareRootWeights(2.5)).toThrow(RangeError)
  })
})

describe('computePayouts', () => {
  it('reproduces the BRC-178 worked examples', () => {
    expect(computePayouts(12, 5)).toEqual([5, 2, 2, 2, 1])
    expect(computePayouts(20, 3)).toEqual([10, 6, 4])
  })

  it('pays every rank at the 1000 satoshi default floor', () => {
    expect(computePayouts(1000, 5)).toEqual([269, 238, 206, 168, 119])
    expect(computePayouts(1000, 3)).toEqual([418, 341, 241])
  })

  it('floors small fees to zero for trailing ranks, with the remainder at rank 1', () => {
    expect(computePayouts(2, 5)).toEqual([2, 0, 0, 0, 0])
  })

  it('pays every one of k ranks from minimumFeeForAllRanks(k)', () => {
    for (let k = 1; k <= 64; k++) {
      const fee = minimumFeeForAllRanks(k)
      expect(Math.min(...computePayouts(fee, k))).toBeGreaterThanOrEqual(1)
      if (fee > 1) expect(Math.min(...computePayouts(fee - 1, k))).toBe(0)
    }
    expect(minimumFeeForAllRanks(5)).toBe(9)
    expect(minimumFeeForAllRanks(64)).toBe(346)
  })

  it('conserves a fee at the BSV supply across 64 ranks', () => {
    const total = 2_100_000_000_000_000
    const payouts = computePayouts(total, 64)
    expect(payouts.reduce((sum, value) => sum + value, 0)).toBe(total)
  })

  it('rejects fees that are not positive safe integers', () => {
    expect(() => computePayouts(0, 3)).toThrow(RangeError)
    expect(() => computePayouts(1.5, 3)).toThrow(RangeError)
  })
})

describe('requiredShare', () => {
  it('is the remainder-free square-root share of a rank', () => {
    expect(requiredShare(1000, 5, 1)).toBe(266)
    expect(requiredShare(1000, 5, 2)).toBe(238)
    expect(requiredShare(1000, 5, 5)).toBe(119)
    expect(requiredShare(20, 3, 1)).toBe(8)
    expect(requiredShare(1000, 64, 64)).toBe(2)
    expect(requiredShare(7, 1, 1)).toBe(7)
  })

  it('stays covered where the rank 1 payout shrinks as the fee grows', () => {
    expect(computePayouts(1001, 5)[0]).toBe(270)
    expect(computePayouts(1002, 5)[0]).toBe(268)
    expect(requiredShare(1001, 5, 1)).toBe(267)
    expect(computePayouts(1011, 3)[0]).toBe(424)
    expect(computePayouts(1012, 3)[0]).toBe(423)
    expect(requiredShare(1011, 3, 1)).toBe(422)
  })

  it('rejects out-of-range arguments', () => {
    expect(() => requiredShare(0, 3, 1)).toThrow(RangeError)
    expect(() => requiredShare(1.5, 3, 1)).toThrow(RangeError)
    expect(() => requiredShare(1000, 0, 1)).toThrow(RangeError)
    expect(() => requiredShare(1000, 65, 1)).toThrow(RangeError)
    expect(() => requiredShare(1000, 3, 0)).toThrow(RangeError)
    expect(() => requiredShare(1000, 3, 4)).toThrow(RangeError)
    expect(() => requiredShare(1000, 3, 1.5)).toThrow(RangeError)
    expect(() => requiredShare(0, 3, 1)).toThrow('feeSats must be a positive safe integer')
    expect(() => requiredShare(1000, 3, 4)).toThrow('rank must be an integer from 1 to 3')
  })
})
