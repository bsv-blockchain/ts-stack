import { describe, expect, it } from 'vitest'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { asKeyPackageBytes } from '../../mls/key-package-codec.js'
import { decodeEnvelope, encodeEnvelope, EnvelopeError } from '../envelope.js'

const encoder = new TextEncoder()

describe('bootstrap envelope', () => {
  it('round-trips a key package request', () => {
    const envelope = encodeEnvelope({
      kind: 'bootstrap',
      message: {
        type: 'keyPackageRequest',
        requestId: 'r1',
        ciphersuites: ['MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'],
        chatName: 'Project Alpha'
      }
    })
    expect(decodeEnvelope(envelope)).toEqual({
      kind: 'bootstrap',
      message: {
        type: 'keyPackageRequest',
        requestId: 'r1',
        ciphersuites: ['MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'],
        chatName: 'Project Alpha'
      }
    })
  })

  it('round-trips a response carrying binary KeyPackage bytes', () => {
    const keyPackage = asKeyPackageBytes(Uint8Array.from({ length: 300 }, (_, i) => i % 256))
    const decoded = decodeEnvelope(
      encodeEnvelope({
        kind: 'bootstrap',
        message: { type: 'keyPackageResponse', requestId: 'r1', keyPackage }
      })
    )
    if (decoded.kind !== 'bootstrap' || decoded.message.type !== 'keyPackageResponse') {
      throw new Error('wrong variant')
    }
    expect(decoded.message.keyPackage).toEqual(keyPackage)
  })

  it('round-trips a decline and a welcome', () => {
    const decline = decodeEnvelope(
      encodeEnvelope({ kind: 'bootstrap', message: { type: 'keyPackageDecline', requestId: 'r1' } })
    )
    expect(decline).toEqual({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })

    const welcome = decodeEnvelope(
      encodeEnvelope({
        kind: 'bootstrap',
        message: { type: 'welcome', requestId: 'r1', welcome: new Uint8Array([7, 8]) }
      })
    )
    if (welcome.kind !== 'bootstrap' || welcome.message.type !== 'welcome')
      throw new Error('wrong variant')
    expect(welcome.message.welcome).toEqual(new Uint8Array([7, 8]))
  })

  it('passes MLS payloads through untouched', () => {
    const payload = new Uint8Array([9, 9, 9])
    expect(decodeEnvelope(encodeEnvelope({ kind: 'mls', payload }))).toEqual({
      kind: 'mls',
      payload
    })
  })

  it('rejects an unknown envelope version', () => {
    const bytes = encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1]) })
    bytes[0] = 99
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeError)
  })

  it('rejects a truncated envelope', () => {
    const bytes = encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1, 2, 3]) })
    expect(() => decodeEnvelope(bytes.slice(0, 2))).toThrow(EnvelopeError)
  })

  it('rejects when headerLength claims more bytes than remain', () => {
    const bytes = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    const truncated = bytes.slice(0, bytes.length - 1)
    expect(() => decodeEnvelope(truncated)).toThrow(EnvelopeError)
  })

  it('rejects an unknown kind byte', () => {
    const bytes = encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1]) })
    bytes[1] = 9
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeError)
  })

  it('rejects an unrecognized bootstrap message type', () => {
    const bytes = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    const malformed = new Uint8Array(bytes)
    const view = new DataView(malformed.buffer, malformed.byteOffset, malformed.byteLength)
    const newHeader = encoder.encode(JSON.stringify({ type: 'unknownType', requestId: 'r1' }))
    view.setUint32(2, newHeader.length, false)
    const result = new Uint8Array(6 + newHeader.length)
    result.set(malformed.slice(0, 6))
    result.set(newHeader, 6)
    expect(() => decodeEnvelope(result)).toThrow(EnvelopeError)
  })

  it('rejects an invalid JSON header', () => {
    const bytes = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    bytes[7] = 0xff
    expect(() => decodeEnvelope(bytes)).toThrow(EnvelopeError)
  })

  it('rejects keyPackageRequest with missing requestId', () => {
    const bytes = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLength = view.getUint32(2, false)
    const headerBytes = bytes.slice(6, 6 + headerLength)
    const decoder = new TextDecoder()
    const header = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>
    header['type'] = 'keyPackageRequest'
    header['ciphersuites'] = ['MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519']
    delete header['requestId']
    const newHeader = new TextEncoder().encode(JSON.stringify(header))
    const result = new Uint8Array(6 + newHeader.length)
    const resultView = new DataView(result.buffer)
    resultView.setUint8(0, 1)
    resultView.setUint8(1, 1)
    resultView.setUint32(2, newHeader.length, false)
    result.set(newHeader, 6)
    expect(() => decodeEnvelope(result)).toThrow(EnvelopeError)
  })

  it('rejects keyPackageRequest with malformed ciphersuites', () => {
    const bytes = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const headerLength = view.getUint32(2, false)
    const headerBytes = bytes.slice(6, 6 + headerLength)
    const decoder = new TextDecoder()
    const header = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>
    header['type'] = 'keyPackageRequest'
    header['requestId'] = 'r1'
    header['ciphersuites'] = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
    const newHeader = new TextEncoder().encode(JSON.stringify(header))
    const result = new Uint8Array(6 + newHeader.length)
    const resultView = new DataView(result.buffer)
    resultView.setUint8(0, 1)
    resultView.setUint8(1, 1)
    resultView.setUint32(2, newHeader.length, false)
    result.set(newHeader, 6)
    expect(() => decodeEnvelope(result)).toThrow(EnvelopeError)
  })

  it('decodes a Uint8Array with non-zero byteOffset', () => {
    const envelope = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
    const padded = new Uint8Array(10 + envelope.length)
    padded.set(envelope, 10)
    const offsetArray = padded.subarray(10)
    const decoded = decodeEnvelope(offsetArray)
    expect(decoded).toEqual({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })
  })
})

describe('decodeEnvelope bounds the ciphersuites it vouches for', () => {
  const request = (ciphersuites: unknown): Uint8Array => {
    const header = new TextEncoder().encode(
      JSON.stringify({ type: 'keyPackageRequest', requestId: 'r1', ciphersuites })
    )
    const out = new Uint8Array(6 + header.length)
    const view = new DataView(out.buffer)
    out[0] = 1
    out[1] = 1
    view.setUint32(2, header.length, false)
    out.set(header, 6)
    return out
  }

  /**
   * The result is typed `MlsCiphersuiteName[]` and handed to consumers on
   * `inviteReceived`. A consumer doing the obvious thing passes element zero
   * straight to `keyPackages.create`, so an unchecked string is a lie in the
   * type rather than merely untidy data.
   */
  it('drops names that are not suites this library supports', () => {
    const envelope = decodeEnvelope(request(['not-a-suite', DEFAULT_CIPHERSUITE]))
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageRequest') {
      throw new Error('wrong envelope')
    }

    expect(envelope.message.ciphersuites).toEqual([DEFAULT_CIPHERSUITE])
  })

  /**
   * A well-formed request offering nothing we serve is not a malformed
   * envelope. Throwing here made it `PermanentProcessingError("Payload is not
   * a valid envelope")` and the peer was never told; refusing it as a
   * bootstrap message is both honest and answerable.
   */
  it('passes an offer of nothing we support through as an empty list', () => {
    const envelope = decodeEnvelope(request(['not-a-suite']))
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageRequest') {
      throw new Error('wrong envelope')
    }

    expect(envelope.message.ciphersuites).toEqual([])
  })

  /** Persisted verbatim on the invite row, so an unbounded array is storage. */
  it('refuses an absurdly long list rather than storing it', () => {
    expect(() =>
      decodeEnvelope(request(Array.from({ length: 5000 }, () => DEFAULT_CIPHERSUITE)))
    ).toThrow(EnvelopeError)
  })
})

describe('decodeEnvelope bounds the chat name it stores', () => {
  const request = (chatName: string): Uint8Array => {
    const header = new TextEncoder().encode(
      JSON.stringify({
        type: 'keyPackageRequest',
        requestId: 'r1',
        ciphersuites: [DEFAULT_CIPHERSUITE],
        chatName
      })
    )
    const out = new Uint8Array(6 + header.length)
    const view = new DataView(out.buffer)
    out[0] = 1
    out[1] = 1
    view.setUint32(2, header.length, false)
    out.set(header, 6)
    return out
  }

  /**
   * Same property the ciphersuite cap exists for: persisted verbatim on the
   * invite row, chosen by the sender, and here also rendered in a UI.
   */
  it('refuses a chat name past the cap rather than storing it', () => {
    expect(() => decodeEnvelope(request('x'.repeat(5000)))).toThrow(EnvelopeError)
  })

  it('accepts an ordinary one', () => {
    const envelope = decodeEnvelope(request('Project Alpha'))
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageRequest') {
      throw new Error('wrong envelope')
    }
    expect(envelope.message.chatName).toBe('Project Alpha')
  })
})
