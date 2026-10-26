import fc from 'fast-check'

import { createPaymentMiddleware, InMemoryPaymentReplayStore } from '../index.js'

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

describe('payment replay-store properties', () => {
  test('reports the stable capacity error for invalid boundaries', () => {
    for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new InMemoryPaymentReplayStore(capacity)).toThrow(
        'Replay-store capacity must be a positive safe integer.'
      )
    }
  })

  test('accepts each arbitrary transaction ID exactly once up to its capacity', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 128 }), {
          minLength: 1,
          maxLength: 100
        }),
        transactionIds => {
          const store = new InMemoryPaymentReplayStore(transactionIds.length)
          for (const transactionId of transactionIds) {
            expect(store.claim(transactionId)).toBe(true)
            expect(store.claim(transactionId)).toBe(false)
          }
          let overflowId = 'overflow'
          while (transactionIds.includes(overflowId)) overflowId += '-next'
          expect(() => store.claim(overflowId)).toThrow('capacity')
        }
      )
    )
  })

  test('rejects every non-positive, fractional, or unsafe capacity', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
          fc
            .double({
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              noNaN: true,
              noDefaultInfinity: true
            })
            .filter(value => !Number.isSafeInteger(value)),
          fc.constant(Number.MAX_SAFE_INTEGER + 1)
        ),
        capacity => {
          expect(() => new InMemoryPaymentReplayStore(capacity)).toThrow(RangeError)
        }
      )
    )
  })

  test.each([
    [1, 400, 'ERR_MALFORMED_PAYMENT'],
    [Number.MAX_SAFE_INTEGER, 400, 'ERR_MALFORMED_PAYMENT'],
    [-1, 500, 'ERR_PAYMENT_INTERNAL'],
    [0.5, 500, 'ERR_PAYMENT_INTERNAL'],
    [Number.MAX_SAFE_INTEGER + 1, 500, 'ERR_PAYMENT_INTERNAL']
  ] as const)(
    'classifies request price %s before processing a payment header',
    async (requestPrice, expectedStatus, expectedCode) => {
      const response = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
          this.statusCode = code
          return this
        },
        json(body: unknown) {
          this.body = body
          return this
        }
      }
      const next = jest.fn()
      const wallet = { internalizeAction: jest.fn() }
      const middleware = createPaymentMiddleware({
        wallet: wallet as never,
        calculateRequestPrice: () => requestPrice
      }) as any

      await middleware(
        {
          auth: {
            identityKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
          },
          headers: { 'x-bsv-payment': ['malformed'] }
        },
        response,
        next
      )

      expect(response.statusCode).toBe(expectedStatus)
      expect(response.body).toMatchObject({ code: expectedCode })
      expect(wallet.internalizeAction).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    }
  )
})
