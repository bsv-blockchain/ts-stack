import {
  preparePaymentTransport,
  authenticatedContentType,
  buildMultipartPayment,
  findPaymentBytes,
  paymentBoundary,
  paymentTransports,
  resolvePaymentTransportLimits
} from '../paymentTransport.js'
import fc from 'fast-check'

describe('BRC-118 transport selection primitives', () => {
  it('preserves legacy content types and binds the exact multipart boundary', () => {
    expect(authenticatedContentType('application/json; charset=utf-8')).toBe('application/json')
    const multipart = 'multipart/form-data; boundary="ABC"'
    expect(authenticatedContentType(multipart)).toBe(multipart)
    expect(paymentBoundary(multipart)).toBe('ABC')
  })
  it('treats absent capabilities as header-only and ignores unknown tokens', () => {
    expect([...paymentTransports(null)]).toEqual(['header'])
    expect([...paymentTransports('header, unknown, multipart, header')]).toEqual([
      'header',
      'multipart'
    ])
    expect([...paymentTransports('unknown')]).toEqual([])
    expect(() => paymentTransports('x'.repeat(257))).toThrow()
  })
  it('validates configurable budgets before wallet work', () => {
    expect(resolvePaymentTransportLimits().maxPaymentHeaderBytes).toBe(8192)
    for (const maximum of [0, -1, Infinity, 1.5, 8193]) {
      expect(() => resolvePaymentTransportLimits({ maxPaymentHeaderBytes: maximum })).toThrow()
    }
  })
  it('matches native byte search even for adversarial repeated prefixes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 1000 }),
        fc.uint8Array({ minLength: 1, maxLength: 70 }),
        (bytes, needle) => {
          expect(findPaymentBytes(bytes, needle)).toBe(Buffer.from(bytes).indexOf(needle))
        }
      )
    )
    expect(
      findPaymentBytes(
        new Uint8Array(100_000).fill(65),
        new Uint8Array([...Array(69).fill(65), 66])
      )
    ).toBe(-1)
  })
  it('bounds the final body including framing and rejects media-type injection', () => {
    const built = buildMultipartPayment('{}', undefined, 1000, 'fixed')
    expect(() => buildMultipartPayment('{}', undefined, built.body.length - 1, 'fixed')).toThrow(
      'body limit'
    )
    expect(() =>
      buildMultipartPayment(
        '{}',
        { bytes: new Uint8Array(), contentType: 'text/plain\r\nInjected: true' },
        1000
      )
    ).toThrow()
  })
  it('selects exactly at the header threshold and enforces aggregate header limits', () => {
    const original = { method: 'POST', headers: {} }
    const transports = new Set(['header', 'multipart'])
    const limits = resolvePaymentTransportLimits()
    expect(preparePaymentTransport('x'.repeat(8192), original, transports, limits).transport).toBe(
      'header'
    )
    expect(preparePaymentTransport('x'.repeat(8193), original, transports, limits).transport).toBe(
      'multipart'
    )
    expect(() =>
      preparePaymentTransport(
        '{}',
        { ...original, headers: { 'x-large': 'x'.repeat(16384) } },
        transports,
        limits
      )
    ).toThrow('aggregate header budget')
  })
})
