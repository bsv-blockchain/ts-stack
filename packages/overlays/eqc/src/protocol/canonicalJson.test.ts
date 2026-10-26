import { describe, expect, it } from 'vitest'

import { canonicalJson } from './canonicalJson.js'

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}'
    )
  })

  it('omits undefined object members and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}')
  })

  it('escapes strings exactly as JSON.stringify does', () => {
    const value = 'quote " newline \n separator  '
    expect(canonicalJson(value)).toBe(JSON.stringify(value))
  })

  it('normalizes negative zero', () => {
    expect(canonicalJson(-0)).toBe('0')
  })

  it('rejects numbers that are not safe integers', () => {
    expect(() => canonicalJson(1.5)).toThrow(TypeError)
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
  })

  it('rejects values JSON cannot carry', () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
    expect(() => canonicalJson(10n)).toThrow(TypeError)
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError)
  })

  it('rejects nesting deeper than 32 levels', () => {
    let value: unknown = 1
    for (let depth = 0; depth < 40; depth++) value = [value]
    expect(() => canonicalJson(value)).toThrow(RangeError)
  })
})
