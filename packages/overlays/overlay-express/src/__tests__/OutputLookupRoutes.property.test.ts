import fc from 'fast-check'
import type { Request, Response } from 'express'
import {
  lookupHTTPError,
  lookupOrigins,
  lookupCORS,
  lookupPrivateHeaders,
  sendLookupHTTPError
} from '../OutputLookupHTTPPolicy.js'

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

describe('lookup HTTP authority and diagnostic properties', () => {
  it('returns only the classified public diagnostic under arbitrary private exception text', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'invalid',
          'unauthorized',
          'not-found',
          'conflict',
          'equivocation',
          'reset-required',
          'context-changed',
          'expired',
          'limited',
          'unsupported',
          'unavailable'
        ),
        fc.string({ maxLength: 200 }),
        fc.boolean(),
        (code, detail, retryable) => {
          const privateText = 'private-storage-path:' + detail
          const error = Object.assign(new Error(privateText), { code, retryable })
          const packet = lookupHTTPError(error)
          expect(packet).toEqual({
            version: 1,
            error: { code, message: 'Lookup request ' + code, retryable }
          })
          expect(JSON.stringify(packet)).not.toContain(privateText)
          expect(lookupHTTPError({ code, message: privateText, retryable })).toEqual({
            version: 1,
            error: { code: 'unavailable', message: 'Lookup request unavailable', retryable: true }
          })
        }
      )
    )
  })

  it('owns exact generated origin sets and rejects path-bearing or duplicate authorities', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 1000000 }), { minLength: 1, maxLength: 12 }),
        ids => {
          const configured = ids.map(id => 'https://tenant-' + id + '.example.test')
          const selected = lookupOrigins(configured)
          expect([...selected]).toEqual(configured)
          expect(() => lookupOrigins([...configured, configured[0]])).toThrow()
          expect(() => lookupOrigins([configured[0] + '/path'])).toThrow()
          configured[0] = 'https://changed.example.test'
          expect(selected.has(configured[0])).toBe(false)
        }
      )
    )
  })
})

describe('bounded HTTP policy edges', () => {
  it('never evaluates private getters and validates classifications and optional diagnostics', () => {
    for (const code of [undefined, 7, 'private-unrecognized']) {
      const error = Object.assign(new Error('secret'), { code, retryable: false })
      expect(lookupHTTPError(error)).toEqual({
        version: 1,
        error: {
          code: 'unavailable',
          message: 'Lookup request unavailable',
          retryable: true
        }
      })
    }
    const getter = jest.fn(() => {
      throw new Error('private getter')
    })
    const error = Object.defineProperties(new Error('secret'), {
      code: { get: getter },
      retryable: { get: getter },
      limit: { get: getter }
    })
    expect(lookupHTTPError(error).error.code).toBe('unavailable')
    expect(getter).not.toHaveBeenCalled()
    for (const retryable of [undefined, 'true', 1, false])
      expect(
        lookupHTTPError(Object.assign(new Error(), { code: 'invalid', retryable })).error.retryable
      ).toBe(false)
    const valid = { kind: 'group', minimumBytes: 1234, minimumObservations: 2 }
    expect(
      lookupHTTPError(Object.assign(new Error(), { code: 'limited', limit: valid })).error.limit
    ).toEqual(valid)
    for (const limit of [
      { kind: 'private' },
      { ...valid, minimumBytes: -1 },
      { ...valid, extra: 'secret' }
    ])
      expect(
        lookupHTTPError(Object.assign(new Error(), { code: 'limited', limit })).error.limit
      ).toBeUndefined()
    expect(
      lookupHTTPError(Object.assign(new Error(), { code: 'invalid', limit: valid })).error.limit
    ).toBeUndefined()
  })

  it('accepts exact origin bounds and rejects excess, non-array, and non-string input', () => {
    const exact = Array.from({ length: 256 }, (_, i) => `https://origin-${i}.example.test`)
    expect(lookupOrigins(exact).size).toBe(256)
    for (const input of [
      null,
      {},
      'https://example.test',
      [...exact, 'https://extra.example.test']
    ])
      expect(() => lookupOrigins(input as string[])).toThrow(
        'Lookup origins must be a bounded array'
      )
    const longest = 'https://' + 'a'.repeat(2040)
    expect(lookupOrigins([longest]).has(longest)).toBe(true)
    for (const input of [[7], [longest + 'a']])
      expect(() => lookupOrigins(input as string[])).toThrow('Invalid lookup origin')
    for (const origin of [
      'ftp://example.test',
      'https://example.test/',
      'https://EXAMPLE.test',
      'https://u:p@example.test'
    ])
      expect(() => lookupOrigins([origin])).toThrow(
        'Lookup origins must be unique canonical HTTP(S) origins'
      )
  })
})

function responseDouble() {
  const response = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn(),
    set: jest.fn(),
    end: jest.fn(),
    vary: jest.fn()
  }
  for (const method of [response.status, response.set, response.end, response.vary])
    method.mockReturnValue(response)
  return response
}

it('sends a bounded common error only before any response has started', () => {
  const response = responseDouble()
  sendLookupHTTPError(
    response as unknown as Response,
    Object.assign(new Error('private'), { code: 'conflict' })
  )
  expect(response.status).toHaveBeenCalledWith(409)
  expect(response.set).toHaveBeenCalledWith('content-type', 'application/json')
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
    version: 1,
    error: {
      code: 'conflict',
      message: 'Lookup request conflict',
      retryable: false
    }
  })
  for (const field of ['destroyed', 'writableEnded', 'headersSent'] as const) {
    const ended = responseDouble()
    ended[field] = true
    sendLookupHTTPError(ended as unknown as Response, new Error('late'))
    expect(ended.status).not.toHaveBeenCalled()
    expect(ended.end).not.toHaveBeenCalled()
  }
  lookupPrivateHeaders(response as unknown as Response)
  expect(response.set).toHaveBeenCalledWith({
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no'
  })
  expect(response.vary).toHaveBeenCalledWith(
    'Authorization, x-bsv-auth-identity-key, x-bsv-overlay-capability, x-bsv-overlay-profile, Origin'
  )
})

it('applies exact CORS authentication and selection headers and checks every requested header', () => {
  const origin = 'https://client.example.test',
    origins = new Set([origin])
  const auth = [
    'identity-key',
    'message-type',
    'nonce',
    'request-id',
    'requested-certificates',
    'signature',
    'version',
    'your-nonce'
  ].map(name => 'x-bsv-auth-' + name)
  const selection = ['x-bsv-overlay-capability', 'x-bsv-overlay-profile']
  const allowed = ['authorization', 'content-type', 'cache-control', ...auth, ...selection]
  const response = responseDouble()
  expect(
    lookupCORS(
      { method: 'POST', headers: { origin } } as Request,
      response as unknown as Response,
      origins
    )
  ).toBe(true)
  expect(response.set).toHaveBeenCalledWith({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': allowed.join(', '),
    'access-control-expose-headers': [...auth, ...selection].join(', ')
  })
  for (const [wanted, status] of [
    [undefined, 204],
    [allowed.map(x => ' ' + x.toUpperCase() + ' ').join(','), 204],
    ['content-type,not-allowed', 403],
    ['', 403],
    [['content-type'], 403]
  ] as const) {
    const res = responseDouble()
    expect(
      lookupCORS(
        {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-headers': wanted }
        } as unknown as Request,
        res as unknown as Response,
        origins
      )
    ).toBe(false)
    expect(res.status).toHaveBeenCalledWith(status)
    expect(res.end).toHaveBeenCalledTimes(1)
  }
  for (const badOrigin of ['https://other.example.test', ['https://client.example.test']]) {
    const res = responseDouble()
    expect(
      lookupCORS(
        { method: 'POST', headers: { origin: badOrigin } } as unknown as Request,
        res as unknown as Response,
        origins
      )
    ).toBe(false)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.set).not.toHaveBeenCalled()
  }
  const absent = responseDouble()
  expect(
    lookupCORS({ method: 'GET', headers: {} } as Request, absent as unknown as Response, origins)
  ).toBe(true)
  expect(absent.set).not.toHaveBeenCalled()
})
