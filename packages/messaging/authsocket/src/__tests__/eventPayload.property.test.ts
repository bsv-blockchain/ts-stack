import fc from 'fast-check'

import { decodeAuthSocketEventPayload } from '../AuthSocketServer.js'
import { encodeAuthSocketEventPayload, parseAuthSocketEventPayload } from '../eventPayload.js'
import { SocketServerTransport } from '../SocketServerTransport.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const reserved = new Set([
  '_unknown',
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener'
])
const safeEventName = fc.string({ minLength: 1, maxLength: 64 }).filter(value => {
  if (reserved.has(value)) return false
  return ![...value].some(character => {
    const code = character.codePointAt(0)!
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
  })
})
const safeJsonValue = fc
  .jsonValue()
  .filter(value => !/"(?:__proto__|constructor|prototype)"\s*:/u.test(JSON.stringify(value)))

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

describe('AuthSocket server event payload boundary properties', () => {
  test.each([null, [], 0, 'text', {}, { eventName: 1 }])(
    'rejects the deterministic non-envelope value %p',
    value => {
      const payload = Array.from(Buffer.from(JSON.stringify(value), 'utf8'))
      expect(decodeAuthSocketEventPayload(payload)).toEqual({
        eventName: '_unknown',
        data: null
      })
    }
  )

  test('maps malformed JSON to the explicit unknown event', () => {
    expect(decodeAuthSocketEventPayload(Array.from(Buffer.from('{not-json')))).toEqual({
      eventName: '_unknown',
      data: null
    })
  })

  test('strictly rejects invalid UTF-8, non-byte values, reserved names, and unsafe keys', () => {
    expect(() => parseAuthSocketEventPayload([0xc3, 0x28], 1024)).toThrow()
    expect(() => parseAuthSocketEventPayload([256], 1024)).toThrow('byte array')
    expect(() =>
      parseAuthSocketEventPayload(
        Array.from(Buffer.from(JSON.stringify({ eventName: 'disconnect', data: true }))),
        1024
      )
    ).toThrow('reserved')
    expect(() =>
      parseAuthSocketEventPayload(
        Array.from(Buffer.from('{"eventName":"safe","data":{"__proto__":true}}')),
        1024
      )
    ).toThrow('unsafe')
  })

  test('bounds outgoing bytes and rejects accessors before serialization', () => {
    expect(() => encodeAuthSocketEventPayload('event', 'x'.repeat(100), 32)).toThrow('byte limit')
    const data = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: jest.fn(() => 'value')
    })
    expect(() => encodeAuthSocketEventPayload('event', data, 1024)).toThrow('accessors')
    expect(Object.getOwnPropertyDescriptor(data, 'secret')?.get).not.toHaveBeenCalled()
  })

  test('rejects JSON-semantic mutation hooks and ambiguous values before serialization', () => {
    const toJSON = jest.fn(() => 'x'.repeat(10_000))
    const hooked = Object.defineProperty([1], 'toJSON', { value: toJSON })
    expect(() => encodeAuthSocketEventPayload('event', hooked, 1024)).toThrow('extra properties')
    expect(toJSON).not.toHaveBeenCalled()

    const inheritedToJSON = jest.fn(() => 'x'.repeat(10_000))
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: inheritedToJSON
    })
    try {
      expect(encodeAuthSocketEventPayload('event', { value: 1 }, 1024)).toEqual(
        Array.from(Buffer.from('{"eventName":"event","data":{"value":1}}'))
      )
      expect(inheritedToJSON).not.toHaveBeenCalled()
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON
    }

    const hidden = Object.defineProperty({}, 'hidden', { value: 'authority' })
    expect(() => encodeAuthSocketEventPayload('event', hidden, 1024)).toThrow('hidden properties')
    expect(() => encodeAuthSocketEventPayload('event', { nested: undefined }, 1024)).toThrow(
      'JSON values'
    )
    expect(() => encodeAuthSocketEventPayload('event', -0, 1024)).toThrow('unambiguous')

    const noData = encodeAuthSocketEventPayload('event', undefined, 1024)
    expect(parseAuthSocketEventPayload(noData, 1024)).toEqual({
      eventName: 'event',
      data: undefined
    })
  })

  test('contains callback rejection for arbitrary remote values', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async remoteValue => {
        let listener: ((value: unknown) => Promise<void>) | undefined
        const socket = {
          emit() {},
          disconnect: jest.fn(),
          on(_eventName: string, callback: (value: unknown) => Promise<void>) {
            listener = callback
          }
        }
        const transport = new SocketServerTransport(socket as never)
        await transport.onData(async () => await Promise.reject(new Error('rejected')))

        await expect(listener?.(remoteValue)).resolves.toBeUndefined()
        expect(socket.disconnect).toHaveBeenCalledWith(true)
      })
    )
  })

  test('is total for arbitrary wire bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), bytes => {
        const result = decodeAuthSocketEventPayload(Array.from(bytes))
        expect(typeof result.eventName).toBe('string')
      })
    )
  })

  test('round-trips arbitrary JSON event data', () => {
    fc.assert(
      fc.property(safeEventName, safeJsonValue, (eventName, data) => {
        const payload = Array.from(Buffer.from(JSON.stringify({ eventName, data }), 'utf8'))
        const canonicalData = JSON.parse(JSON.stringify(data))
        expect(decodeAuthSocketEventPayload(payload)).toEqual({ eventName, data: canonicalData })
      })
    )
  })

  test('maps arbitrary non-envelope JSON values to the unknown event', () => {
    fc.assert(
      fc.property(
        fc.jsonValue().filter(value => {
          return !(
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof (value as { eventName?: unknown }).eventName === 'string'
          )
        }),
        value => {
          const payload = Array.from(Buffer.from(JSON.stringify(value), 'utf8'))
          expect(decodeAuthSocketEventPayload(payload)).toEqual({
            eventName: '_unknown',
            data: null
          })
        }
      )
    )
  })
})
