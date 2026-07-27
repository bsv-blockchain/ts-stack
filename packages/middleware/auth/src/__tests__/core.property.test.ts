import fc from 'fast-check'

import {
  checkAuthSigData,
  normalizeBody,
  serializeAuthSigData,
  serializeSignablePayload
} from '../core.js'
import type { RequestBody } from '../types.js'

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

describe('authentication payload properties', () => {
  test('normalizes arbitrary typed-array slices without including adjacent bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.uint8Array({ maxLength: 32 }),
        fc.uint8Array({ maxLength: 32 }),
        (body, prefix, suffix) => {
          const backing = new Uint8Array(prefix.length + body.length + suffix.length)
          backing.set(prefix)
          backing.set(body, prefix.length)
          backing.set(suffix, prefix.length + body.length)
          const view = new Uint8Array(backing.buffer, prefix.length, body.length)

          expect(normalizeBody(view)).toEqual(Array.from(body))
          expect(
            normalizeBody(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
          ).toEqual(Array.from(body))
        }
      )
    )
  })

  test('binds arbitrary JSON bodies deterministically and distinguishes no body from an empty body', () => {
    fc.assert(
      fc.property(
        fc.record({
          action: fc.string({ maxLength: 80 }),
          identityKey: fc.string({ minLength: 1, maxLength: 80 }),
          expiresAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          nonce: fc.string({ minLength: 1, maxLength: 80 })
        }),
        fc.jsonValue(),
        (data, body) => {
          const expectedBody = Array.from(
            new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))
          )
          const requestBody = body as RequestBody
          expect(normalizeBody(requestBody)).toEqual(expectedBody)
          expect(serializeSignablePayload(data, requestBody)).toEqual(
            serializeSignablePayload(data, requestBody)
          )
          expect(serializeSignablePayload(data)).toEqual(serializeAuthSigData(data))
          expect(serializeSignablePayload(data, '')).not.toEqual(serializeSignablePayload(data))
        }
      )
    )
  })

  test('validates arbitrary well-formed freshness windows and is total for malformed shapes', () => {
    const now = 1_800_000_000_000
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ minLength: 1, maxLength: 80 }),
        fc.string({ minLength: 1, maxLength: 80 }),
        fc.integer({ min: 1, max: 60_000 }),
        (action, identityKey, nonce, offset) => {
          const data = { action, identityKey, nonce, expiresAt: now + offset }
          expect(checkAuthSigData(data, action, now, { windowMs: 60_000, clockSkewMs: 0 })).toEqual(
            { valid: true }
          )
          expect(checkAuthSigData(data, `${action}!`, now).valid).toBe(false)
        }
      )
    )

    fc.assert(
      fc.property(fc.anything(), value => {
        expect(() =>
          checkAuthSigData(value as never, 'expected-action', now, {
            windowMs: 60_000,
            clockSkewMs: 0
          })
        ).not.toThrow()
      })
    )
  })
})
