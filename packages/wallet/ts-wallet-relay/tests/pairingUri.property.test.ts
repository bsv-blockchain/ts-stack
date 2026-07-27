import { PrivateKey } from '@bsv/sdk'
import fc from 'fast-check'

import { buildPairingUri, parsePairingUri } from '../src/shared/pairingUri.js'

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
const hostLabel = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}[a-z0-9]$|^[a-z]$/)
const origin = fc
  .array(hostLabel, { minLength: 1, maxLength: 4 })
  .map(labels => `https://${labels.join('.')}.org`)
const protocol = fc.tuple(
  fc.integer({ min: 0, max: 2 }),
  fc.string({ minLength: 1, maxLength: 80 })
)

describe('wallet pairing URI properties', () => {
  test('round-trips arbitrary encoded session fields through the canonical URI boundary', () => {
    fc.assert(
      fc.property(
        token,
        protocol,
        origin,
        fc.option(token, { nil: undefined }),
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

    const invalidKeyUri = buildPairingUri({
      sessionId: 'session',
      backendIdentityKey: `02${'00'.repeat(32)}`,
      protocolID: '[0,"pairing"]',
      origin: 'https://wallet.example.org',
      expiry: FUTURE_EXPIRY
    })
    expect(parsePairingUri(invalidKeyUri).params).toBeNull()

    for (const invalidOrigin of [
      'not a URL',
      'https://wallet.example.org/path',
      'https://wallet.example.org?query=value',
      'https://wallet.example.org#fragment',
      'https://user:password@wallet.example.org'
    ]) {
      const uri = buildPairingUri({
        sessionId: 'session',
        backendIdentityKey: BACKEND_KEY,
        protocolID: '[0,"pairing"]',
        origin: invalidOrigin,
        expiry: FUTURE_EXPIRY
      })
      expect(parsePairingUri(uri).params).toBeNull()
    }

    for (const invalidProtocol of ['not JSON', '{}']) {
      const uri = buildPairingUri({
        sessionId: 'session',
        backendIdentityKey: BACKEND_KEY,
        protocolID: invalidProtocol,
        origin: 'https://wallet.example.org',
        expiry: FUTURE_EXPIRY
      })
      expect(parsePairingUri(uri).params).toBeNull()
    }
  })
})
