import { beforeEach, jest } from '@jest/globals'
import { BigNumber, Curve, Signature } from '@bsv/sdk/primitives'
import {
  BRC52_LIMITS,
  BRC52_DISABLED_OUTPOINT,
  decodeBRC52Base64,
  exportBRC52Envelope,
  exportBRC52StructuredCertificate,
  parseBRC52Envelope,
  verifyBRC52CertificateBinary,
  verifyBRC52Envelope
} from '../src/brc52/envelope.js'
import type { BRC52CertificateCore } from '../src/brc52/types.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'

// Public test scalars only. These certificates have no live issuer, subject or outpoint.
const ciphertext = Buffer.alloc(48).toString('base64')
let binary: number[]
let source: ReturnType<typeof verifyBRC52CertificateBinary>
let envelope: ReturnType<typeof exportBRC52Envelope>
let core: BRC52CertificateCore

// Production-dependent setup belongs to a test lifecycle hook: a broken parser
// must fail the tests that require a valid source, rather than abort module loading.
beforeEach(() => {
  binary = createSyntheticBRC52Binary([['name', ciphertext]])
  source = verifyBRC52CertificateBinary(binary)
  envelope = exportBRC52Envelope(binary)
  core = {
    type: source.type,
    serialNumber: source.serialNumber,
    subject: source.subject,
    certifier: source.certifier,
    revocationOutpoint: source.revocationOutpoint,
    fields: { name: ciphertext },
    signature: source.signature
  }
})

function rejectedEnvelope(value: unknown, expected: string): void {
  const result = verifyBRC52Envelope('application/json', JSON.stringify(value))
  expect(result).toEqual({
    verified: false,
    verifiedDocument: null,
    mediaType: null,
    errors: [expected]
  })
}

function withSignature(signature: number[]): number[] {
  return [...source.unsignedPrefix, ...signature]
}

describe('BRC-203 strict envelope boundaries with offline synthetic signed bytes', () => {
  test('decodes canonical Base64 at exact minimum/maximum lengths without rewriting', () => {
    for (const size of [0, 1, 2, 3, 48, 80]) {
      const bytes = Buffer.alloc(size, 255)
      expect(decodeBRC52Base64(bytes.toString('base64'), size, size)).toEqual([...bytes])
    }
    expect(() => decodeBRC52Base64('AAAA', 2)).toThrow(
      'Invalid canonical BRC-52 Base64 length or spelling'
    )
    expect(() => decodeBRC52Base64('AAAA', 4, 4)).toThrow(
      'Invalid canonical BRC-52 Base64 length or spelling'
    )
  })

  test.each([null, 1, {}, [], true, 'A', 'AAAA\n', '\nAAAA', 'AAAA====', 'AB==', 'AAB='])(
    'reports malformed Base64 input %j',
    value => {
      expect(() => decodeBRC52Base64(value, 3)).toThrow(TypeError)
      expect(() => decodeBRC52Base64(value, 3)).toThrow(
        new TypeError(
          value === 'AB==' || value === 'AAB='
            ? 'Invalid canonical BRC-52 Base64 length or spelling'
            : 'Invalid canonical BRC-52 Base64'
        )
      )
    }
  )

  test('enforces the textual Base64 budget before decoding oversized input', () => {
    expect(() => decodeBRC52Base64('AAAAAAAA', 3)).toThrow(/^Invalid canonical BRC-52 Base64$/)
  })

  test.each([0, 252, 253, 65_535, 65_536, 0xffff_ffff])(
    'preserves canonical CompactSize output index %i',
    outputIndex => {
      const outpoint = `${'a'.repeat(64)}.${outputIndex}`
      const raw = createSyntheticBRC52Binary([], outpoint)
      const parsed = verifyBRC52CertificateBinary(raw)
      expect(parsed.revocationOutpoint).toBe(outpoint)
      expect(parsed.unsignedPrefix).toEqual(raw.slice(0, parsed.unsignedPrefix.length))
      expect(parseBRC52Envelope(JSON.stringify(exportBRC52Envelope(raw))).source).toEqual(parsed)
    }
  )

  test.each([
    [253, 252, 0],
    [254, 255, 255, 0, 0],
    [255, 255, 255, 255, 255, 0, 0, 0, 0],
    [255, 0, 0, 0, 0, 1, 0, 0, 0]
  ])(
    'rejects nonminimal or out-of-u32 index %j before signature verification',
    (...encoding: number[]) => {
      const raw = [...binary.slice(0, 162), ...encoding, ...binary.slice(163)]
      expect(() => verifyBRC52CertificateBinary(raw)).toThrow(TypeError)
      expect(() => verifyBRC52CertificateBinary(raw)).toThrow(
        'Noncanonical or oversized BRC-52 CompactSize'
      )
    }
  )

  test('accepts all 256 fields and exactly 50 UTF-8 name bytes', () => {
    const names = Array.from({ length: 256 }, (_, index) => `field${index}`)
    names[0] = 'é'.repeat(25)
    const raw = createSyntheticBRC52Binary(names.map(name => [name, ciphertext]))
    const parsed = verifyBRC52CertificateBinary(raw)
    expect(Object.keys(parsed.fields)).toEqual(names)
    expect(
      Object.keys(parseBRC52Envelope(JSON.stringify(exportBRC52Envelope(raw))).source.fields)
    ).toHaveLength(256)
    expect(() =>
      verifyBRC52CertificateBinary(
        createSyntheticBRC52Binary([...names, 'extra'].map(name => [name, ciphertext]))
      )
    ).toThrow('Noncanonical or oversized BRC-52 CompactSize')
    expect(() =>
      verifyBRC52CertificateBinary(createSyntheticBRC52Binary([['é'.repeat(25) + 'x', ciphertext]]))
    ).toThrow('BRC-52 CompactSize exceeds limit')
  })

  test('rejects empty, duplicate and truncated field representations distinctly', () => {
    expect(() =>
      verifyBRC52CertificateBinary(createSyntheticBRC52Binary([['', ciphertext]]))
    ).toThrow('Empty BRC-52 field name')
    expect(() =>
      verifyBRC52CertificateBinary(
        createSyntheticBRC52Binary([
          ['name', ciphertext],
          ['name', ciphertext]
        ])
      )
    ).toThrow('Duplicate BRC-52 field name')
    const claimedLongName = [...binary]
    claimedLongName[164] = 50
    expect(() => verifyBRC52CertificateBinary(claimedLongName.slice(0, 170))).toThrow(
      'Truncated BRC-52 source'
    )
  })

  test('accepts the maximum ciphertext text length and rejects the next canonical size', () => {
    const maximum = 'A'.repeat(16_384)
    expect(
      verifyBRC52CertificateBinary(createSyntheticBRC52Binary([['name', maximum]])).fields
    ).toEqual({ name: maximum })
    expect(() =>
      verifyBRC52CertificateBinary(createSyntheticBRC52Binary([['name', maximum + 'AAAA']]))
    ).toThrow('Noncanonical or oversized BRC-52 CompactSize')
    expect(() =>
      verifyBRC52CertificateBinary(
        createSyntheticBRC52Binary([['name', Buffer.alloc(47).toString('base64')]])
      )
    ).toThrow('Invalid canonical BRC-52 Base64 length or spelling')
  })

  test('malformed field-name/value UTF-8 is not normalized into authenticated text', () => {
    const short = createSyntheticBRC52Binary([['x', ciphertext]])
    for (const offset of [165, 167]) {
      const changed = [...short]
      changed[offset] = 0xc0
      // Native TextDecoder errors can cross the Jest VM boundary; compare name/message.
      try {
        verifyBRC52CertificateBinary(changed)
        throw new Error('Malformed UTF-8 was accepted')
      } catch (error) {
        expect(error).toMatchObject({
          name: 'TypeError',
          message: expect.stringMatching(/UTF-8|utf-8/)
        })
      }
    }
  })

  test('rejects DER length and scalar-range errors before ECDSA verification', () => {
    for (const size of [0, 7, 73]) {
      expect(() => verifyBRC52CertificateBinary(withSignature(Array(size).fill(1)))).toThrow(
        'Invalid BRC-52 DER signature size'
      )
    }
    const order = new Curve().n
    for (const [r, s] of [
      [order, new BigNumber(1)],
      [new BigNumber(1), order]
    ]) {
      const der = new Signature(r, s).toDER() as number[]
      expect(() => verifyBRC52CertificateBinary(withSignature(der))).toThrow(
        'Invalid canonical BRC-52 DER signature'
      )
    }
    const signature = Signature.fromDER(Array.from(Buffer.from(source.signature, 'hex')))
    const highS = new Signature(signature.r, order.sub(signature.s)).toDER() as number[]
    expect(verifyBRC52CertificateBinary(withSignature(highS)).signature).toBe(
      Buffer.from(highS).toString('hex')
    )
    const redundantLength = [0x30, 0x81, highS[1], ...highS.slice(2)]
    expect(() => verifyBRC52CertificateBinary(withSignature(redundantLength))).toThrow(/DER/)
    expect(() => verifyBRC52CertificateBinary(withSignature([0x30, 6, 2, 1, 0, 2, 1, 1]))).toThrow(
      /R-value|DER/
    )
    expect(() => verifyBRC52CertificateBinary(withSignature([0x30, 6, 2, 1, 1, 2, 1, 0]))).toThrow(
      /S-value|DER/
    )
  })

  test('a well-formed but incorrect signature reports original signature failure', () => {
    const changed = [...binary]
    changed[0] ^= 1
    expect(() => verifyBRC52CertificateBinary(changed)).toThrow(
      'BRC-52 original signature verification failed'
    )
  })

  test('the disabled sentinel omits status and an ordinary outpoint preserves it', () => {
    expect(envelope.credential.revocationOutpoint).toBe(BRC52_DISABLED_OUTPOINT)
    expect(envelope.credential).not.toHaveProperty('credentialStatus')
    const outpoint = `${'c'.repeat(64)}.4`
    const ordinary = exportBRC52Envelope(createSyntheticBRC52Binary([], outpoint))
    expect(ordinary.credential.credentialStatus).toEqual({
      type: 'brc:BRC52OutpointStatus',
      revocationOutpoint: outpoint
    })
    rejectedEnvelope(
      { ...envelope, credential: { ...envelope.credential, credentialStatus: {} } },
      'BRC-52 credential projection mismatch'
    )
  })

  test.each(['profile', 'certificateBinary', 'credential'])('requires envelope member %s', name => {
    const value: Record<string, unknown> = { ...envelope }
    delete value[name]
    rejectedEnvelope(value, `Missing BRC-52 member ${name}`)
  })

  test('profile/media-type errors remain distinguishable and never return a document', () => {
    rejectedEnvelope(
      { ...envelope, profile: 'wrong-profile' },
      'Unsupported BRC-52 envelope profile'
    )
    expect(verifyBRC52Envelope('application/vc', JSON.stringify(envelope))).toEqual({
      verified: false,
      verifiedDocument: null,
      mediaType: null,
      errors: ['Unsupported BRC-52 input media type']
    })
  })

  test.each([
    { name: 'null', make: () => null },
    { name: 'number', make: () => 4 },
    { name: 'string', make: () => 'credential' },
    { name: 'array', make: () => [] },
    { name: 'empty object', make: () => ({}) },
    { name: 'object type', make: () => ({ ...envelope.credential, type: {} }) },
    {
      name: 'missing type',
      make: () => ({ ...envelope.credential, type: ['VerifiableCredential'] })
    },
    {
      name: 'additional type',
      make: () => ({ ...envelope.credential, type: [...envelope.credential.type, 'extra'] })
    },
    {
      name: 'null subject',
      make: () => ({ ...envelope.credential, credentialSubject: null })
    },
    {
      name: 'array fields',
      make: () => ({
        ...envelope.credential,
        credentialSubject: { ...envelope.credential.credentialSubject, encryptedFields: [] }
      })
    }
  ])('rejects alternate graph shape $name', ({ make }) => {
    rejectedEnvelope({ ...envelope, credential: make() }, 'BRC-52 credential projection mismatch')
  })

  test.each(['type', 'serialNumber', 'subject', 'certifier', 'revocationOutpoint', 'signature'])(
    'structured exporter requires string member %s',
    name => {
      expect(() =>
        exportBRC52StructuredCertificate({ ...core, [name]: 1 } as unknown as BRC52CertificateCore)
      ).toThrow(`Invalid BRC-52 ${name}`)
      const missing: Record<string, unknown> = { ...core }
      delete missing[name]
      expect(() =>
        exportBRC52StructuredCertificate(missing as unknown as BRC52CertificateCore)
      ).toThrow(`Missing BRC-52 member ${name}`)
    }
  )

  test.each([null, 1, 'fields', [], { name: 7 }, { name: ciphertext, extra: false }])(
    'structured exporter rejects non-string maps %j',
    fields => {
      expect(() =>
        exportBRC52StructuredCertificate({ ...core, fields } as unknown as BRC52CertificateCore)
      ).toThrow('Invalid BRC-52 structured fields')
    }
  )

  test('structured export rejects missing fields and preserves canonical empty maps', () => {
    const missing: Record<string, unknown> = { ...core }
    delete missing.fields
    expect(() =>
      exportBRC52StructuredCertificate(missing as unknown as BRC52CertificateCore)
    ).toThrow('Missing BRC-52 member fields')
    const empty = verifyBRC52CertificateBinary(createSyntheticBRC52Binary())
    const { certificateBinary: _binary, unsignedPrefix: _prefix, ...emptyCore } = empty
    expect(_binary.length).toBeGreaterThan(_prefix.length)
    expect(
      exportBRC52StructuredCertificate(emptyCore).credential.credentialSubject.encryptedFields
    ).toEqual({})
  })

  test('disclosure validates required members, recipient spelling and exact keyring frames', () => {
    const disclosure = {
      subject: source.subject,
      verifier: source.certifier,
      keyring: { name: Buffer.alloc(80).toString('base64') }
    }
    const value = { ...envelope, disclosure }
    expect(parseBRC52Envelope(JSON.stringify(value)).envelope.disclosure).toEqual(disclosure)
    expect(
      parseBRC52Envelope(JSON.stringify({ ...value, disclosure: { ...disclosure, keyring: {} } }))
        .envelope.disclosure?.keyring
    ).toEqual({})
    for (const name of ['subject', 'verifier', 'keyring']) {
      const missing: Record<string, unknown> = { ...disclosure }
      delete missing[name]
      rejectedEnvelope({ ...envelope, disclosure: missing }, `Missing BRC-52 member ${name}`)
    }
    rejectedEnvelope(
      { ...value, disclosure: { ...disclosure, subject: source.certifier } },
      'BRC-52 disclosure subject or verifier mismatch'
    )
    rejectedEnvelope(
      { ...value, disclosure: { ...disclosure, verifier: 1 } },
      'BRC-52 disclosure subject or verifier mismatch'
    )
    rejectedEnvelope(
      { ...value, disclosure: { ...disclosure, verifier: source.certifier.toUpperCase() } },
      'Noncanonical BRC-52 disclosure verifier'
    )
    for (const size of [0, 79, 81]) {
      const keyring = { name: Buffer.alloc(size).toString('base64') }
      const result = verifyBRC52Envelope(
        'application/json',
        JSON.stringify({ ...value, disclosure: { ...disclosure, keyring } })
      )
      expect(result.verified).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/^Invalid canonical BRC-52 Base64/)
    }
  })

  test('finite byte and JSON budgets reject oversized input with a useful error', () => {
    expect(BRC52_LIMITS).toEqual({
      certificateBytes: 65_536,
      jsonBytes: 262_144,
      fields: 256,
      fieldValueBytes: 16_384,
      fieldNameBytes: 50
    })
    expect(() => parseBRC52Envelope(new Uint8Array(262_145))).toThrow('byte limit')
    expect(() => parseBRC52Envelope(' '.repeat(262_145))).toThrow('invalid length')
    expect(verifyBRC52Envelope('application/json', '')).toEqual({
      verified: false,
      verifiedDocument: null,
      mediaType: null,
      errors: ['BRC-52 envelope has an invalid length']
    })
  })
})

test('accepts an exact 65536-byte signed certificate and rejects one byte more', () => {
  const maximumValue = 'A'.repeat(16_384)
  let exact: number[] | undefined
  // DER length varies with integer sign padding. Four name lengths compensate without
  // rewriting a signature or depending on the signer's private implementation details.
  for (const valueLength of [16_120, 16_124, 16_128]) {
    for (let padding = 0; padding < 4; padding++) {
      const candidate = createSyntheticBRC52Binary([
        ['f0', maximumValue],
        ['f1', maximumValue],
        ['f2', maximumValue],
        ['f3' + 'x'.repeat(padding), 'A'.repeat(valueLength)]
      ])
      if (candidate.length === 65_536) {
        exact = candidate
        break
      }
    }
    if (exact !== undefined) break
  }
  expect(exact).toBeDefined()
  const bytes = exact as number[]
  const exported = exportBRC52Envelope(bytes)
  expect(parseBRC52Envelope(JSON.stringify(exported)).source.certificateBinary).toEqual(bytes)
  expect(() => verifyBRC52CertificateBinary([...bytes, 0])).toThrow('byte array')
})

test('accepts a canonical 72-byte high-S signature without changing its bytes', () => {
  const order = new Curve().n
  let complete: number[] | undefined
  let expectedSignature: number[] | undefined
  for (let index = 0; index < 16; index++) {
    const candidate = createSyntheticBRC52Binary([[`name${index}`, ciphertext]])
    const parsed = verifyBRC52CertificateBinary(candidate)
    const signature = Signature.fromDER(Array.from(Buffer.from(parsed.signature, 'hex')))
    const highS = new Signature(signature.r, order.sub(signature.s)).toDER() as number[]
    if (highS.length === 72) {
      complete = [...parsed.unsignedPrefix, ...highS]
      expectedSignature = highS
      break
    }
  }
  expect(complete).toBeDefined()
  const parsed = verifyBRC52CertificateBinary(complete as number[])
  expect(parsed.signature).toBe(Buffer.from(expectedSignature as number[]).toString('hex'))
  expect(parsed.certificateBinary).toEqual(complete)
})

test('unexpected non-Error verification failures still return an explicit diagnostic', () => {
  const parser = jest.spyOn(Signature, 'fromDER').mockImplementationOnce(() => {
    throw 'synthetic dependency failure'
  })
  try {
    expect(verifyBRC52Envelope('application/json', JSON.stringify(envelope))).toEqual({
      verified: false,
      verifiedDocument: null,
      mediaType: null,
      errors: ['BRC-52 verification failed']
    })
  } finally {
    parser.mockRestore()
  }
})

test('unknown transport/structured/disclosure members identify the failing boundary', () => {
  rejectedEnvelope(
    { ...envelope, unsigned: 'claim' },
    'BRC-52 envelope contains unknown property "unsigned"'
  )
  expect(() =>
    exportBRC52StructuredCertificate({ ...core, masterKeyring: {} } as BRC52CertificateCore)
  ).toThrow('BRC-52 structured core contains unknown property "masterKeyring"')
  const disclosure = { subject: source.subject, verifier: source.certifier, keyring: {} }
  rejectedEnvelope(
    { ...envelope, disclosure: { ...disclosure, masterKeyring: {} } },
    'BRC-52 disclosure contains unknown property "masterKeyring"'
  )
  rejectedEnvelope(
    { ...envelope, disclosure: { ...disclosure, keyring: { other: ciphertext } } },
    'BRC-52 verifier keyring contains unknown property "other"'
  )
})

test('matching numeric object keys cannot stand in for ordered profile arrays', () => {
  rejectedEnvelope(
    {
      ...envelope,
      credential: {
        ...envelope.credential,
        type: { 0: 'VerifiableCredential', 1: 'brc:BRC52EncryptedCertificate' }
      }
    },
    'BRC-52 credential projection mismatch'
  )
  rejectedEnvelope(
    {
      ...envelope,
      credential: {
        ...envelope.credential,
        '@context': { 0: envelope.credential['@context'][0], 1: envelope.credential['@context'][1] }
      }
    },
    'BRC-52 credential projection mismatch'
  )
  const numericFields = exportBRC52Envelope(
    createSyntheticBRC52Binary([
      ['0', ciphertext],
      ['1', ciphertext]
    ])
  )
  rejectedEnvelope(
    {
      ...numericFields,
      credential: {
        ...numericFields.credential,
        credentialSubject: {
          ...numericFields.credential.credentialSubject,
          encryptedFields: [ciphertext, ciphertext]
        }
      }
    },
    'BRC-52 credential projection mismatch'
  )
})
