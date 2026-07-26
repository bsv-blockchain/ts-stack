import {
  messageBoxEndpoint,
  normalizeMessageBoxHost,
  normalizeOverlayMessageBoxHost
} from '../host.js'

describe('Message Box host validation', () => {
  it.each([
    ['https://message.example.org/', 'https://message.example.org'],
    ['http://localhost:8080/api/', 'http://localhost:8080/api'],
    [' https://message.example.org/prefix/// ', 'https://message.example.org/prefix']
  ])('normalizes explicitly configured host %s', (input, expected) => {
    expect(normalizeMessageBoxHost(input)).toBe(expected)
  })

  it.each([
    'message.example.org',
    'file:///tmp/socket',
    'https://user:secret@message.example.org',
    'https://message.example.org?redirect=https://attacker.example',
    'https://message.example.org/#fragment',
    ''
  ])('rejects unsafe or ambiguous configured host %s', input => {
    expect(() => normalizeMessageBoxHost(input)).toThrow()
  })

  it('rejects a non-string host at the runtime boundary', () => {
    expect(() => normalizeMessageBoxHost(42 as unknown as string)).toThrow(TypeError)
  })

  it('preserves an operator-controlled route prefix when building endpoints', () => {
    expect(messageBoxEndpoint('https://message.example.org/api/', '/sendMessage')).toBe(
      'https://message.example.org/api/sendMessage'
    )
  })

  it.each([
    'http://message.example.org',
    'https://localhost:8080',
    'https://service.local',
    'https://service.lan',
    'https://service.home',
    'https://service.test',
    'https://service.invalid',
    'https://0.0.0.0',
    'https://127.0.0.1',
    'https://10.0.0.4',
    'https://100.64.0.1',
    'https://169.254.1.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://198.18.0.1',
    'https://198.19.0.1',
    'https://[::1]',
    'https://[::]',
    'https://[fc00::1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://service.internal',
    'https://message.example.com'
  ])('rejects unsafe overlay destination %s', input => {
    expect(normalizeOverlayMessageBoxHost(input)).toBeUndefined()
  })

  it('rejects malformed overlay advertisements without throwing', () => {
    expect(normalizeOverlayMessageBoxHost('not a URL')).toBeUndefined()
  })

  it('accepts and canonicalizes a public HTTPS overlay destination', () => {
    expect(normalizeOverlayMessageBoxHost('https://message.example.org/api/')).toBe(
      'https://message.example.org/api'
    )
  })

  it('rejects an empty endpoint path', () => {
    expect(() => messageBoxEndpoint('https://message.example.org', '///')).toThrow(TypeError)
  })
})
