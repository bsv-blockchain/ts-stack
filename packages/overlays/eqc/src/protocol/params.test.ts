import { describe, expect, it } from 'vitest'

import { parseHostParams, type HostParams } from './params.js'

const valid: HostParams = {
  version: 1,
  host: `02${'ab'.repeat(32)}`,
  threshold: 3,
  topK: 5,
  floorFeeSats: 1000,
  minPayoutSats: 1,
  maxQueryTtlMs: 60_000,
  classes: ['overlay-lookup']
}

describe('parseHostParams', () => {
  it('returns a copy holding only known fields', () => {
    expect(parseHostParams({ ...valid, extra: true })).toEqual(valid)
  })

  it.each([
    ['a string', 'params'],
    ['another version', { ...valid, version: 2 }],
    ['a bad host key', { ...valid, host: 'ab' }],
    ['a zero floor', { ...valid, floorFeeSats: 0 }],
    ['a fractional threshold', { ...valid, threshold: 1.5 }],
    ['non-string classes', { ...valid, classes: [1] }],
    ['too many classes', { ...valid, classes: Array.from({ length: 65 }, (_, i) => `c${i}`) }]
  ])('rejects %s', (_label, value) => {
    expect(() => parseHostParams(value)).toThrow(TypeError)
  })
})
