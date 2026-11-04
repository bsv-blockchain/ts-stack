import {
  buildPairingUri,
  parsePairingUri,
  verifyPairingSignature
} from '../src/shared/pairingUri.js'
import * as validation from '../src/shared/validation.js'

const BACKEND_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PROTOCOL_ID = '[0,"pairing"]'

function buildValidUri(overrides: Partial<Parameters<typeof buildPairingUri>[0]> = {}): string {
  return buildPairingUri({
    sessionId: 'session',
    backendIdentityKey: BACKEND_KEY,
    protocolID: PROTOCOL_ID,
    origin: 'https://wallet.example.org',
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    ...overrides
  })
}

function editValidUri(edit: (url: URL) => void): string {
  const url = new URL(buildValidUri())
  edit(url)
  return url.toString()
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('pairing URI route and field boundaries', () => {
  test('accepts both empty and slash forms of the exact pair route', () => {
    const emptyPath = buildValidUri()
    const slashPath = editValidUri(url => {
      url.pathname = '/'
    })

    expect(parsePairingUri(emptyPath).error).toBeNull()
    expect(parsePairingUri(slashPath).error).toBeNull()
  })

  test.each([
    ['username', (url: URL) => (url.username = 'user')],
    ['password', (url: URL) => (url.password = 'secret')],
    ['hostname', (url: URL) => (url.hostname = 'other')],
    ['port', (url: URL) => (url.port = '1234')],
    ['pathname', (url: URL) => (url.pathname = '/other')],
    ['fragment', (url: URL) => (url.hash = 'fragment')]
  ])('rejects a pairing route with a noncanonical %s', (_component, edit) => {
    expect(parsePairingUri(editValidUri(edit))).toEqual({
      params: null,
      error: 'QR code must use the exact wallet://pair route'
    })
  })

  test('rejects duplicate security fields with the stable error', () => {
    const uri = `${buildValidUri()}&sig=AA&sig=AA`
    expect(parsePairingUri(uri)).toEqual({
      params: null,
      error: 'QR code contains a missing or duplicate security field'
    })
  })

  test.each(['topic', 'backendIdentityKey', 'protocolID', 'origin', 'expiry'])(
    'rejects an empty %s field after structural parsing',
    field => {
      const uri = editValidUri(url => {
        url.searchParams.set(field, '')
      })
      expect(parsePairingUri(uri)).toEqual({
        params: null,
        error: 'QR code is missing required fields'
      })
    }
  )

  test('rejects a present but invalid topic with the stable error', () => {
    const uri = editValidUri(url => {
      url.searchParams.set('topic', 'not url safe')
    })
    expect(parsePairingUri(uri)).toEqual({
      params: null,
      error: 'QR code topic is not a bounded URL-safe identifier'
    })
  })

  test.each(['01', '-1', '1.5', '9007199254740992'])(
    'rejects noncanonical expiry %s with the stable error',
    expiry => {
      const uri = editValidUri(url => {
        url.searchParams.set('expiry', expiry)
      })
      expect(parsePairingUri(uri)).toEqual({
        params: null,
        error: 'QR code expiry is not a valid Unix timestamp'
      })
    }
  )

  test('accepts an expiry exactly equal to the current second', () => {
    const nowSeconds = 2_000_000_000
    jest.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000)
    expect(parsePairingUri(buildValidUri({ expiry: nowSeconds })).error).toBeNull()
  })

  test('returns the stable expired error for a past timestamp', () => {
    const uri = editValidUri(url => {
      url.searchParams.set('expiry', '1')
    })
    expect(parsePairingUri(uri)).toEqual({
      params: null,
      error: 'This QR code has expired — ask the desktop to generate a new one'
    })
  })

  test('preserves normal origin validation messages and contains non-Error failures', () => {
    const invalidOrigin = editValidUri(url => {
      url.searchParams.set('origin', 'http://wallet.example.org')
    })
    expect(parsePairingUri(invalidOrigin).error).toMatch(/HTTPS/)
    for (const origin of [
      'http://192.168.1.1.example.com',
      'http://192.168.1.20.nip.io:3000',
      'http://printer.local',
      'http://172.32.0.1',
      'http://100.64.0.1',
      'http://169.254.169.254',
      'http://[::ffff:192.168.1.1]',
      'http://[fe80::1]'
    ]) {
      const tricky = editValidUri(url => {
        url.searchParams.set('origin', origin)
      })
      expect(parsePairingUri(tricky).error).toBe(
        'origin must be HTTPS, except for loopback development'
      )
      expect(parsePairingUri(tricky, undefined, { allowLocalNetworkHttp: true }).error).toBe(
        'origin must be HTTPS, except for loopback or local-network development'
      )
    }
    const lan = editValidUri(url => {
      url.searchParams.set('origin', 'http://192.168.1.20:3000')
    })
    expect(parsePairingUri(lan).error).toBe('origin must be HTTPS, except for loopback development')
    expect(parsePairingUri(lan, undefined, { allowLocalNetworkHttp: true }).error).toBeNull()

    const uri = buildValidUri()
    jest.spyOn(validation, 'normalizeHttpOrigin').mockImplementationOnce(() => {
      throw 'synthetic origin failure'
    })
    expect(parsePairingUri(uri)).toEqual({ params: null, error: 'Origin URL is not valid' })
  })

  test('distinguishes malformed keys, JSON, and protocol tuples', () => {
    const malformedKey = editValidUri(url => {
      url.searchParams.set('backendIdentityKey', `02${'00'.repeat(32)}`)
    })
    expect(parsePairingUri(malformedKey).error).toBe(
      'Backend identity key is not a valid compressed public key'
    )

    const malformedJson = editValidUri(url => {
      url.searchParams.set('protocolID', '{')
    })
    expect(parsePairingUri(malformedJson).error).toBe('protocolID is not valid JSON')

    const malformedTuple = editValidUri(url => {
      url.searchParams.set('protocolID', '[]')
    })
    expect(parsePairingUri(malformedTuple).error).toBe(
      'protocolID must be the mobile wallet session protocol'
    )
  })

  test.each(['A', 'A'.repeat(108)])('rejects malformed or oversized signature %s', signature => {
    const uri = editValidUri(url => {
      url.searchParams.set('sig', signature)
    })
    expect(parsePairingUri(uri)).toEqual({
      params: null,
      error: 'QR code contains a malformed security field'
    })
  })

  test('contains top-level URL parser failures', () => {
    expect(parsePairingUri('%')).toEqual({ params: null, error: 'Could not read QR code' })
  })
})

describe('pairing URI builder and signature boundaries', () => {
  test.each(['', '1wallet', 'wallet_', 'a'.repeat(33)])(
    'rejects invalid pairing scheme %j with the stable error',
    schema => {
      expect(() => buildValidUri({ schema })).toThrow('Pairing URI scheme is invalid')
    }
  )

  test('accepts the maximum-length custom scheme', () => {
    const schema = `a${'b'.repeat(31)}`
    const uri = buildValidUri({ schema })
    expect(parsePairingUri(uri, new Set([`${schema}:`])).error).toBeNull()
  })

  test('returns false when signature verification input fails validation', async () => {
    await expect(
      verifyPairingSignature({
        topic: 'not url safe',
        backendIdentityKey: BACKEND_KEY,
        protocolID: PROTOCOL_ID,
        origin: 'https://wallet.example.org',
        expiry: String(Math.floor(Date.now() / 1000) + 86_400),
        sig: 'AA'
      })
    ).resolves.toBe(false)
  })
})
