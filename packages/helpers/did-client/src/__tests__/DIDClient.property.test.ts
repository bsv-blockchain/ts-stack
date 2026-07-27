import { Buffer } from 'node:buffer'

import { Utils } from '@bsv/sdk'
import fc from 'fast-check'

import { isCanonicalBase64, parseDIDDerivationInstructions } from '../index.js'

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

describe('DID derivation instruction properties', () => {
  it('accepts exactly non-empty canonical standard base64 strings', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 4096 }), fc.jsonValue()),
        value => {
          const expected =
            typeof value === 'string' &&
            value !== '' &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              value
            ) &&
            Buffer.from(value, 'base64').toString('base64') === value
          expect(isCanonicalBase64(value)).toBe(expected)
        }
      )
    )
  })

  it.each(['A', 'AAAAA', 'AB==', 'AAB=', '====', 'AA==='])(
    'rejects non-canonical base64 spelling %s',
    value => {
      expect(isCanonicalBase64(value)).toBe(false)
    }
  )

  it('round-trips canonical base64 derivation material', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 128 }),
        fc.uint8Array({ minLength: 1, maxLength: 128 }),
        (prefixBytes, suffixBytes) => {
          const derivationPrefix = Utils.toBase64(Array.from(prefixBytes))
          const derivationSuffix = Utils.toBase64(Array.from(suffixBytes))

          expect(
            parseDIDDerivationInstructions(
              JSON.stringify({ derivationPrefix, derivationSuffix })
            )
          ).toEqual({ derivationPrefix, derivationSuffix })
        }
      )
    )
  })

  it('is total for arbitrary untrusted instruction text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), encoded => {
        expect(() => parseDIDDerivationInstructions(encoded)).not.toThrow()
        const parsed = parseDIDDerivationInstructions(encoded)
        if (parsed !== undefined) {
          expect(Utils.toBase64(Utils.toArray(parsed.derivationPrefix, 'base64'))).toBe(
            parsed.derivationPrefix
          )
          expect(Utils.toBase64(Utils.toArray(parsed.derivationSuffix, 'base64'))).toBe(
            parsed.derivationSuffix
          )
        }
      })
    )
  })

  it('rejects JSON values without two canonical string fields', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.jsonValue(),
        (derivationPrefix, derivationSuffix) => {
          fc.pre(
            typeof derivationPrefix !== 'string' ||
              typeof derivationSuffix !== 'string' ||
              derivationPrefix === '' ||
              derivationSuffix === ''
          )
          expect(
            parseDIDDerivationInstructions(
              JSON.stringify({ derivationPrefix, derivationSuffix })
            )
          ).toBeUndefined()
        }
      )
    )
  })

  it('classifies arbitrary structured JSON by its two derivation fields', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const parsed = parseDIDDerivationInstructions(JSON.stringify(value))
        const expected =
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          isCanonicalBase64((value as Record<string, unknown>).derivationPrefix) &&
          isCanonicalBase64((value as Record<string, unknown>).derivationSuffix)
        expect(parsed !== undefined).toBe(expected)
      })
    )
  })
})
