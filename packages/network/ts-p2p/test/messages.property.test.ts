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
  metadata: fc.dictionary(
    fc
      .stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,19}$/u)
      .filter(key => !['constructor', 'prototype'].includes(key)),
    fc.jsonValue(),
    { maxKeys: 12 }
  )
})
const safeSender = fc.stringMatching(/^[A-Za-z0-9 ._-]{1,100}$/u)

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
      fc.property(safeSender, payload, (sender, value) => {
        const canonical = JSON.parse(
          JSON.stringify(value, (key, child) =>
            ['__proto__', 'constructor', 'prototype'].includes(key)
              ? undefined
              : typeof child === 'number' &&
                  (Object.is(child, -0) ||
                    (Number.isInteger(child) && !Number.isSafeInteger(child)))
                ? null
                : child
          )
        )
        expect(decodeMessage(frame(sender, canonical))).toEqual({ sender, payload: canonical })
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
        safeSender,
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

  test('rejects oversized, deeply nested, and prototype-sensitive wire data', () => {
    expect(() => decodeMessage(new Uint8Array(1024 * 1024 + 1))).toThrow(
      'Message envelope exceeds its byte limit'
    )
    const compact = frame('sender', {})
    const exactLimit = new Uint8Array(1024 * 1024)
    exactLimit.fill(0x20)
    exactLimit.set(compact)
    expect(decodeMessage(exactLimit)).toEqual({ sender: 'sender', payload: {} })
    expect(() => decodeMessage(envelopeFrame('sender', 'A'.repeat(1_048_580)))).toThrow(
      'Message envelope exceeds its byte limit'
    )
    let nested: Record<string, unknown> = {}
    for (let index = 0; index < 34; index++) nested = { child: nested }
    expect(() => decodeMessage(frame('sender', nested))).toThrow('too deeply nested')
    const unsafePayload = JSON.parse('{"__proto__":{"admin":true}}') as object
    expect(() => decodeMessage(frame('sender', unsafePayload))).toThrow(
      'message payload contains an unsafe property'
    )
    const unsafeEnvelope = encoder.encode(
      '{"name":"sender","data":"e30=","__proto__":{"admin":true}}'
    )
    expect(() => decodeMessage(unsafeEnvelope)).toThrow(
      'message envelope contains an unsafe property'
    )
    expect(() => decodeMessage(frame('sender\u202e', {}))).toThrow('Invalid message sender')
  })

  test('enforces exact sender and inner-encoding boundaries', () => {
    const atSenderLimit = 'a'.repeat(256)
    expect(decodeMessage(frame(atSenderLimit, {}))).toEqual({ sender: atSenderLimit, payload: {} })
    for (const sender of ['', 'a'.repeat(257)]) {
      expect(() => decodeMessage(frame(sender, {}))).toThrow('Invalid message sender')
    }
    expect(() => decodeMessage(envelopeFrame('sender', ''))).toThrow(
      'Invalid canonical base64 payload'
    )

    class UnderreportedEnvelope extends Uint8Array {
      override get byteLength(): number {
        return 1
      }
    }
    const oversizedBase64 = 'A'.repeat(Math.ceil((768 * 1024) / 3) * 4 + 4)
    const oversizedEnvelope = new UnderreportedEnvelope(
      encoder.encode(JSON.stringify({ name: 'sender', data: oversizedBase64 }))
    )
    expect(() => decodeMessage(oversizedEnvelope)).toThrow('Invalid canonical base64 payload')
  })
})
