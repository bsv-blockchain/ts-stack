import { readFileSync } from 'node:fs'
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  BRC52_ENVELOPE_PROFILE,
  decodeBRC52Base64,
  exportBRC52Envelope,
  exportBRC52StructuredCertificate,
  parseBRC52Envelope,
  verifyBRC52CertificateBinary,
  verifyBRC52Envelope
} from '../src/brc52/envelope.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'
import type { BRC52Envelope } from '../src/brc52/types.js'

const fixture = JSON.parse(
  readFileSync(`${process.cwd()}/tests/fixtures/brc203-envelope.json`, 'utf8')
) as BRC52Envelope
const binary = Array.from(Buffer.from(fixture.certificateBinary, 'base64'))
const copy = (): BRC52Envelope => JSON.parse(JSON.stringify(fixture)) as BRC52Envelope
const text = (): string => JSON.stringify(fixture)

// Published nonproduction BRC203 fixture. Independent OpenSSL key imported from
// its published BRC42-derived public key, without any signing/private material.
const derivedKey = createPublicKey({
  key: Buffer.from(
    '3036301006072a8648ce3d020106052b8104000a03220002818a006c82d870268dcd8539ff05323a20dcc164762b120e265d52882b616234',
    'hex'
  ),
  format: 'der',
  type: 'spki'
})

describe('BRC203 original signed BRC52 envelope', () => {
  test('retains historical field enumeration and signed BOM text without normalization', () => {
    const ciphertext = Buffer.alloc(48).toString('base64')
    const names = ['é', 'é', 'Z', '!', 'a', '\ufeffname']
    const raw = createSyntheticBRC52Binary(names.map(name => [name, ciphertext]))
    const source = verifyBRC52CertificateBinary(raw)
    expect(Object.keys(source.fields)).toEqual(names)
    expect(
      parseBRC52Envelope(JSON.stringify(exportBRC52Envelope(raw))).source.certificateBinary
    ).toEqual(raw)
    const { certificateBinary: _binary, unsignedPrefix: _prefix, ...core } = source
    expect(_binary).toEqual(raw)
    expect(_prefix.length).toBeLessThan(raw.length)
    expect(() => exportBRC52StructuredCertificate(core)).toThrow('signature')
    expect(() =>
      exportBRC52Envelope(createSyntheticBRC52Binary([['name', '\ufeff' + ciphertext]]))
    ).toThrow('Base64')
    expect(() => parseBRC52Envelope(new TextEncoder().encode('\ufeff' + text()))).toThrow()
  })

  test('bounds source and string transports consistently', () => {
    expect(() => exportBRC52Envelope(new Uint8Array(65537))).toThrow('limit')
    expect(() => parseBRC52Envelope(' '.repeat(262145))).toThrow('length')
  })

  test('exports the exact frozen vector and independently verifies original prefix', () => {
    const exported = exportBRC52Envelope(binary)
    const source = verifyBRC52CertificateBinary(binary)
    expect(exported).toEqual(fixture)
    expect(source.certificateBinary).toEqual(binary)
    expect(source.unsignedPrefix).toHaveLength(353)
    expect(createHash('sha256').update(Buffer.from(source.unsignedPrefix)).digest('hex')).toBe(
      '296e5e07d39301a5530b9ae2b0b14624ea4089ab20eaa860fe4a81fb22e5a624'
    )
    expect(
      verify(
        'sha256',
        Buffer.from(source.unsignedPrefix),
        derivedKey,
        Buffer.from(source.signature, 'hex')
      )
    ).toBe(true)
    expect(source.fields).toEqual(fixture.credential.credentialSubject.encryptedFields)
  })

  test('verification returns computed application/vc document without claims of reliance', () => {
    expect(verifyBRC52Envelope('application/json', text())).toEqual({
      verified: true,
      verifiedDocument: fixture.credential,
      mediaType: 'application/vc',
      errors: []
    })
    expect(parseBRC52Envelope(new TextEncoder().encode(text())).envelope).toEqual(fixture)
    expect(verifyBRC52Envelope('application/vc', text())).toMatchObject({
      verified: false,
      verifiedDocument: null,
      mediaType: null
    })
  })

  test('structured compatibility export succeeds only with the existing authentic signature', () => {
    const {
      certificateBinary: ignoredBinary,
      unsignedPrefix: ignoredPrefix,
      ...core
    } = verifyBRC52CertificateBinary(binary)
    expect(ignoredBinary).toHaveLength(424)
    expect(ignoredPrefix).toHaveLength(353)
    expect(exportBRC52StructuredCertificate(core)).toEqual(fixture)
    expect(() => exportBRC52StructuredCertificate({ ...core, subject: core.certifier })).toThrow(
      'signature'
    )
    expect(() =>
      exportBRC52StructuredCertificate({ ...core, cache: 'unsigned' } as typeof core)
    ).toThrow()
  })

  test('JSON member order and insignificant whitespace cannot replace signed bytes', () => {
    const value = copy()
    value.credential.credentialSubject.encryptedFields = {
      name: value.credential.credentialSubject.encryptedFields.name,
      email: value.credential.credentialSubject.encryptedFields.email
    }
    expect(parseBRC52Envelope(JSON.stringify(value, null, 2)).source.certificateBinary).toEqual(
      binary
    )
  })

  test.each([0, 32, 65, 98, 130, 168, 260, 352, 423])(
    'rejects source-byte tampering at %i',
    index => {
      const changed = [...binary]
      changed[index] ^= 1
      expect(() => exportBRC52Envelope(changed)).toThrow()
    }
  )

  test.each([0, 1, 64, 130, 352, 353, 423])('rejects truncated binary of length %i', length => {
    expect(() => verifyBRC52CertificateBinary(binary.slice(0, length))).toThrow()
  })

  test('rejects trailing signature data and nonminimal CompactSize spelling', () => {
    expect(() => verifyBRC52CertificateBinary([...binary, 0])).toThrow()
    expect(() =>
      verifyBRC52CertificateBinary([...binary.slice(0, 162), 253, 1, 0, ...binary.slice(163)])
    ).toThrow('CompactSize')
  })

  test.each([
    (value: BRC52Envelope) => {
      value.credential.issuer = value.credential.credentialSubject.id
    },
    (value: BRC52Envelope) => {
      value.credential.serialNumber = 'not-signed'
    },
    (value: BRC52Envelope) => {
      value.credential.credentialSubject.encryptedFields.name = 'Alice'
    },
    (value: BRC52Envelope) => {
      delete value.credential.credentialStatus
    },
    (value: BRC52Envelope) => {
      value.credential['@context'][1]['@protected'] = false as true
    },
    (value: BRC52Envelope) => {
      Object.assign(value.credential, { proof: { type: 'invented-wrapper' } })
    },
    (value: BRC52Envelope) => {
      Object.assign(value.credential, { validFrom: '2026-01-01T00:00:00Z' })
    }
  ])('rejects unsigned wrapper/graph claims', mutate => {
    const value = copy()
    mutate(value)
    expect(verifyBRC52Envelope('application/json', JSON.stringify(value)).verified).toBe(false)
  })

  test('rejects unknown envelope/profile and duplicate JSON members', () => {
    expect(() => parseBRC52Envelope(JSON.stringify({ ...fixture, proof: 'unsigned' }))).toThrow()
    expect(() => parseBRC52Envelope(JSON.stringify({ ...fixture, profile: 'other' }))).toThrow(
      'profile'
    )
    expect(() => parseBRC52Envelope(`{"profile":"other",${text().slice(1)}`)).toThrow('duplicate')
    expect(() => parseBRC52Envelope('{"__proto__":{},"profile":"x"}')).toThrow()
    expect(() => parseBRC52Envelope(Uint8Array.of(0xc0, 0x80))).toThrow()
  })

  test.each(['AA', 'AA=', 'AB==', 'AA==\n', '-_==', 'AAAA===='])(
    'rejects noncanonical Base64 %s',
    spelling => {
      expect(() => decodeBRC52Base64(spelling, 16)).toThrow()
    }
  )

  test('rejects invalid byte inputs and avoids caller-owned binary/graph aliases', () => {
    expect(() => exportBRC52Envelope([256])).toThrow()
    expect(() =>
      exportBRC52Envelope(
        Array.from({ length: 424 }, () => 0).map((value, index, array) => {
          if (index === 0) delete array[1]
          return value
        })
      )
    ).toThrow()
    const bytes = [...binary]
    const source = verifyBRC52CertificateBinary(bytes)
    bytes.fill(0)
    expect(source.certificateBinary).toEqual(binary)
    const exported = exportBRC52Envelope(binary)
    exported.credential.credentialSubject.encryptedFields.name = 'changed'
    expect(exportBRC52Envelope(binary)).toEqual(fixture)
  })

  test('only original field names and recipient-bound exact keyring frames are accepted', () => {
    const value = copy()
    const source = verifyBRC52CertificateBinary(binary)
    value.disclosure = {
      subject: source.subject,
      verifier: source.certifier,
      keyring: { name: Buffer.alloc(80, 1).toString('base64') }
    }
    expect(parseBRC52Envelope(JSON.stringify(value)).envelope.disclosure).toEqual(value.disclosure)
    value.disclosure.keyring.extra = Buffer.alloc(80, 1).toString('base64')
    expect(() => parseBRC52Envelope(JSON.stringify(value))).toThrow()
    expect(BRC52_ENVELOPE_PROFILE).toBe(fixture.profile)
  })
})
