import { describe, expect, it } from '@jest/globals'
import {
  exactMembers,
  jsonArray,
  jsonByteArray,
  jsonObject,
  jsonUint32,
  parseStrictJson,
  parseStrictJsonBytes
} from '../strictJson.js'

describe('strict JSON', () => {
  it('parses the RFC 8259 grammar into prototype-free objects', () => {
    const value = parseStrictJson(
      ' {"a":[1,-2.5e-1,true,false,null,"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00"],"b":{},"c":[]} ',
      'test'
    )
    expect(value).toEqual({ a: [1, -0.25, true, false, null, '"\\/\b\f\n\r\té😀'], b: {}, c: [] })
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(parseStrictJson('{"__proto__":1}', 'test')).toEqual(
      Object.assign(Object.create(null), { ['__proto__']: 1 })
    )
  })

  it.each([
    ['a duplicate member', '{"a":1,"a":2}', 'duplicate member a'],
    ['trailing data', '{} {}', 'trailing data'],
    ['a leading-zero number', '01', 'trailing data'],
    [
      'an integer written as a fraction',
      '{"a":1.0}',
      'an integer written as a fraction or exponent'
    ],
    [
      'an integer written with an exponent',
      '[1e0]',
      'an integer written as a fraction or exponent'
    ],
    ['a bare minus', '-', 'invalid value'],
    ['an unterminated string', '"abc', 'unterminated string'],
    ['a raw control character', '"a\nb"', 'control character'],
    ['an invalid escape', '"\\x"', 'invalid escape'],
    ['a short unicode escape', '"\\u12"', 'invalid unicode escape'],
    ['a lone low surrogate', '"\\udc00"', 'unpaired surrogate'],
    ['a lone high surrogate', '"\\ud800x"', 'unpaired surrogate'],
    ['a high surrogate before a non-surrogate', '"\\ud800\\u0041"', 'unpaired surrogate'],
    ['an invalid literal', 'tru', 'invalid literal'],
    ['a missing colon', '{"a" 1}', 'expected :'],
    ['a non-string member name', '{1:1}', 'expected member name'],
    ['a missing array separator', '[1 2]', 'expected , or ]'],
    ['a missing object separator', '{"a":1 "b":2}', 'expected , or }'],
    ['excessive nesting', `${'['.repeat(70)}${']'.repeat(70)}`, 'nesting too deep']
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseStrictJson(text, 'test')).toThrow(message)
  })

  it('requires strict UTF-8 bytes', () => {
    expect(parseStrictJsonBytes(new Uint8Array([0x7b, 0x7d]), 'test')).toEqual({})
    expect(() => parseStrictJsonBytes([0xef, 0xbb, 0xbf, 0x7b, 0x7d], 'test')).toThrow(
      'not strict JSON'
    )
    expect(() => parseStrictJsonBytes([0xc3, 0x28], 'test')).toThrow('not strict UTF-8')
  })

  it('checks member sets and value types', () => {
    const object = jsonObject(parseStrictJson('{"a":1,"b":2}', 'test'), 'test')
    expect(() => exactMembers(object, ['a', 'b'], [], 'test')).not.toThrow()
    expect(() => exactMembers(object, ['a', 'c'], [], 'test')).toThrow('missing c')
    expect(() => exactMembers(object, ['a'], [], 'test')).toThrow('unknown member b')
    expect(() => jsonObject([], 'test')).toThrow('JSON object')
    expect(() => jsonArray({}, 'test')).toThrow('an array')
    expect(jsonUint32(4294967295, 'test')).toBe(4294967295)
    for (const value of [-1, 1.5, 4294967296, true, '1']) {
      expect(() => jsonUint32(value as never, 'test')).toThrow('integer')
    }
    expect(jsonByteArray([0, 255], 'test', 2)).toEqual([0, 255])
    expect(() => jsonByteArray([], 'test', 2)).toThrow('1..2 bytes')
    expect(() => jsonByteArray([1, 2, 3], 'test', 2)).toThrow('1..2 bytes')
    expect(() => jsonByteArray([256], 'test', 2)).toThrow('integer bytes')
    expect(() => jsonByteArray([true], 'test', 2)).toThrow('integer bytes')
  })
})
