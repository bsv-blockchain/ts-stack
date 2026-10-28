import { types } from 'node:util'
import { decodePaymentPayload } from '../receiverPaymentPayload.js'

const invalidUtf8 = [
  [0xc0, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xe2, 0x82]
]

describe('receiver-owned payload decoding across supported SDK releases', () => {
  test.each(['application/json', 'text/plain', 'application/x-www-form-urlencoded'])(
    'rejects malformed authenticated UTF8 before decoding %s',
    contentType => {
      for (const bytes of invalidUtf8) {
        const body = Uint8Array.from(bytes)
        let caught: unknown
        try {
          decodePaymentPayload(body, contentType)
        } catch (error) {
          caught = error
        }
        expect(types.isNativeError(caught)).toBe(true)
        expect(caught).toMatchObject({
          name: 'TypeError',
          code: 'ERR_ENCODING_INVALID_ENCODED_DATA'
        })
        expect([...body]).toEqual(bytes)
      }
    }
  )
  test('preserves canonical Unicode and existing leading BOM semantics without modifying raw bytes', () => {
    const body = Buffer.from('\ufeff{"message":"雪😀"}')
    const before = Buffer.from(body)
    expect(decodePaymentPayload(body, 'application/problem+json; charset=utf-8')).toEqual({
      message: '雪😀'
    })
    expect(body).toEqual(before)
    expect(decodePaymentPayload(Buffer.from('雪😀'), 'text/plain')).toBe('雪😀')
  })
  test('retains duplicate form values in a null-prototype record without prototype authority', () => {
    const value = decodePaymentPayload(
      Buffer.from('__proto__=owned&key=one&key=two'),
      'application/x-www-form-urlencoded'
    ) as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect(value['__proto__']).toBe('owned')
    expect(value.key).toEqual(['one', 'two'])
    expect(Object.prototype).not.toHaveProperty('owned')
  })
  test('preserves an opaque owned body and distinguishes absent from malformed JSON', () => {
    const body = Uint8Array.from([0, 255, 1])
    expect(decodePaymentPayload(body, 'application/octet-stream')).toBe(body)
    expect(decodePaymentPayload(body, undefined)).toBe(body)
    expect(decodePaymentPayload(undefined, 'application/json')).toBeUndefined()
    expect(() => decodePaymentPayload(new Uint8Array(), 'application/json')).toThrow(SyntaxError)
  })
  test('keeps hostile names as owned data and preserves duplicate and integer-key ordering', () => {
    const body = new TextEncoder().encode(
      '__proto__=first&constructor=one&key=a&key=b&__proto__=second&1=n&prototype=p&toString=t&hasOwnProperty=h'
    )
    const before = body.slice()
    const record = decodePaymentPayload(body, 'application/x-www-form-urlencoded') as Record<
      string,
      unknown
    >
    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(Object.keys(record)).toEqual([
      '1',
      '__proto__',
      'constructor',
      'key',
      'prototype',
      'toString',
      'hasOwnProperty'
    ])
    expect(record['__proto__']).toEqual(['first', 'second'])
    expect(record.constructor).toBe('one')
    expect(record.key).toEqual(['a', 'b'])
    expect(record.prototype).toBe('p')
    expect(record.toString).toBe('t')
    expect(record.hasOwnProperty).toBe('h')
    for (const name of Object.keys(record))
      expect(Object.getOwnPropertyDescriptor(record, name)).toMatchObject({
        enumerable: true,
        configurable: true,
        writable: true
      })
    expect(Object.prototype).not.toHaveProperty('first')
    expect(Object.prototype).not.toHaveProperty('second')
    expect(body).toEqual(before)
  })
})
