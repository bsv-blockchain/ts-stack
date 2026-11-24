import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { asKeyPackageBytes } from '../../mls/key-package-codec.js'
import { SUPPORTED_CIPHERSUITES, type MlsCiphersuiteName } from '../../types.js'
import { decodeEnvelope, encodeEnvelope, EnvelopeError } from '../envelope.js'
import type { BootstrapMessage, Envelope } from '../types.js'

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

const MAX_OFFERED_CIPHERSUITES = 16
const MAX_CHAT_NAME_LENGTH = 256

/** What a consumer of a decoded envelope is entitled to believe, whoever sent it. */
const expectWireInvariants = (envelope: Envelope): void => {
  if (envelope.kind === 'mls') return
  const message = envelope.message
  expect(typeof message.requestId).toBe('string')
  expect(message.requestId.length).toBeGreaterThan(0)
  if (message.type === 'keyPackageRequest' || message.type === 'welcome') {
    if (message.chatName !== undefined) {
      expect(typeof message.chatName).toBe('string')
      expect(message.chatName.length).toBeLessThanOrEqual(MAX_CHAT_NAME_LENGTH)
    }
  }
  if (message.type === 'keyPackageRequest') {
    for (const suite of message.ciphersuites) {
      expect(SUPPORTED_CIPHERSUITES as readonly string[]).toContain(suite)
    }
  }
}

/** Every input a stranger can send decodes or throws `EnvelopeError` — nothing else. */
const decodeOrEnvelopeError = (bytes: Uint8Array): Envelope | undefined => {
  let decoded: Envelope
  try {
    decoded = decodeEnvelope(bytes)
  } catch (error) {
    expect(error).toBeInstanceOf(EnvelopeError)
    return undefined
  }
  expectWireInvariants(decoded)
  return decoded
}

const headerLengthOf = (encoded: Uint8Array): number =>
  new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(2, false)

/** A frame with an arbitrary header text, so the JSON value itself is hostile. */
const rawFrame = (kind: number, headerText: string, body: Uint8Array): Uint8Array => {
  const header = encoder.encode(headerText)
  const out = new Uint8Array(6 + header.length + body.length)
  out[0] = 1
  out[1] = kind
  new DataView(out.buffer).setUint32(2, header.length, false)
  out.set(header, 6)
  out.set(body, 6 + header.length)
  return out
}

const requestId = fc.string({ minLength: 1, maxLength: 64 })
const chatName = fc.option(fc.string({ maxLength: 256 }), { nil: undefined })
const bytes = fc.uint8Array({ maxLength: 512 })
const ciphersuites = fc.uniqueArray(
  fc.constantFrom<MlsCiphersuiteName>(...SUPPORTED_CIPHERSUITES),
  { minLength: 1, maxLength: SUPPORTED_CIPHERSUITES.length }
)

const withChatName = <T extends object>(message: T, name: string | undefined): T =>
  name === undefined ? message : { ...message, chatName: name }

const bootstrapMessage: fc.Arbitrary<BootstrapMessage> = fc.oneof(
  fc
    .record({ requestId, ciphersuites, chatName })
    .map(({ chatName: name, ...rest }) =>
      withChatName({ type: 'keyPackageRequest' as const, ...rest }, name)
    ),
  fc.record({ requestId, keyPackage: bytes }).map(({ requestId: id, keyPackage }) => ({
    type: 'keyPackageResponse' as const,
    requestId: id,
    keyPackage: asKeyPackageBytes(keyPackage)
  })),
  requestId.map(id => ({ type: 'keyPackageDecline' as const, requestId: id })),
  fc
    .record({ requestId, welcome: bytes, chatName })
    .map(({ chatName: name, ...rest }) => withChatName({ type: 'welcome' as const, ...rest }, name))
)

const envelope: fc.Arbitrary<Envelope> = fc.oneof(
  bootstrapMessage.map(message => ({ kind: 'bootstrap' as const, message })),
  bytes.map(payload => ({ kind: 'mls' as const, payload }))
)

describe('envelope wire format properties', () => {
  it('round-trips every well-formed envelope unchanged', () => {
    fc.assert(
      fc.property(envelope, value => {
        expect(decodeEnvelope(encodeEnvelope(value))).toEqual(value)
      })
    )
  })

  it('decodes arbitrary bytes or throws EnvelopeError', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1024 }), input => {
        decodeOrEnvelopeError(input)
      })
    )
  })

  it('decodes any JSON value as a bootstrap header or throws EnvelopeError', () => {
    fc.assert(
      fc.property(fc.jsonValue(), bytes, (header, body) => {
        decodeOrEnvelopeError(rawFrame(1, JSON.stringify(header), body))
      })
    )
  })

  it('decodes hostile bootstrap headers or throws EnvelopeError', () => {
    const hostileField = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.string({ maxLength: 300 }),
      fc.array(fc.oneof(fc.string(), fc.integer(), fc.constant(null)), { maxLength: 40 }),
      fc.jsonValue()
    )
    const type = fc.oneof(
      fc.constantFrom('keyPackageRequest', 'keyPackageResponse', 'keyPackageDecline', 'welcome'),
      fc.jsonValue()
    )
    fc.assert(
      fc.property(
        fc.record({
          type,
          requestId: hostileField,
          ciphersuites: hostileField,
          chatName: hostileField
        }),
        bytes,
        (header, body) => {
          decodeOrEnvelopeError(rawFrame(1, JSON.stringify(header), body))
        }
      )
    )
  })

  it('decodes mutated well-formed envelopes or throws EnvelopeError', () => {
    fc.assert(
      fc.property(
        envelope,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 8
        }),
        fc.nat(),
        (value, flips, cut) => {
          const encoded = encodeEnvelope(value)
          const mutated = encoded.slice()
          for (const [index, byte] of flips) mutated[index % mutated.length] = byte
          decodeOrEnvelopeError(mutated)
          decodeOrEnvelopeError(encoded.subarray(0, cut % (encoded.length + 1)))
        }
      )
    )
  })

  it('reports every cut inside the header as a truncated header', () => {
    fc.assert(
      fc.property(bootstrapMessage, fc.nat(), (message, cut) => {
        const encoded = encodeEnvelope({ kind: 'bootstrap', message })
        const end = cut % (6 + headerLengthOf(encoded))
        expect(() => decodeEnvelope(encoded.subarray(0, end))).toThrow(
          new EnvelopeError('Truncated envelope header')
        )
      })
    )
  })

  it('accepts an offer exactly when it is 1 to 16 strings, keeping only suites it has', () => {
    const entry = fc.oneof(
      fc.constantFrom<string>(...SUPPORTED_CIPHERSUITES),
      fc.string({ maxLength: 64 }),
      fc.integer(),
      fc.constant(null)
    )
    fc.assert(
      fc.property(fc.array(entry, { maxLength: MAX_OFFERED_CIPHERSUITES + 4 }), offered => {
        const decoded = decodeOrEnvelopeError(
          rawFrame(
            1,
            JSON.stringify({ type: 'keyPackageRequest', requestId: 'r', ciphersuites: offered }),
            new Uint8Array()
          )
        )
        const wellFormed =
          offered.length > 0 &&
          offered.length <= MAX_OFFERED_CIPHERSUITES &&
          offered.every(value => typeof value === 'string')
        expect(decoded !== undefined).toBe(wellFormed)
        if (decoded?.kind !== 'bootstrap' || decoded.message.type !== 'keyPackageRequest') return
        expect(decoded.message.ciphersuites).toEqual(
          offered.filter(name => (SUPPORTED_CIPHERSUITES as readonly unknown[]).includes(name))
        )
      })
    )
  })

  it('accepts a chat name exactly when it is a string of at most 256 characters', () => {
    const name = fc.oneof(
      fc.string({ minLength: MAX_CHAT_NAME_LENGTH - 2, maxLength: MAX_CHAT_NAME_LENGTH + 2 }),
      fc.string({ maxLength: 8 }),
      fc.integer(),
      fc.constant(null)
    )
    fc.assert(
      fc.property(fc.constantFrom('keyPackageRequest', 'welcome'), name, (type, chatName) => {
        const decoded = decodeOrEnvelopeError(
          rawFrame(
            1,
            JSON.stringify({ type, requestId: 'r', ciphersuites: ['x'], chatName }),
            new Uint8Array()
          )
        )
        const wellFormed = typeof chatName === 'string' && chatName.length <= MAX_CHAT_NAME_LENGTH
        expect(decoded !== undefined).toBe(wellFormed)
        if (decoded?.kind !== 'bootstrap') return
        const message = decoded.message
        if (message.type === 'keyPackageRequest' || message.type === 'welcome') {
          expect(message.chatName).toBe(chatName)
        }
      })
    )
  })

  it('accepts a request ID exactly when it is a non-empty string', () => {
    const id = fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.constant(null))
    fc.assert(
      fc.property(
        fc.constantFrom('keyPackageRequest', 'keyPackageResponse', 'keyPackageDecline', 'welcome'),
        id,
        (type, requestId) => {
          const decoded = decodeOrEnvelopeError(
            rawFrame(1, JSON.stringify({ type, requestId, ciphersuites: ['x'] }), new Uint8Array())
          )
          expect(decoded !== undefined).toBe(typeof requestId === 'string' && requestId.length > 0)
        }
      )
    )
  })

  it('names an unknown message type without stringifying what the sender chose', () => {
    const known = ['keyPackageRequest', 'keyPackageResponse', 'keyPackageDecline', 'welcome']
    fc.assert(
      fc.property(
        fc.jsonValue().filter(value => !known.includes(value as string)),
        type => {
          const described = typeof type === 'string' ? type : type === null ? 'null' : typeof type
          expect(() =>
            decodeEnvelope(rawFrame(1, JSON.stringify({ type }), new Uint8Array()))
          ).toThrow(new EnvelopeError(`Unknown bootstrap message type ${described}`))
        }
      )
    )
  })
})
