import {
  isAuthMethodType,
  isAuthPayload,
  isHexIdentifier,
  isPositiveSafeInteger,
  isRecord,
  isShamirShare,
  snapshotDemoRequestBody,
  snapshotRequestBody
} from '../security/requestValidation'

describe('request validation', () => {
  it('accepts only JSON records as request records and auth payloads', () => {
    expect(isRecord({})).toBe(true)
    expect(isAuthPayload({ phoneNumber: '+14155550100' })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isAuthPayload(null)).toBe(false)
  })

  it('bounds authentication method names and numeric IDs', () => {
    expect(isAuthMethodType('TwilioPhone')).toBe(true)
    expect(isAuthMethodType('../TwilioPhone')).toBe(false)
    expect(isAuthMethodType('a'.repeat(65))).toBe(false)
    expect(isPositiveSafeInteger(1)).toBe(true)
    expect(isPositiveSafeInteger(0)).toBe(false)
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  })

  it('requires exact 256-bit hexadecimal identifiers', () => {
    expect(isHexIdentifier('ab'.repeat(32))).toBe(true)
    expect(isHexIdentifier('ab'.repeat(31))).toBe(false)
    expect(isHexIdentifier(`${'ab'.repeat(31)}zz`)).toBe(false)
  })

  it('accepts only bounded, structurally valid Shamir shares', () => {
    expect(isShamirShare('2.3.2.deadbeef')).toBe(true)
    expect(isShamirShare('2.3.1.deadbeef')).toBe(false)
    expect(isShamirShare('0.3.2.deadbeef')).toBe(false)
    expect(isShamirShare('2.3.2.deadbeef.extra')).toBe(false)
    expect(isShamirShare('2.3.2.deadbeef'.padEnd(257, 'x'))).toBe(false)
    expect(isShamirShare('02.3.2.deadbeef')).toBe(false)
    expect(isShamirShare('2.3.02.deadbeef')).toBe(false)
    expect(isShamirShare('2.3.2.DEADBEEF')).toBe(false)
  })

  it('snapshots only own request data into prototype-free nested records', () => {
    const payload = { phoneNumber: '+14155550100' }
    const body = { methodType: 'TwilioPhone', payload }
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'presentationKey')
    let snapshot: Record<string, unknown> | undefined

    try {
      Object.defineProperty(Object.prototype, 'presentationKey', {
        value: 'ab'.repeat(32),
        enumerable: false,
        configurable: true,
        writable: true
      })
      snapshot = snapshotRequestBody(body)
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'presentationKey')
      else Object.defineProperty(Object.prototype, 'presentationKey', previous)
    }

    expect(snapshot).toBeDefined()
    expect(Object.getPrototypeOf(snapshot!)).toBeNull()
    expect(snapshot).not.toHaveProperty('presentationKey')
    expect(Object.getPrototypeOf(snapshot!.payload)).toBeNull()
    expect((snapshot!.payload as Record<string, unknown>).phoneNumber).toBe('+14155550100')

    payload.phoneNumber = '+14155550199'
    expect((snapshot!.payload as Record<string, unknown>).phoneNumber).toBe('+14155550100')
  })

  it('rejects request accessors without invoking them', () => {
    let reads = 0
    const body: Record<string, unknown> = {}
    Object.defineProperty(body, 'presentationKey', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1
        return 'ab'.repeat(32)
      }
    })

    expect(snapshotRequestBody(body)).toBeUndefined()
    expect(reads).toBe(0)

    const nested: Record<string, unknown> = {}
    Object.defineProperty(nested, 'phoneNumber', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1
        return '+14155550100'
      }
    })
    expect(snapshotRequestBody({ payload: nested })).toBeUndefined()
    expect(reads).toBe(0)
  })

  it('translates only an own demo method alias and never launders inherited or accessor data', () => {
    const translated = snapshotDemoRequestBody({ methodType: 'TwilioPhone' })
    expect(translated).toEqual({ methodType: 'DemoPhone' })
    expect(Object.getPrototypeOf(translated!)).toBeNull()

    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'methodType')
    let reads = 0
    try {
      Object.defineProperty(Object.prototype, 'methodType', {
        configurable: true,
        value: 'TwilioPhone'
      })
      const inherited = snapshotDemoRequestBody({})
      expect(inherited).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(inherited, 'methodType')).toBe(false)

      const accessor: Record<string, unknown> = {}
      Object.defineProperty(accessor, 'methodType', {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1
          return 'TwilioPhone'
        }
      })
      expect(snapshotDemoRequestBody(accessor)).toBeUndefined()
      expect(reads).toBe(0)
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'methodType')
      else Object.defineProperty(Object.prototype, 'methodType', previous)
    }
  })
})
