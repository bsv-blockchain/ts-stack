import { describe, expect, it } from 'vitest'

import { computePayouts, fibonacciWeights, requiredShare, sumOfWeights } from './fibonacci.js'

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

describe('requiredShare', () => {
  it('is the remainder-free Fibonacci share of a rank', () => {
    expect(requiredShare(1000, 5, 1)).toBe(416)
    expect(requiredShare(1000, 5, 2)).toBe(250)
    expect(requiredShare(1000, 5, 5)).toBe(83)
    expect(requiredShare(20, 3, 1)).toBe(10)
    expect(requiredShare(1000, 16, 16)).toBe(0)
    expect(requiredShare(7, 1, 1)).toBe(7)
  })

  it('never exceeds what a larger fee pays rank 1, where the full payout is not monotone', () => {
    expect(computePayouts(1007, 5)[0]).toBe(423)
    expect(computePayouts(1008, 5)[0]).toBe(420)
    expect(requiredShare(1007, 5, 1)).toBe(419)
    expect(computePayouts(1003, 3)[0]).toBe(503)
    expect(computePayouts(1004, 3)[0]).toBe(502)
    expect(requiredShare(1003, 3, 1)).toBe(501)
  })

  it('stays exact for fees beyond 2^53 / weight', () => {
    const total = 2_100_000_000_000_000
    expect(requiredShare(total, 2, 1)).toBe(total / 2)
    expect(requiredShare(total, 64, 64)).toBe(Number(BigInt(total) / BigInt(sumOfWeights(64))))
  })

  it('rejects an invalid fee, rank count, or rank', () => {
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
