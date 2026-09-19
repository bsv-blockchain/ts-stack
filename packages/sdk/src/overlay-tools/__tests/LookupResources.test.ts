import {
  DEFAULT_LOOKUP_LIMITS,
  lookupAbortError,
  lookupLimits,
  normalizeLookupHost,
  withLookupAbort
} from '../LookupResources.js'

describe('lookupLimits', () => {
  it('accepts positive safe integers and rejects every other shape', () => {
    expect(lookupLimits(undefined).maxHosts).toBe(DEFAULT_LOOKUP_LIMITS.maxHosts)
    expect(lookupLimits({ maxHosts: 3 }).maxHosts).toBe(3)
    expect(() => lookupLimits({ maxHosts: 0 })).toThrow(RangeError)
    expect(() => lookupLimits({ maxHosts: -1 })).toThrow(
      /Lookup limit maxHosts must be a positive safe integer/
    )
    expect(() => lookupLimits({ hostConcurrency: 1.5 })).toThrow(RangeError)
    expect(() => lookupLimits({ maxTrackers: Number.NaN })).toThrow(RangeError)
    expect(() => lookupLimits({ maxOutputs: Infinity })).toThrow(RangeError)
    expect(() => lookupLimits({ maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError)
    expect(() => lookupLimits({ maxEvidenceBytes: '8' as unknown as number })).toThrow(RangeError)
  })
})

describe('normalizeLookupHost', () => {
  it('rejects non-strings, overlong values, credentials, and non-http URLs', () => {
    expect(normalizeLookupHost(undefined as unknown as string)).toBeNull()
    expect(normalizeLookupHost(`https://example.com/${'a'.repeat(2048)}`)).toBeNull()
    expect(normalizeLookupHost('ftp://example.com')).toBeNull()
    expect(normalizeLookupHost('https://user@example.com')).toBeNull()
    expect(normalizeLookupHost('https://user:pass@example.com')).toBeNull()
    expect(normalizeLookupHost('https://:secret@example.com')).toBeNull()
  })

  it('drops query and fragment unless parameters are explicitly allowed', () => {
    expect(normalizeLookupHost('https://example.com/?q=1')).toBeNull()
    expect(normalizeLookupHost('https://example.com/#frag')).toBeNull()
    expect(normalizeLookupHost('https://example.com/?q=1', true)).toBe('https://example.com/?q=1')
    expect(normalizeLookupHost('https://example.com/#frag', true)).toBe('https://example.com/#frag')
  })

  it('returns null for values that are not parseable as URLs', () => {
    expect(normalizeLookupHost('not a url')).toBeNull()
    expect(normalizeLookupHost('https://[')).toBeNull()
    expect(normalizeLookupHost('')).toBeNull()
  })
})

describe('withLookupAbort', () => {
  it('drops an already-aborted waiter and does not leak a rejecting transport', async () => {
    const controller = new AbortController()
    controller.abort()
    const rejected = Promise.reject(new Error('late transport'))

    await expect(withLookupAbort(Promise.resolve('ok'), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Lookup cancelled'
    })
    await expect(withLookupAbort(rejected, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(lookupAbortError().name).toBe('AbortError')
  })
})
