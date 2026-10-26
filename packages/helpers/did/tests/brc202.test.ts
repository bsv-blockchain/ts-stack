import { jest } from '@jest/globals'
import { PublicKey } from '@bsv/sdk/primitives'
import { BsvDid, decodeDidKey, publicKeyFromDid, publicKeyToDidKey } from '../src/index.js'
import type { DidResolutionOptions } from '../src/types.js'
import { generateQrCode } from '../src/qr.js'

// BRC-202's fixed public test value. No wallet, key generation or network is used.
const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const MULTIBASE = 'zQ3shVc2UkAfJCdc1TR8E66J85h48P43r93q8jGPkPpjF9Ef9'
const DID = `did:key:${MULTIBASE}`
const METHOD = `${DID}#${MULTIBASE}`
const CONTEXT = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1']
const VERIFICATION_METHOD = {
  id: METHOD,
  type: 'Multikey',
  controller: DID,
  publicKeyMultibase: MULTIBASE
}
const DOCUMENT = {
  '@context': CONTEXT,
  id: DID,
  verificationMethod: [VERIFICATION_METHOD],
  authentication: [METHOD],
  assertionMethod: [METHOD],
  capabilityInvocation: [METHOD],
  capabilityDelegation: [METHOD]
}

function hexBytes(hex: string): number[] {
  return Array.from({ length: hex.length / 2 }, (_, index) =>
    parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  )
}

// Independent base58btc construction to avoid using the adapter to build rejection vectors.
function didForBytes(bytes: number[]): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = bytes.reduce((sum, byte) => (sum << 8n) + BigInt(byte), 0n)
  let encoded = ''
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded
    value /= 58n
  }
  let leadingZeroes = 0
  while (bytes[leadingZeroes] === 0) leadingZeroes += 1
  return `did:key:z${'1'.repeat(leadingZeroes)}${encoded}`
}

describe('proposed BRC-202 identity-key did:key profile', () => {
  test('requires complete DID grammar before reporting an unsupported method', () => {
    for (const did of [
      'prefixdid:example:key',
      'did:example:key/path',
      'did:example:key?query',
      'did:example:key#fragment',
      'did:example:key trailing',
      'did:example:pre%4tail',
      'did:example:pre%ZZtail',
      'did:example:%4',
      'did:example:%ZZ',
      'did:example:key%'
    ]) {
      expect(BsvDid.resolve(did)).toEqual({
        didResolutionMetadata: { error: 'invalidDid' },
        didDocument: null,
        didDocumentMetadata: {}
      })
      expect(BsvDid.resolveRepresentation(did)).toEqual({
        didResolutionMetadata: { error: 'invalidDid' },
        didDocumentStream: null,
        didDocumentMetadata: {}
      })
    }
    for (const did of [
      'did:example:pre%41tail',
      'did:example:%41',
      'did:example:pre%aFtail',
      'did:example:%aF'
    ]) {
      expect(BsvDid.resolve(did)).toEqual({
        didResolutionMetadata: { error: 'methodNotSupported' },
        didDocument: null,
        didDocumentMetadata: {}
      })
    }
  })

  test('returns complete malformed-input errors without coercion or downstream dereferencing', () => {
    const coerce = jest.fn(() => METHOD)
    const invalidInputs: unknown[] = [
      undefined,
      null,
      1,
      {},
      [],
      { toString: coerce },
      '',
      'x'.repeat(4097)
    ]
    const resolve = jest.spyOn(BsvDid, 'resolve')
    try {
      for (const input of invalidInputs) {
        expect(BsvDid.dereference(input as string)).toEqual({
          dereferencingMetadata: { error: 'invalidDidUrl' },
          contentStream: null,
          contentMetadata: {}
        })
      }
      expect(resolve).not.toHaveBeenCalled()
      expect(coerce).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
    }
    const invalidDids: unknown[] = [
      undefined,
      null,
      1,
      {},
      [],
      { toString: coerce },
      '',
      'x'.repeat(2049)
    ]
    for (const input of invalidDids) {
      expect(BsvDid.resolve(input as string)).toEqual({
        didResolutionMetadata: { error: 'invalidDid' },
        didDocument: null,
        didDocumentMetadata: {}
      })
    }
    expect(coerce).not.toHaveBeenCalled()
  })

  test('preserves QR defaults and explicit options for the identity DID convenience API', () => {
    const svg = BsvDid.generateQrCode(DID)
    expect(svg).toBe(generateQrCode(DID, 'did'))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('role="img"')
    const options = {
      output: 'data-url' as const,
      moduleSize: 2,
      margin: 1,
      darkColor: '#123456',
      lightColor: '#abcdef',
      errorCorrectionLevel: 'H' as const
    }
    const encoded = BsvDid.generateQrCode(DID, 'did', options)
    expect(encoded).toBe(generateQrCode(DID, 'did', options))
    expect(encoded.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(encoded)).toContain('fill="#123456"')
    expect(BsvDid.generateQrCode('{"synthetic":"public"}', 'vc')).toBe(
      generateQrCode('{"synthetic":"public"}', 'vc')
    )
  })

  test('matches the fixed public vector through each supported input and decoding role', () => {
    const bytes = hexBytes(KEY)
    expect(BsvDid.fromPublicKey(KEY)).toBe(DID)
    expect(publicKeyToDidKey(KEY.toUpperCase())).toBe(DID)
    expect(publicKeyToDidKey(bytes)).toBe(DID)
    expect(publicKeyToDidKey(new Uint8Array(bytes))).toBe(DID)
    expect(publicKeyToDidKey(PublicKey.fromDER(bytes))).toBe(DID)
    expect(decodeDidKey(DID)).toEqual({
      did: DID,
      multibaseValue: MULTIBASE,
      publicKeyBytes: bytes
    })
    expect(publicKeyFromDid(DID).toDER('hex')).toBe(KEY)
    expect(didForBytes([0xe7, 0x01, ...bytes])).toBe(DID)
  })

  test('rejects noncompressed, out-of-range, off-curve and non-byte identity inputs', () => {
    const invalidKeys = [
      '',
      KEY.slice(2),
      `04${KEY.slice(2)}`,
      `06${KEY.slice(2)}`,
      `00${KEY.slice(2)}`,
      `02${'0'.repeat(64)}`,
      '02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f',
      '02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30',
      `02${'f'.repeat(64)}`,
      ` ${KEY}`,
      `${KEY} `,
      `0x${KEY}`,
      `04${KEY.slice(2)}483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8`
    ]
    for (const key of invalidKeys) expect(() => publicKeyToDidKey(key)).toThrow()
    expect(() => publicKeyToDidKey([...hexBytes(KEY), 0])).toThrow()
    expect(() => publicKeyToDidKey([256, ...hexBytes(KEY).slice(1)])).toThrow()
    expect(() => publicKeyToDidKey(Array.from({ length: 33 }, () => -1))).toThrow()
  })

  test('requires exact DID grammar, codec, compressed point and canonical bytes', () => {
    const bytes = hexBytes(KEY)
    const malformed = [
      METHOD,
      `${DID}/path`,
      `${DID}?query`,
      `${DID}:extra`,
      `${DID}#`,
      ` ${DID}`,
      `${DID}\n`,
      DID.replace('did:', 'DID:'),
      DID.replace('key:', 'key%3A'),
      DID.replace(':z', ':u'),
      `${DID}=`,
      DID.replace(':z', ':z1'),
      didForBytes([0xe8, 0x01, ...bytes]),
      didForBytes([0xe7, 0x81, 0x00, ...bytes]),
      didForBytes([0xe7, 0x01, ...bytes.slice(1)]),
      didForBytes([0xe7, 0x01, ...bytes, 0]),
      didForBytes([0xe7, 0x01, 0x04, ...bytes.slice(1)]),
      didForBytes([
        0xe7,
        0x01,
        ...hexBytes('02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30')
      ]),
      didForBytes([0xe7, 0x01, ...hexBytes(`02${'0'.repeat(64)}`)])
    ]
    for (const did of malformed) {
      expect(() => decodeDidKey(did)).toThrow()
      expect(BsvDid.resolve(did)).toEqual({
        didResolutionMetadata: { error: 'invalidDid' },
        didDocument: null,
        didDocumentMetadata: {}
      })
    }
  })

  test('constructs exactly the specified graph and no inferred trust, service or history', () => {
    expect(BsvDid.toDidDocument(DID)).toEqual(DOCUMENT)
    expect(BsvDid.resolve(DID)).toEqual({
      didResolutionMetadata: {},
      didDocument: DOCUMENT,
      didDocumentMetadata: {}
    })
    const first = BsvDid.resolve(DID)
    first.didDocument!.authentication.push('mutated')
    expect(BsvDid.resolve(DID).didDocument).toEqual(DOCUMENT)
  })

  test('returns a separate UTF-8 JSON-LD stream and no stream for failures', () => {
    const representation = BsvDid.resolveRepresentation(DID, { accept: 'application/did+ld+json' })
    expect(representation.didResolutionMetadata).toEqual({ contentType: 'application/did+ld+json' })
    expect(representation.didDocumentMetadata).toEqual({})
    expect(representation.didDocumentStream).toEqual(
      new TextEncoder().encode(JSON.stringify(DOCUMENT))
    )
    expect(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(representation.didDocumentStream!)
      )
    ).toEqual(DOCUMENT)
    expect(BsvDid.resolveRepresentation('invalid').didDocumentStream).toBeNull()
    expect(BsvDid.resolveRepresentation(DID, { accept: 'application/did+json' })).toEqual({
      didResolutionMetadata: { error: 'representationNotSupported' },
      didDocumentStream: null,
      didDocumentMetadata: {}
    })
  })

  test('rejects options that attempt to substitute remote documents or metadata', () => {
    const options = {
      didDocument: { ...DOCUMENT, id: 'did:key:substitute' }
    } as unknown as DidResolutionOptions
    expect(BsvDid.resolve(DID, options).didDocument).toBeNull()
    expect(BsvDid.resolveRepresentation(DID, options).didDocumentStream).toBeNull()
    const getRemoteDocument = jest.fn()
    const accessorOptions = Object.defineProperty({}, 'accept', {
      get: getRemoteDocument,
      enumerable: true
    })
    expect(BsvDid.resolve(DID, accessorOptions).didDocument).toBeNull()
    expect(getRemoteDocument).not.toHaveBeenCalled()
  })

  test('dereferences only the exact verification method, without path or fragment fallback', () => {
    expect(BsvDid.dereference(METHOD)).toEqual({
      dereferencingMetadata: {},
      contentStream: VERIFICATION_METHOD,
      contentMetadata: {}
    })
    for (const didUrl of [
      DID,
      `${DID}#other`,
      `${DID}#`,
      `${METHOD}#extra`,
      `${DID}/path#${MULTIBASE}`,
      `${DID}?q#${MULTIBASE}`
    ]) {
      expect(BsvDid.dereference(didUrl)).toEqual({
        dereferencingMetadata: { error: 'notFound' },
        contentStream: null,
        contentMetadata: {}
      })
    }
    expect(BsvDid.dereference('invalid').dereferencingMetadata.error).toBe('invalidDidUrl')
    expect(BsvDid.dereference('x'.repeat(4_097)).contentStream).toBeNull()
  })

  test('reports unsupported methods and immutable operations explicitly', () => {
    for (const did of [
      'did:web:example.com',
      'did:bsv:identity',
      'did:example:a:b',
      'did:example::a'
    ]) {
      expect(BsvDid.resolve(did).didResolutionMetadata.error).toBe('methodNotSupported')
      expect(BsvDid.resolveRepresentation(did).didDocumentStream).toBeNull()
      expect(BsvDid.dereference(`${did}#key`).dereferencingMetadata.error).toBe(
        'methodNotSupported'
      )
    }
    for (const operation of [BsvDid.update, BsvDid.rotate, BsvDid.recover, BsvDid.deactivate]) {
      expect(operation()).toEqual({ supported: false, error: 'operationNotSupported' })
    }
    expect(BsvDid.fromPublicKey(`03${KEY.slice(2)}`)).not.toBe(DID)
    // Certificate revocation and compromise policy do not change deterministic resolution.
    expect(BsvDid.resolve(DID).didDocument).toEqual(DOCUMENT)
  })
})
