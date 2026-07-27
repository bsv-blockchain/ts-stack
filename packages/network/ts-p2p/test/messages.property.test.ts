import { describe, expect, test } from '@jest/globals'
import fc from 'fast-check'

import { decodeMessage, tryDecodeMessage } from '../src/messages.js'

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

const encoder = new TextEncoder()
const payload = fc.record({
  kind: fc.string({ maxLength: 40 }),
  values: fc.array(fc.jsonValue(), { maxLength: 20 }),
  metadata: fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue(), { maxKeys: 12 })
})

function frame(sender: string, value: unknown): Uint8Array {
  const data = Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  return encoder.encode(JSON.stringify({ name: sender, data }))
}

function envelopeFrame(name: unknown, data: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ name, data }))
}

describe('Teranode message decoder properties', () => {
  test('round-trips arbitrary nested payloads through independent UTF-8 and base64 encoders', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), payload, (sender, value) => {
        const canonical = JSON.parse(JSON.stringify(value))
        expect(decodeMessage(frame(sender, value))).toEqual({ sender, payload: canonical })
      })
    )
  })

  test('never throws from the tolerant decoder for arbitrary wire bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), bytes => {
        expect(() => tryDecodeMessage(bytes)).not.toThrow()
      })
    )
  })

  test('rejects malformed base64 and non-object topic payloads', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom('!', '-', '_', ' ', 'A', 'AAA===', 'Zh==', 'Zm9='),
        (sender, data) => {
          const malformed = envelopeFrame(sender, data)
          expect(() => decodeMessage(malformed)).toThrow('Invalid canonical base64 payload')
          expect(tryDecodeMessage(malformed)).toBeNull()
        }
      )
    )
    for (const data of ['AAAA!', '!AAAA', '=AAA', 'AAA=AAAA']) {
      expect(() => decodeMessage(envelopeFrame('sender', data))).toThrow(
        'Invalid canonical base64 payload'
      )
    }

    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        primitive => {
          expect(() => decodeMessage(frame('sender', primitive))).toThrow('Invalid message payload')
          expect(tryDecodeMessage(frame('sender', primitive))).toBeNull()
        }
      )
    )

    for (const envelope of [
      null,
      [],
      'message',
      1,
      {},
      { name: 1, data: 'e30=' },
      { name: 'sender', data: 1 }
    ]) {
      const malformed = encoder.encode(JSON.stringify(envelope))
      expect(() => decodeMessage(malformed)).toThrow('Invalid message envelope')
      expect(tryDecodeMessage(malformed)).toBeNull()
    }
    expect(() => decodeMessage(frame('sender', []))).toThrow('Invalid message payload')
    expect(tryDecodeMessage(frame('sender', []))).toBeNull()
  })
})
