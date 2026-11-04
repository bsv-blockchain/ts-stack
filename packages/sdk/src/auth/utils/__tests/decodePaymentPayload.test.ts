import { decodePaymentPayload } from '../decodePaymentPayload'

const bytes = (text: string) => new TextEncoder().encode(text)
describe('authenticated payload decoding', () => {
  it('distinguishes absent, empty, text, JSON and opaque nested bodies', () => {
    expect(decodePaymentPayload(undefined, 'application/json')).toBeUndefined()
    expect(decodePaymentPayload(bytes(''), 'text/plain')).toBe('')
    expect(decodePaymentPayload(bytes('雪'), 'text/plain; charset=utf-8')).toBe('雪')
    expect(decodePaymentPayload(bytes('{ "a": 1 }\n'), 'application/problem+json')).toEqual({
      a: 1
    })
    const binary = new Uint8Array([0, 255, 128])
    expect(decodePaymentPayload(binary, 'multipart/form-data; boundary=inner')).toBe(binary)
    expect(decodePaymentPayload(binary, undefined)).toBe(binary)
    expect(() => decodePaymentPayload(binary, 'text/plain')).toThrow()
    expect(() => decodePaymentPayload(bytes('{'), 'application/json')).toThrow()
  })
  it('retains duplicate form fields and prototype-shaped names without quadratic copying', () => {
    const count = 20_000
    const form = decodePaymentPayload(
      bytes(`__proto__=safe&constructor=value&${'x=1&'.repeat(count)}`),
      'application/x-www-form-urlencoded'
    ) as Record<string, unknown>
    expect(Object.getPrototypeOf(form)).toBeNull()
    expect(form.__proto__).toBe('safe')
    expect(form.constructor).toBe('value')
    expect(form.x).toHaveLength(count)
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
