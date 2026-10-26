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

  test('rejects private, special-use, and obfuscated IP addresses', () => {
    for (const uri of [
      'https://127.0.0.1',
      'https://0x7f000001',
      'https://2130706433',
      'https://10.0.0.1',
      'https://169.254.169.254',
      'https://172.16.0.1',
      'https://192.168.0.1',
      'https://[::1]',
      'https://[fd00::1]',
      'wss://[fe80::1]'
    ]) {
      expect(isAdvertisableURI(uri)).toBe(false)
    }
    expect(isAdvertisableURI('https://8.8.8.8')).toBe(true)
    expect(isAdvertisableURI('https://[2606:4700:4700::1111]')).toBe(true)
  })

  test.each([
    ['0.1.2.3', false],
    ['1.0.0.1', true],
    ['9.255.255.255', true],
    ['10.0.0.1', false],
    ['11.0.0.1', true],
    ['126.255.255.255', true],
    ['127.0.0.1', false],
    ['128.0.0.1', true],
    ['100.63.255.255', true],
    ['100.64.0.1', false],
    ['100.127.255.255', false],
    ['100.128.0.1', true],
    ['169.253.255.255', true],
    ['169.254.0.1', false],
    ['169.255.0.1', true],
    ['172.15.255.255', true],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true],
    ['192.0.0.8', false],
    ['192.0.0.9', true],
    ['192.0.0.10', true],
    ['192.0.0.11', false],
    ['192.0.1.1', true],
    ['192.0.2.1', false],
    ['192.0.3.1', true],
    ['192.87.99.1', true],
    ['192.88.98.1', true],
    ['192.88.99.1', false],
    ['192.88.100.1', true],
    ['192.89.99.1', true],
    ['192.167.0.1', true],
    ['192.168.0.1', false],
    ['192.169.0.1', true],
    ['198.17.0.1', true],
    ['198.18.0.1', false],
    ['198.19.255.255', false],
    ['198.20.0.1', true],
    ['198.50.100.1', true],
    ['198.51.99.1', true],
    ['198.51.100.1', false],
    ['198.51.101.1', true],
    ['198.52.100.1', true],
    ['202.0.113.1', true],
    ['203.0.112.1', true],
    ['203.0.113.1', false],
    ['203.0.114.1', true],
    ['204.0.113.1', true],
    ['223.255.255.255', true],
    ['224.0.0.1', false],
    ['255.255.255.255', false]
  ] as const)('classifies IPv4 boundary address %s as advertisable=%s', (address, expected) => {
    expect(isAdvertisableURI(`https://${address}`)).toBe(expected)
  })

  test.each([
    ['::', false],
    ['::1', false],
    ['::2', true],
    ['fbff::1', true],
    ['fc00::1', false],
    ['fdff::1', false],
    ['fe7f::1', true],
    ['fe80::1', false],
    ['febf::1', false],
    ['fec0::1', true],
    ['feff::1', true],
    ['ff00::1', false],
    ['2001:db7::1', true],
    ['2001:db8::1', false],
    ['2001:db9::1', true],
    ['::ffff:192.0.2.1', false],
    ['2606:4700:4700::1111', true]
  ] as const)('classifies IPv6 boundary address %s as advertisable=%s', (address, expected) => {
    expect(isAdvertisableURI(`https://[${address}]`)).toBe(expected)
  })

  test.each([
    ['https://api.localhost', false],
    ['https://api.local', false],
    ['https://api.internal', false],
    ['https://api.home.arpa', false],
    ['https://localhost.', false],
    ['https://example.com.', true],
    ['https://xn--bcher-kva.example', false],
    ['https://example.xn--bcher-kva', false],
    ['https://example-xn--label.com', true]
  ] as const)('classifies hostname boundary %s as advertisable=%s', (uri, expected) => {
    expect(isAdvertisableURI(uri)).toBe(expected)
  })

  test('rejects embedded credentials, fragments, and oversized URIs', () => {
    expect(isAdvertisableURI('https://user:password@example.com')).toBe(false)
    expect(isAdvertisableURI('https+bsvauth://user@example.com')).toBe(false)
    expect(isAdvertisableURI('wss://user@example.com')).toBe(false)
    expect(isAdvertisableURI('https://example.com/#fragment')).toBe(false)
    expect(isAdvertisableURI('wss://example.com/#fragment')).toBe(false)
    expect(isAdvertisableURI(`https://${'a'.repeat(4097)}.example`)).toBe(false)
  })

  test('accepts exactly 4096 URI bytes and rejects the next byte', () => {
    const prefix = 'wss://example.com/?q='
    const atLimit = `${prefix}${'a'.repeat(4096 - prefix.length)}`
    const aboveLimit = `${atLimit}a`

    expect(new TextEncoder().encode(atLimit)).toHaveLength(4096)
    expect(new TextEncoder().encode(aboveLimit)).toHaveLength(4097)
    expect(isAdvertisableURI(atLimit)).toBe(true)
    expect(isAdvertisableURI(aboveLimit)).toBe(false)
  })

  test('rejects empty and non-string inputs without throwing', () => {
    for (const value of ['', '   ', null, undefined, 0, false, {}, []]) {
      expect(() => isAdvertisableURI(value as string)).not.toThrow()
      expect(isAdvertisableURI(value as string)).toBe(false)
    }
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

  test.each([
    ['-90', '0', true],
    ['90', '0', true],
    ['-90.0', '0.0', true],
    ['89.125', '-179.875', true],
    ['-91', '0', false],
    ['91', '0', false],
    ['0', '-181', false],
    ['0', '181', false],
    ['01', '0', false],
    ['0', '001', false],
    ['+1', '0', false],
    ['1.', '0', false],
    ['.5', '0', false],
    ['1.23junk', '0', false],
    ['junk1.23', '0', false]
  ] as const)(
    'classifies JS8 coordinates lat=%s long=%s as advertisable=%s',
    (lat, long, expected) => {
      const uri = `js8c+bsvauth+smf:?lat=${lat}&long=${long}&freq=7Hz&radius=1000km`
      expect(isAdvertisableURI(uri)).toBe(expected)
    }
  )

  test.each([
    ['7', true],
    ['7.0', true],
    ['7.125', true],
    ['7MHz', true],
    ['7meter/second', true],
    ['7meter_second', true],
    ['7meter-second', true],
    ['%207Hz%20', true],
    ['0', false],
    ['0.0Hz', false],
    ['-1Hz', false],
    ['.5Hz', false],
    ['7.', false],
    ['7 Hz', false],
    ['7Hz!', false],
    ['7Hz.more', false]
  ] as const)('classifies JS8 measurement %s as advertisable=%s', (freq, expected) => {
    const uri = `js8c+bsvauth+smf:?lat=40&long=130&freq=${freq}&radius=1000km`
    expect(isAdvertisableURI(uri)).toBe(expected)
  })

  test.each(['lat', 'long', 'freq', 'radius'] as const)(
    'rejects JS8 advertisements missing or empty %s',
    parameter => {
      const complete = { lat: '40', long: '130', freq: '7Hz', radius: '1000km' }
      const missing = new URLSearchParams(complete)
      missing.delete(parameter)
      const empty = new URLSearchParams({ ...complete, [parameter]: '' })

      expect(isAdvertisableURI(`js8c+bsvauth+smf:?${missing.toString()}`)).toBe(false)
      expect(isAdvertisableURI(`js8c+bsvauth+smf:?${empty.toString()}`)).toBe(false)
    }
  )

  test('invalid js8c+bsvauth+smf URI with out-of-range latitude', () => {
    const uri = 'js8c+bsvauth+smf:?lat=100&long=130&freq=7&radius=1000'
    expect(isAdvertisableURI(uri)).toBe(false)
  })

  test('rejects ambiguous JS8 coordinates and parameter sets', () => {
    expect(isAdvertisableURI('js8c+bsvauth+smf:?lat=40junk&long=130&freq=7&radius=1000')).toBe(
      false
    )
    expect(isAdvertisableURI('js8c+bsvauth+smf:?lat=40&lat=41&long=130&freq=7&radius=1000')).toBe(
      false
    )
    expect(isAdvertisableURI('js8c+bsvauth+smf:?lat=40&long=130&freq=7&radius=1000&extra=1')).toBe(
      false
    )
    expect(isAdvertisableURI('js8c+bsvauth+smf:garbage?lat=40&long=130&freq=7&radius=1000')).toBe(
      false
    )
  })

  // Unknown scheme should return false.
  test('unknown scheme returns false', () => {
    expect(isAdvertisableURI('ftp://example.com')).toBe(false)
    expect(isAdvertisableURI('mailto:user@example.com')).toBe(false)
  })
})
