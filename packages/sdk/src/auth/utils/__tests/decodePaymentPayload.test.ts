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
})
