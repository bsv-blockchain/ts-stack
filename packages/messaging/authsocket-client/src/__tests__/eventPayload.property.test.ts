import { Buffer } from 'node:buffer'
import fc from 'fast-check'

import { decodeAuthSocketEventPayload } from '../AuthSocketClient.js'
import { SocketClientTransport } from '../SocketClientTransport.js'

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

describe('AuthSocket client event payload boundary properties', () => {
  test.each([null, [], 0, 'text', {}, { eventName: 1 }])(
    'rejects the deterministic non-envelope value %p',
    value => {
      const payload = Array.from(Buffer.from(JSON.stringify(value), 'utf8'))
      expect(decodeAuthSocketEventPayload(payload)).toEqual({
        eventName: '_unknown',
        data: undefined
      })
    }
  )

  test('maps malformed JSON to the explicit unknown event', () => {
    expect(decodeAuthSocketEventPayload(Array.from(Buffer.from('{not-json')))).toEqual({
      eventName: '_unknown',
      data: undefined
    })
  })

  test('contains callback rejection for arbitrary server values', async () => {
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
        const transport = new SocketClientTransport(socket as never)
        await transport.onData(async () => await Promise.reject(new Error('rejected')))

        await expect(listener?.(remoteValue)).resolves.toBeUndefined()
        expect(socket.disconnect).toHaveBeenCalledTimes(1)
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
      fc.property(fc.string(), fc.jsonValue(), (eventName, data) => {
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
            data: undefined
          })
        }
      )
    )
  })
})
