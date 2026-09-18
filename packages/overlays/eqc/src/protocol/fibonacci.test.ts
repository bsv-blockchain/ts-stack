import { describe, expect, it } from 'vitest'

import { computePayouts, fibonacciWeights, sumOfWeights } from './fibonacci.js'

describe('fibonacciWeights', () => {
  it('lists F_k down to F_1', () => {
    expect(fibonacciWeights(1)).toEqual([1])
    expect(fibonacciWeights(5)).toEqual([5, 3, 2, 1, 1])
    expect(sumOfWeights(5)).toBe(12)
    expect(sumOfWeights(14)).toBe(986)
  })

  it('rejects k outside 1..64', () => {
    expect(() => fibonacciWeights(0)).toThrow(RangeError)
    expect(() => fibonacciWeights(65)).toThrow(RangeError)
    expect(() => fibonacciWeights(2.5)).toThrow(RangeError)
  })
})

describe('computePayouts', () => {
  it('reproduces the BRC-178 worked examples', () => {
    expect(computePayouts(12, 5)).toEqual([5, 3, 2, 1, 1])
    expect(computePayouts(20, 3)).toEqual([10, 5, 5])
  })

  it('gives the remainder to rank 1', () => {
    expect(computePayouts(1000, 5)).toEqual([418, 250, 166, 83, 83])
  })

  it('floors small fees to zero for slow ranks', () => {
    expect(computePayouts(2, 5)).toEqual([2, 0, 0, 0, 0])
  })

  it('stays exact for fees beyond 2^53 / weight', () => {
    const total = 2_100_000_000_000_000
    const payouts = computePayouts(total, 64)
    expect(payouts.reduce((sum, value) => sum + value, 0)).toBe(total)
  })

  it('rejects invalid totals', () => {
    expect(() => computePayouts(0, 3)).toThrow(RangeError)
    expect(() => computePayouts(1.5, 3)).toThrow(RangeError)
  })
})
