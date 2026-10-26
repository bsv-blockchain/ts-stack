import fc from 'fast-check'

import {
  checkAuthSigData,
  createAuthSigData,
  normalizeBody,
  serializeAuthSigData,
  serializeSignablePayload,
  verifyAuthProof
} from '../core.js'
import type { AuthProof, AuthSigData, RequestBody } from '../types.js'
import * as PrimitiveUtils from '@bsv/sdk/primitives/utils'

const IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const NONCE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const NOW = 1_800_000_000_000

function authData(overrides: Partial<AuthSigData> = {}): AuthSigData {
  return {
    action: 'login',
    identityKey: IDENTITY_KEY,
    expiresAt: NOW + 60_000,
    nonce: NONCE,
    ...overrides
  }
}

function authProof(signature: number[] = [1, 2, 3]): AuthProof {
  return { data: authData(), signature }
}
const validAction = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))

function hasCanonicalJsonNumbers(value: unknown): boolean {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'number' && (!Number.isFinite(current) || Object.is(current, -0))) {
      return false
    }
    if (current !== null && typeof current === 'object') {
      pending.push(...Object.values(current))
    }
  }
  return true
}

const canonicalJsonValue = fc.jsonValue().filter(hasCanonicalJsonNumbers)

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
          action: validAction,
          identityKey: fc.constant(IDENTITY_KEY),
          expiresAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          nonce: fc.constant(NONCE)
        }),
        canonicalJsonValue,
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
      fc.property(validAction, fc.integer({ min: 1, max: 60_000 }), (action, offset) => {
        const data = {
          action,
          identityKey: IDENTITY_KEY,
          nonce: NONCE,
          expiresAt: now + offset
        }
        expect(checkAuthSigData(data, action, now, { windowMs: 60_000, clockSkewMs: 0 })).toEqual({
          valid: true
        })
        expect(checkAuthSigData(data, `${action}!`, now).valid).toBe(false)
      })
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

  test('enforces exact signature-array ownership and size boundaries', async () => {
    const wallet = { verifySignature: jest.fn(async () => ({ valid: true })) }
    const verify = async (proof: AuthProof): Promise<unknown> =>
      await verifyAuthProof({
        wallet: wallet as never,
        proof,
        action: 'login',
        now: NOW,
        consumeNonce: () => true
      })

    await expect(verify(authProof([]))).resolves.toEqual({ valid: false, error: 'Malformed proof' })
    await expect(verify(authProof(Array(1_025).fill(1)))).resolves.toEqual({
      valid: false,
      error: 'Malformed proof'
    })
    await expect(verify(authProof(Array(1_024).fill(255)))).resolves.toEqual({
      valid: true,
      identityKey: IDENTITY_KEY
    })

    const getter = jest.fn(() => 1)
    const accessorBytes = Object.defineProperty([1], 0, { get: getter }) as number[]
    await expect(verify(authProof(accessorBytes))).resolves.toEqual({
      valid: false,
      error: 'Malformed proof'
    })
    expect(getter).not.toHaveBeenCalled()

    const trappedBytes = new Proxy([1], {
      getOwnPropertyDescriptor(): never {
        throw new Error('descriptor trap')
      }
    })
    await expect(verify(authProof(trappedBytes))).resolves.toEqual({
      valid: false,
      error: 'Malformed proof'
    })
  })

  test('rejects anchored-key, curve, nonce-alphabet, and decoder failures independently', () => {
    for (const identityKey of [`x${IDENTITY_KEY}`, `${IDENTITY_KEY}x`, `02${'00'.repeat(32)}`]) {
      expect(checkAuthSigData(authData({ identityKey }), 'login', NOW)).toEqual({
        valid: false,
        error: 'Malformed proof'
      })
    }
    for (const nonce of [`!${NONCE}`, `${NONCE}!`, NONCE.slice(0, -1), `${NONCE}=`]) {
      expect(checkAuthSigData(authData({ nonce }), 'login', NOW)).toEqual({
        valid: false,
        error: 'Malformed proof'
      })
    }

    const originalToArray = PrimitiveUtils.toArray
    const decoder = jest.spyOn(PrimitiveUtils, 'toArray').mockImplementation((value, encoding) => {
      if (value === NONCE && encoding === 'base64') throw new TypeError('decoder failure')
      return originalToArray(value, encoding)
    })
    try {
      expect(checkAuthSigData(authData(), 'login', NOW)).toEqual({
        valid: false,
        error: 'Malformed proof'
      })
    } finally {
      decoder.mockRestore()
    }
  })

  test('accepts and rejects exact action, protocol, and timing boundaries', () => {
    for (const action of ['a'.repeat(256), 'é'.repeat(128)]) {
      expect(createAuthSigData(action, IDENTITY_KEY, { windowMs: 1, clockSkewMs: 0 }, 0)).toEqual(
        expect.objectContaining({ action, expiresAt: 1 })
      )
    }
    for (const action of ['a'.repeat(257), 'é'.repeat(129), 'login\u0000']) {
      expect(() => createAuthSigData(action, IDENTITY_KEY, undefined, 0)).toThrow(
        'canonical authentication fields'
      )
    }

    for (const protocolName of ['abcde', 'a'.repeat(400)]) {
      expect(() =>
        createAuthSigData('login', IDENTITY_KEY, { protocol: [2, protocolName] }, 0)
      ).not.toThrow()
    }
    for (const protocolName of [
      'abcd',
      'a'.repeat(401),
      ' abcde',
      'abcde ',
      'ab  cde',
      'abcde protocol',
      'abcde Protocol',
      '-abcde',
      'abcde-'
    ]) {
      expect(() =>
        createAuthSigData('login', IDENTITY_KEY, { protocol: [2, protocolName] }, 0)
      ).toThrow('valid wallet security level and protocol name')
    }

    const getter = jest.fn(() => 2)
    const accessorProtocol = Object.defineProperty([2, 'test auth'], 0, { get: getter })
    expect(() =>
      createAuthSigData('login', IDENTITY_KEY, { protocol: accessorProtocol as never }, 0)
    ).toThrow('valid wallet security level and protocol name')
    expect(getter).not.toHaveBeenCalled()

    expect(
      checkAuthSigData(authData({ expiresAt: 15 }), 'login', 0, {
        windowMs: 10,
        clockSkewMs: 5
      })
    ).toEqual({ valid: true })
    expect(
      checkAuthSigData(authData({ expiresAt: 16 }), 'login', 0, {
        windowMs: 10,
        clockSkewMs: 5
      })
    ).toEqual({ valid: false, error: 'Proof expiry too far in the future' })
  })

  test('accepts null-prototype proof data and rejects trapped proof containers', async () => {
    const data = Object.assign(Object.create(null) as AuthSigData, authData())
    const nullPrototypeProof = Object.assign(Object.create(null) as AuthProof, {
      data,
      signature: [1, 2, 3]
    })
    await expect(
      verifyAuthProof({
        wallet: { verifySignature: jest.fn(async () => ({ valid: true })) } as never,
        proof: nullPrototypeProof,
        action: 'login',
        now: NOW,
        consumeNonce: () => true
      })
    ).resolves.toEqual({ valid: true, identityKey: IDENTITY_KEY })

    const trappedProof = new Proxy(authProof(), {
      getPrototypeOf(): never {
        throw new Error('prototype trap')
      }
    })
    await expect(
      verifyAuthProof({
        wallet: { verifySignature: jest.fn() } as never,
        proof: trappedProof,
        action: 'login',
        now: NOW,
        consumeNonce: () => true
      })
    ).resolves.toEqual({ valid: false, error: 'Malformed proof' })
  })

  test('covers malformed signable data and exact body structural boundaries', () => {
    expect(() => serializeSignablePayload(null as never)).toThrow(
      'Authentication signature data must contain canonical own data fields'
    )

    const malformedPair = `${String.fromCharCode(0xd800)}A`
    const body = { value: malformedPair }
    expect(normalizeBody(body)).toEqual(Array.from(new TextEncoder().encode(JSON.stringify(body))))
    expect(normalizeBody('a', 1)).toEqual([97])
    expect(normalizeBody({}, 2)).toEqual([123, 125])

    let depthBoundary: unknown = 'leaf'
    for (let depth = 0; depth < 64; depth += 1) depthBoundary = { child: depthBoundary }
    expect(() => normalizeBody(depthBoundary as RequestBody)).not.toThrow()
  })

  test('enforces the pre-serialization byte budget across every UTF-8 width', () => {
    const originalToArray = PrimitiveUtils.toArray
    const encoder = jest.spyOn(PrimitiveUtils, 'toArray').mockImplementation((value, encoding) => {
      if (encoding === 'utf8' && typeof value === 'string' && value.startsWith('{"":')) return []
      return originalToArray(value, encoding)
    })
    const body = (value: unknown): RequestBody => Object.fromEntries([['', value]]) as RequestBody

    try {
      for (const [value, maximumBytes] of [
        ['\u007f', 1],
        ['\u0080', 2],
        ['\u07ff', 2],
        ['\u0800', 3],
        ['\ud800\udc00', 4],
        ['\ud800\udfff', 4],
        [`${String.fromCharCode(0xd800)}A`, 4]
      ] as const) {
        expect(normalizeBody(body(value), maximumBytes)).toEqual([])
      }

      for (const [value, maximumBytes] of [
        ['AA', 1],
        ['\u0080\u0080', 2],
        ['\u0800\u0800', 3],
        ['\ud800\udc00', 3],
        [`${String.fromCharCode(0xd800)}\u0080`, 4],
        [`${String.fromCharCode(0xd800)}\ue000`, 4],
        [`${String.fromCharCode(0xd800)}A`, 1]
      ] as const) {
        expect(() => normalizeBody(body(value), maximumBytes)).toThrow(
          'Authentication proof body exceeds maxBodyBytes'
        )
      }
    } finally {
      encoder.mockRestore()
    }
  })

  test('enforces the pre-serialization scalar and key byte budgets', () => {
    const originalToArray = PrimitiveUtils.toArray
    const encoder = jest.spyOn(PrimitiveUtils, 'toArray').mockImplementation((value, encoding) => {
      if (encoding === 'utf8' && typeof value === 'string' && value.startsWith('{')) return []
      return originalToArray(value, encoding)
    })

    try {
      const deferredCheck = (value: unknown, key = 'x'): RequestBody =>
        Object.fromEntries([
          [key, {}],
          ['', value]
        ]) as RequestBody

      expect(normalizeBody(deferredCheck(null), 5)).toEqual([])
      expect(normalizeBody(deferredCheck(1), 33)).toEqual([])
      expect(normalizeBody(deferredCheck(true), 6)).toEqual([])
      expect(() => normalizeBody(deferredCheck(null), 4)).toThrow('maxBodyBytes')
      expect(() => normalizeBody(deferredCheck(1), 32)).toThrow('maxBodyBytes')
      expect(() => normalizeBody(deferredCheck(true), 5)).toThrow('maxBodyBytes')
      expect(() => normalizeBody(deferredCheck(null, 'aa'), 5)).toThrow('maxBodyBytes')
    } finally {
      encoder.mockRestore()
    }
  })

  test('reports each option and local-time boundary precisely', () => {
    expect(() => createAuthSigData('login', IDENTITY_KEY, { windowMs: 0 }, 0)).toThrow(
      'windowMs must be a positive safe integer'
    )
    expect(() => createAuthSigData('login', IDENTITY_KEY, { clockSkewMs: -1 }, 0)).toThrow(
      'clockSkewMs must be a non-negative safe integer'
    )
    expect(() => createAuthSigData('login', IDENTITY_KEY, { maxBodyBytes: 0 }, 0)).toThrow(
      'maxBodyBytes must be a positive safe integer'
    )
    expect(() => createAuthSigData('login', IDENTITY_KEY, undefined, -1)).toThrow(
      'action, identityKey, and now must be canonical authentication fields'
    )
  })

  test('rejects empty wallet verdicts without consuming the nonce', async () => {
    const consumeNonce = jest.fn(() => true)
    await expect(
      verifyAuthProof({
        wallet: { verifySignature: jest.fn(async () => ({})) } as never,
        proof: authProof(),
        action: 'login',
        now: NOW,
        consumeNonce
      })
    ).resolves.toEqual({ valid: false, error: 'Invalid signature' })
    expect(consumeNonce).not.toHaveBeenCalled()
  })
})
