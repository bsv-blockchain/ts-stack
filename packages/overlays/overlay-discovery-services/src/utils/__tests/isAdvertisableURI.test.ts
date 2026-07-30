// uriValidator.test.ts

import { isAdvertisableURI } from '../isAdvertisableURI'

describe('isAdvertisableURI', () => {
  // HTTPS-based tests.
  test('valid HTTPS URI', () => {
    expect(isAdvertisableURI('https://example.com')).toBe(true)
  })

  test('invalid plain HTTP URI', () => {
    expect(isAdvertisableURI('http://example.com')).toBe(false)
  })

  test('invalid HTTPS URI with localhost', () => {
    expect(isAdvertisableURI('https://localhost')).toBe(false)
    expect(isAdvertisableURI('https://LOCALHOST:8080')).toBe(false)
  })

  // Custom HTTPS-based schemes.
  test('valid https+bsvauth URI', () => {
    expect(isAdvertisableURI('https+bsvauth://example.com')).toBe(true)
  })

  test('valid https+bsvauth+smf URI', () => {
    expect(isAdvertisableURI('https+bsvauth+smf://example.com')).toBe(true)
  })

  test('valid https+bsvauth+scrypt-offchain URI', () => {
    expect(isAdvertisableURI('https+bsvauth+scrypt-offchain://example.com')).toBe(true)
  })

  test('valid https+rtt URI', () => {
    expect(isAdvertisableURI('https+rtt://example.com')).toBe(true)
  })

  test('invalid custom HTTPS URI with localhost', () => {
    expect(isAdvertisableURI('https+bsvauth+smf://localhost/lookup')).toBe(false)
    expect(isAdvertisableURI('https+rtt://localhost')).toBe(false)
  })

  test('invalid HTTPS URI with path', () => {
    expect(isAdvertisableURI('https://example.com/path')).toBe(false)
  })

  test('invalid custom HTTPS URI with path', () => {
    expect(isAdvertisableURI('https+bsvauth://example.com/path')).toBe(false)
  })

  // WebSocket scheme.
  test('valid wss URI', () => {
    expect(isAdvertisableURI('wss://example.com')).toBe(true)
  })

  test('invalid wss URI with localhost', () => {
    expect(isAdvertisableURI('wss://localhost')).toBe(false)
  })

  // JS8 Call–based URIs.
  test('valid js8c+bsvauth+smf URI with proper query parameters', () => {
    const uri = 'js8c+bsvauth+smf:?lat=40&long=130&freq=40meters&radius=1000miles'
    expect(isAdvertisableURI(uri)).toBe(true)
  })

  test.each([
    ['a missing query', 'js8c+bsvauth+smf:'],
    ['a missing radius', 'js8c+bsvauth+smf:?lat=40&long=130&freq=40meters'],
    ['a non-numeric latitude', 'js8c+bsvauth+smf:?lat=abc&long=130&freq=40meters&radius=1000miles'],
    ['a zero frequency', 'js8c+bsvauth+smf:?lat=40&long=130&freq=0&radius=1000miles']
  ])('invalid js8c+bsvauth+smf URI with %s', (_case, uri) => {
    expect(isAdvertisableURI(uri)).toBe(false)
  })

  test('valid js8c+bsvauth+smf URI with numeric freq and radius', () => {
    const uri = 'js8c+bsvauth+smf:?lat=40&long=130&freq=7.0&radius=1000'
    expect(isAdvertisableURI(uri)).toBe(true)
  })

  test('invalid js8c+bsvauth+smf URI with out-of-range latitude', () => {
    const uri = 'js8c+bsvauth+smf:?lat=100&long=130&freq=7&radius=1000'
    expect(isAdvertisableURI(uri)).toBe(false)
  })

  // Unknown scheme should return false.
  test('unknown scheme returns false', () => {
    expect(isAdvertisableURI('ftp://example.com')).toBe(false)
    expect(isAdvertisableURI('mailto:user@example.com')).toBe(false)
  })
})
