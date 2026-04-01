import { PrivateKey } from '@bsv/sdk'
import { buildPairingUri, parsePairingUri } from '../src/shared/pairingUri.js'
import { PROTOCOL_ID } from '../src/types.js'

// A valid compressed secp256k1 public key (deterministic for tests)
const BACKEND_KEY = PrivateKey.fromRandom().toPublicKey().toString()

const VALID_BUILD_PARAMS = {
  sessionId: 'session-abc-123',
  backendIdentityKey: BACKEND_KEY,
  protocolID: JSON.stringify(PROTOCOL_ID),
  origin: 'https://app.example.com',
}

describe('buildPairingUri / parsePairingUri roundtrip', () => {
  it('builds a wallet:// URI and parses it back to the original params', () => {
    const uri = buildPairingUri(VALID_BUILD_PARAMS)
    const result = parsePairingUri(uri)

    expect(result.error).toBeNull()
    expect(result.params).not.toBeNull()

    const p = result.params!
    expect(p.topic).toBe('session-abc-123')
    expect(p.keyID).toBe('session-abc-123')  // keyID must equal topic
    expect(p.backendIdentityKey).toBe(BACKEND_KEY)
    expect(p.origin).toBe('https://app.example.com')
    expect(JSON.parse(p.protocolID)).toEqual(PROTOCOL_ID)
  })

  it('relay URL is not embedded in the URI', () => {
    const uri = buildPairingUri(VALID_BUILD_PARAMS)
    expect(uri).not.toContain('relay=')
  })

  it('expiry is in the future for a freshly built URI', () => {
    const uri = buildPairingUri(VALID_BUILD_PARAMS)
    const result = parsePairingUri(uri)
    expect(result.error).toBeNull()
    expect(Number(result.params!.expiry)).toBeGreaterThan(Date.now() / 1000)
  })

  it('respects custom pairingTtlMs', () => {
    const tenMinutes = 10 * 60 * 1000
    const uri = buildPairingUri({ ...VALID_BUILD_PARAMS, pairingTtlMs: tenMinutes })
    const result = parsePairingUri(uri)
    expect(result.error).toBeNull()
    // expiry should be roughly 10 min from now (allow ±5 s for test execution)
    const expiryMs = Number(result.params!.expiry) * 1000
    expect(expiryMs).toBeGreaterThan(Date.now() + tenMinutes - 5_000)
    expect(expiryMs).toBeLessThan(Date.now() + tenMinutes + 5_000)
  })
})

describe('parsePairingUri validation', () => {
  it('rejects a non-wallet:// scheme', () => {
    const result = parsePairingUri('https://example.com/pair?foo=bar')
    expect(result.error).toBeTruthy()
    expect(result.params).toBeNull()
  })

  it('rejects a URI with missing required fields', () => {
    // Missing backendIdentityKey
    const uri = 'wallet://pair?topic=abc&origin=https://app.example.com'
    const result = parsePairingUri(uri)
    expect(result.error).toBeTruthy()
  })

  it('rejects an expired QR code', () => {
    const p = new URLSearchParams({
      topic: 'x',
      backendIdentityKey: BACKEND_KEY,
      protocolID: JSON.stringify(PROTOCOL_ID),
      keyID: 'x',
      origin: 'https://app.example.com',
      expiry: String(Math.floor(Date.now() / 1000) - 60),  // 60 s in the past
    })
    const result = parsePairingUri(`wallet://pair?${p}`)
    expect(result.error).toMatch(/expired/i)
  })

  it('rejects a malformed backendIdentityKey', () => {
    const p = new URLSearchParams({
      topic: 'x',
      backendIdentityKey: 'not-a-pubkey',
      protocolID: JSON.stringify(PROTOCOL_ID),
      keyID: 'x',
      origin: 'https://app.example.com',
      expiry: String(Math.floor(Date.now() / 1000) + 120),
    })
    const result = parsePairingUri(`wallet://pair?${p}`)
    expect(result.error).toMatch(/public key/i)
  })

  it('rejects keyID that does not match topic', () => {
    const p = new URLSearchParams({
      topic: 'session-1',
      backendIdentityKey: BACKEND_KEY,
      protocolID: JSON.stringify(PROTOCOL_ID),
      keyID: 'session-2',  // mismatch
      origin: 'https://app.example.com',
      expiry: String(Math.floor(Date.now() / 1000) + 120),
    })
    const result = parsePairingUri(`wallet://pair?${p}`)
    expect(result.error).toMatch(/keyID/i)
  })

  it('rejects an origin that is not http:// or https://', () => {
    const p = new URLSearchParams({
      topic: 'x',
      backendIdentityKey: BACKEND_KEY,
      protocolID: JSON.stringify(PROTOCOL_ID),
      keyID: 'x',
      origin: 'ftp://app.example.com',
      expiry: String(Math.floor(Date.now() / 1000) + 120),
    })
    const result = parsePairingUri(`wallet://pair?${p}`)
    expect(result.error).toMatch(/origin/i)
  })
})
