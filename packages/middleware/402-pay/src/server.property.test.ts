import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { HEADERS } from './constants.js'
import { PaymentResponse, send402 } from './server.js'

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

const identityKey = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'

function responseRecorder(): PaymentResponse & {
  statusCode?: number
  headers: Record<string, string>
  ended: boolean
} {
  const response = {
    statusCode: undefined as number | undefined,
    headers: {},
    ended: false,
    status(code: number) {
      response.statusCode = code
      return response
    },
    set(headers: Record<string, string>) {
      Object.assign(response.headers, headers)
      return response
    },
    end() {
      response.ended = true
    }
  }
  return response
}

describe('BRC-121 challenge boundary properties', () => {
  test('serializes every positive safe-integer price exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), sats => {
        const response = responseRecorder()
        send402(response, identityKey, sats)
        expect(response).toMatchObject({
          statusCode: 402,
          headers: {
            [HEADERS.SATS]: String(sats),
            [HEADERS.SERVER]: identityKey
          },
          ended: true
        })
      })
    )
  })

  test('rejects arbitrary non-positive or unsafe prices before mutating the response', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
          fc.constant(Number.MAX_SAFE_INTEGER + 1),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY)
        ),
        sats => {
          const response = responseRecorder()
          expect(() => send402(response, identityKey, sats)).toThrow(RangeError)
          expect(response).toMatchObject({ statusCode: undefined, headers: {}, ended: false })
        }
      )
    )
  })

  test('rejects arbitrary invalid identity material before issuing a challenge', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 65 }), candidate => {
        const response = responseRecorder()
        expect(() => send402(response, candidate, 1)).toThrow(TypeError)
        expect(response).toMatchObject({ statusCode: undefined, headers: {}, ended: false })
      })
    )
  })
})
