import { PrivateKey } from '@bsv/sdk'
import fc from 'fast-check'

import { buildPairingUri, parsePairingUri } from '../src/shared/pairingUri.js'
import { bytesToBase64url } from '../src/shared/encoding.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const BACKEND_KEY = new PrivateKey(1).toPublicKey().toString()
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 86_400
const token = fc.stringMatching(/^[A-Za-z0-9._~-]{1,80}$/)
const base64url = fc
  .uint8Array({ minLength: 1, maxLength: 60 })
  .map(bytes => bytesToBase64url(bytes))
const hostLabel = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,20}[a-z0-9]$|^[a-z]$/)
  .filter(label => !label.startsWith('xn--'))
const origin = fc
  .array(hostLabel, { minLength: 1, maxLength: 4 })
  .map(labels => `https://${labels.join('.')}.org`)
const octet = fc.integer({ min: 0, max: 255 })
const ipv4 = fc.tuple(
  fc.oneof(fc.constantFrom(9, 10, 11, 126, 127, 128, 172, 191, 192, 193), octet),
  fc.oneof(fc.constantFrom(15, 16, 31, 32, 167, 168, 169), octet),
  octet,
  octet
)

/** Reference classifier for the plain-HTTP IPv4 development ranges. */
function isPrivateOrLoopbackIpv4([a, b]: number[]): boolean {
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
const protocol = fc.tuple(
  fc.integer({ min: 0, max: 2 }),
  fc.stringMatching(/^[a-z][a-z0-9]{4,79}$/)
)

describe('wallet pairing URI properties', () => {
  test('round-trips arbitrary encoded session fields through the canonical URI boundary', () => {
    fc.assert(
      fc.property(
        token,
        protocol,
        origin,
        fc.option(base64url, { nil: undefined }),
        (sessionId, protocolID, appOrigin, sig) => {
          const encodedProtocol = JSON.stringify(protocolID)
          const uri = buildPairingUri({
            sessionId,
            backendIdentityKey: BACKEND_KEY,
            protocolID: encodedProtocol,
            origin: appOrigin,
            expiry: FUTURE_EXPIRY,
            sig
          })
          expect(parsePairingUri(uri)).toEqual({
            params: {
              topic: sessionId,
              backendIdentityKey: BACKEND_KEY,
              protocolID: encodedProtocol,
              origin: appOrigin,
              expiry: String(FUTURE_EXPIRY),
              ...(sig === undefined ? {} : { sig })
            },
            error: null
          })
        }
      )
    )
  })

  test('supports arbitrary valid custom schemes only when explicitly allowlisted', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9+.-]{0,20}$/), schema => {
        const uri = buildPairingUri({
          sessionId: 'session',
          backendIdentityKey: BACKEND_KEY,
          protocolID: '[0,"pairing"]',
          origin: 'https://wallet.example.org',
          expiry: FUTURE_EXPIRY,
          schema
        })
        expect(parsePairingUri(uri, new Set([`${schema}:`])).error).toBeNull()
        if (schema !== 'bsv-browser') expect(parsePairingUri(uri).params).toBeNull()
      })
    )
  })

  test('is total for arbitrary strings and rejects non-canonical expiry and public-key inputs', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), raw => {
        expect(() => parsePairingUri(raw)).not.toThrow()
      })
    )

    for (const expiry of ['NaN', 'Infinity', '1.5', '-1', '9007199254740992']) {
      const uri = buildPairingUri({
        sessionId: 'session',
        backendIdentityKey: BACKEND_KEY,
        protocolID: '[0,"pairing"]',
        origin: 'https://wallet.example.org',
        expiry: FUTURE_EXPIRY
      }).replace(`expiry=${FUTURE_EXPIRY}`, `expiry=${encodeURIComponent(expiry)}`)
      expect(parsePairingUri(uri).params).toBeNull()
    }

    const valid = buildPairingUri({
      sessionId: 'session',
      backendIdentityKey: BACKEND_KEY,
      protocolID: '[0,"pairing"]',
      origin: 'https://wallet.example.org',
      expiry: FUTURE_EXPIRY
    })
    const invalidKeyUrl = new URL(valid)
    invalidKeyUrl.searchParams.set('backendIdentityKey', `02${'00'.repeat(32)}`)
    const invalidKeyUri = invalidKeyUrl.toString()
    expect(parsePairingUri(invalidKeyUri).params).toBeNull()

    for (const invalidOrigin of [
      'not a URL',
      'https://wallet.example.org/path',
      'https://wallet.example.org?query=value',
      'https://wallet.example.org#fragment',
      'https://user:password@wallet.example.org'
    ]) {
      const url = new URL(valid)
      url.searchParams.set('origin', invalidOrigin)
      expect(parsePairingUri(url.toString()).params).toBeNull()
    }

    for (const invalidProtocol of ['not JSON', '{}']) {
      const url = new URL(valid)
      url.searchParams.set('protocolID', invalidProtocol)
      expect(parsePairingUri(url.toString()).params).toBeNull()
    }
  })

  test('accepts plain-HTTP IPv4 origins exactly for loopback, plus private ranges when opted in', () => {
    const valid = buildPairingUri({
      sessionId: 'session',
      backendIdentityKey: BACKEND_KEY,
      protocolID: '[0,"pairing"]',
      origin: 'https://wallet.example.org',
      expiry: FUTURE_EXPIRY
    })
    fc.assert(
      fc.property(ipv4, fc.boolean(), fc.boolean(), (address, asInteger, allowLocalNetworkHttp) => {
        const host = asInteger
          ? String(address.reduce((value, part) => value * 256 + part, 0))
          : address.join('.')
        const url = new URL(valid)
        url.searchParams.set('origin', `http://${host}:3000`)
        const accepted =
          parsePairingUri(url.toString(), undefined, { allowLocalNetworkHttp }).params !== null
        expect(accepted).toBe(
          address[0] === 127 || (allowLocalNetworkHttp && isPrivateOrLoopbackIpv4(address))
        )
      })
    )
  })

  test('rejects each missing field, ambiguous credentials, and malformed protocol tuples', () => {
    const valid = buildPairingUri({
      sessionId: 'session',
      backendIdentityKey: BACKEND_KEY,
      protocolID: '[0,"pairing"]',
      origin: 'https://wallet.example.org',
      expiry: FUTURE_EXPIRY
    })

    for (const field of ['topic', 'backendIdentityKey', 'protocolID', 'origin', 'expiry']) {
      const url = new URL(valid)
      url.searchParams.delete(field)
      expect(parsePairingUri(url.toString())).toEqual(
        expect.objectContaining({ params: null, error: expect.any(String) })
      )
    }

    for (const invalidOrigin of [
      'https://user@wallet.example.org',
      'https://:password@wallet.example.org'
    ]) {
      const url = new URL(valid)
      url.searchParams.set('origin', invalidOrigin)
      expect(parsePairingUri(url.toString()).params).toBeNull()
    }

    for (const invalidProtocol of ['[]', '[0]', '[0,"pairing",true]', '["0","pairing"]', '[0,1]']) {
      const url = new URL(valid)
      url.searchParams.set('protocolID', invalidProtocol)
      expect(parsePairingUri(url.toString()).params).toBeNull()
    }

    for (const invalidExpiry of [` ${FUTURE_EXPIRY}`, `${FUTURE_EXPIRY} `]) {
      const url = new URL(valid)
      url.searchParams.set('expiry', invalidExpiry)
      expect(parsePairingUri(url.toString()).params).toBeNull()
    }

    expect(parsePairingUri('bsv-browser://%').params).toBeNull()
  })
})
