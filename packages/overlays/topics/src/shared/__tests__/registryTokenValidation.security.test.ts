import {
  registryObject,
  registryText,
  registryUrl,
  validateRegistryOperator,
  validateRegistryProtocol
} from '../registryTokenValidation.js'

const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('registryUrl', () => {
  it('accepts absolute public HTTPS URLs', () => {
    expect(registryUrl('https://example.com/resource', 'Resource')).toBe(
      'https://example.com/resource'
    )
  })

  it.each([
    '',
    '/relative',
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/resource#fragment',
    'https://localhost',
    'https://service.localhost',
    'https://service.local',
    'https://service.internal',
    'https://service.home.arpa',
    'https://0.0.0.1',
    'https://10.0.0.1',
    'https://127.0.0.1',
    'https://0x7f000001',
    'https://2130706433',
    'https://100.64.0.1',
    'https://169.254.169.254',
    'https://172.16.0.1',
    'https://192.0.0.1',
    'https://192.0.2.1',
    'https://192.88.99.1',
    'https://192.168.0.1',
    'https://198.18.0.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://[::]',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://[ff00::1]',
    'https://[2001:db8::1]',
    'https://[::ffff:192.0.2.1]'
  ])('rejects unsafe resource URL %p', value => {
    expect(() => registryUrl(value, 'Resource')).toThrow()
  })

  it.each(['https://192.0.0.9/resource', 'https://192.0.0.10/resource'])(
    'retains the explicitly globally reachable protocol address %p',
    value => {
      expect(registryUrl(value, 'Resource')).toBe(value)
    }
  )
})

describe('registry token primitive validation', () => {
  it('enforces UTF-8 byte limits and rejects unsafe control characters', () => {
    expect(registryText('é', 'Name', 2, 2)).toBe('é')
    expect(registryText('tab\tline\nreturn\r', 'Name')).toBe('tab\tline\nreturn\r')
    expect(() => registryText(1, 'Name')).toThrow('must be a string')
    expect(() => registryText('', 'Name', 1, 2)).toThrow('invalid UTF-8 length')
    expect(() => registryText('éé', 'Name', 1, 3)).toThrow('invalid UTF-8 length')
    for (const control of ['\u0000', '\u000b', '\u000e', '\u001f', '\u007f']) {
      expect(() => registryText(`name${control}`, 'Name')).toThrow('unsafe control characters')
    }
  })

  it('accepts data-only plain objects and rejects prototype or accessor behavior', () => {
    const nullPrototype = Object.assign(Object.create(null), { name: 'value' })
    expect(registryObject({ name: 'value' }, 'Metadata')).toEqual({ name: 'value' })
    expect(registryObject(nullPrototype, 'Metadata')).toBe(nullPrototype)

    class RegistryMetadata {}
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'value' })
    for (const value of [null, [], new RegistryMetadata(), accessor, { [Symbol('hidden')]: 1 }]) {
      expect(() => registryObject(value, 'Metadata')).toThrow(/plain object|unsafe property/)
    }
    expect(() => registryObject(JSON.parse('{"prototype":"pollute"}'), 'Metadata')).toThrow(
      'unsafe property'
    )
  })

  it('validates registry operators as exact compressed public keys', () => {
    expect(validateRegistryOperator(publicKey)).toBe(publicKey)
    expect(() => validateRegistryOperator('02deadbeef')).toThrow('invalid UTF-8 length')
    expect(() => validateRegistryOperator(`02${'11'.repeat(32)}`)).toThrow()
  })

  it.each([
    ['not JSON', /Unexpected token|JSON/],
    ['{}', 'Invalid wallet protocol format'],
    ['[1]', 'Invalid wallet protocol format'],
    ['[3,"wallet protocol"]', 'Invalid security level'],
    ['[1,5]', 'Invalid protocolID'],
    ['[1,"tiny"]', 'invalid UTF-8 length']
  ])('rejects malformed wallet protocol %p', (value, message) => {
    expect(() => validateRegistryProtocol(value)).toThrow(message)
  })

  it('accepts a bounded wallet protocol', () => {
    expect(validateRegistryProtocol('[2,"wallet protocol"]')).toEqual([2, 'wallet protocol'])
  })
})
