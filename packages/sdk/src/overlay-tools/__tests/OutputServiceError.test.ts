import {
  canonicalOutputJSON,
  OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES,
  outputServiceErrorHTTPStatus,
  parseOutputServiceError,
  type OutputServiceError
} from '../../../mod.js'

const packet = (code: OutputServiceError['error']['code'] = 'limited'): OutputServiceError => ({
  version: 1,
  error: { code, message: 'Configured limit reached', retryable: false }
})

describe('bounded common output service errors', () => {
  it.each([
    ['invalid', 400],
    ['unauthorized', 401],
    ['not-found', 404],
    ['conflict', 409],
    ['equivocation', 409],
    ['reset-required', 409],
    ['context-changed', 409],
    ['expired', 410],
    ['limited', 413],
    ['unsupported', 422],
    ['unavailable', 503]
  ] as const)(
    'preserves %s and maps it to HTTP %s without interpreting it as data',
    (code, status) => {
      const input = packet(code)
      const owned = parseOutputServiceError(canonicalOutputJSON(input))
      expect(owned).toEqual(input)
      expect(outputServiceErrorHTTPStatus(owned.error.code)).toBe(status)
      input.error.message = 'Changed'
      expect(owned.error.message).toBe('Configured limit reached')
    }
  )

  it('accepts all limited detail kinds and the exact hard boundaries independently of requested page size', () => {
    for (const kind of ['envelope', 'group', 'permanent-group'] as const) {
      const input: OutputServiceError = {
        version: 1,
        error: {
          ...packet().error,
          retryAfterMs: 4294967295,
          limit: { kind, minimumBytes: 4194304, minimumObservations: 1024 }
        }
      }
      expect(parseOutputServiceError(input)).toEqual(input)
      expect(
        parseOutputServiceError({
          version: 1,
          error: { ...packet().error, retryAfterMs: 0, limit: { kind } }
        }).error.limit
      ).toEqual({ kind })
    }
    const input = canonicalOutputJSON(packet())
    expect(
      parseOutputServiceError(input + ' '.repeat(OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES - input.length))
    ).toEqual(packet())
    expect(() =>
      parseOutputServiceError(
        input + ' '.repeat(OUTPUT_SERVICE_ERROR_MAXIMUM_BYTES - input.length + 1)
      )
    ).toThrow('limit')
  })

  it('rejects unknown/local codes, successful cursors, coercions and impossible minimums', () => {
    for (const code of ['cancelled', 'revision-unavailable', 'payment-required', 'unknown']) {
      expect(() =>
        parseOutputServiceError({ version: 1, error: { ...packet().error, code } })
      ).toThrow()
      expect(() =>
        outputServiceErrorHTTPStatus(code as OutputServiceError['error']['code'])
      ).toThrow('Unknown')
    }
    for (const value of [
      { ...packet(), cursor: 'success' },
      { version: 1, error: { ...packet().error, cursor: 'success' } },
      { version: 1, error: { ...packet().error, retryable: 'false' } },
      { version: 1, error: { ...packet().error, retryAfterMs: -1 } },
      { version: 1, error: { ...packet().error, retryAfterMs: 4294967296 } },
      { version: 1, error: { ...packet('unavailable').error, limit: { kind: 'group' } } },
      ...[0, 4194305].map(minimumBytes => ({
        version: 1,
        error: { ...packet().error, limit: { kind: 'group', minimumBytes } }
      })),
      ...[0, 1025].map(minimumObservations => ({
        version: 1,
        error: { ...packet().error, limit: { kind: 'group', minimumObservations } }
      }))
    ])
      expect(() => parseOutputServiceError(value)).toThrow()
  })
})
