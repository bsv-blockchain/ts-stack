import { jest } from '@jest/globals'
import { createPublicKey, verify } from 'node:crypto'
import fc from 'fast-check'
import {
  exportBRC52Envelope,
  parseBRC52Envelope,
  verifyBRC52CertificateBinary,
  verifyBRC52Envelope
} from '../src/brc52/envelope.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'

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
jest.setTimeout(60_000)

// Public nonproduction scalar-3 fixture's BRC-42-derived signing public key.
// OpenSSL independently checks signatures produced by the SDK test-only builder.
const signingPublicKey = createPublicKey({
  key: Buffer.from(
    '3036301006072a8648ce3d020106052b8104000a03220002818a006c82d870268dcd8539ff05323a20dcc164762b120e265d52882b616234',
    'hex'
  ),
  format: 'der',
  type: 'spki'
})
const subject = Buffer.from(
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  'hex'
)
const certifier = Buffer.from(
  '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
  'hex'
)
const zeroTxid = '0'.repeat(64)
const opaqueCiphertext = Buffer.alloc(48).toString('base64')
const nameArbitrary = fc
  .tuple(
    fc.constantFrom('', '\ufeff', 'é', 'e\u0301', '東京'),
    fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,7}$/)
  )
  .map(([prefix, name]) => `${prefix}${name}`)
const fieldsArbitrary = fc.uniqueArray(
  fc.tuple(
    nameArbitrary,
    fc
      .uint8Array({ minLength: 48, maxLength: 64 })
      .map(value => Buffer.from(value).toString('base64'))
  ),
  { minLength: 1, maxLength: 6, selector: ([name]) => name }
)

/** Independent reference encoder; no SDK serializer or verifier contributes expected bytes. */
function compactSize(value: number): Buffer {
  if (value < 253) return Buffer.from([value])
  if (value <= 0xffff) {
    const encoded = Buffer.alloc(3)
    encoded[0] = 253
    encoded.writeUInt16LE(value, 1)
    return encoded
  }
  const encoded = Buffer.alloc(5)
  encoded[0] = 254
  encoded.writeUInt32LE(value, 1)
  return encoded
}

function expectedPrefix(fields: readonly (readonly [string, string])[], vout: number): number[] {
  const chunks = [
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
    subject,
    certifier,
    Buffer.alloc(32),
    compactSize(vout),
    compactSize(fields.length)
  ]
  for (const [name, value] of fields) {
    const nameBytes = Buffer.from(name, 'utf8')
    const valueBytes = Buffer.from(value, 'utf8')
    chunks.push(
      compactSize(nameBytes.length),
      nameBytes,
      compactSize(valueBytes.length),
      valueBytes
    )
  }
  return Array.from(Buffer.concat(chunks))
}

describe('BRC-203 bounded signed-source properties', () => {
  test('preserves exact historical field order, UTF-8/BOM bytes and signatures independently', () => {
    fc.assert(
      fc.property(fieldsArbitrary, fc.integer({ min: 0, max: 65_536 }), (fields, vout) => {
        const binary = createSyntheticBRC52Binary(fields, `${zeroTxid}.${vout}`)
        const prefix = expectedPrefix(fields, vout)
        expect(binary.slice(0, prefix.length)).toEqual(prefix)
        expect(
          verify(
            'sha256',
            Buffer.from(prefix),
            signingPublicKey,
            Buffer.from(binary.slice(prefix.length))
          )
        ).toBe(true)
        const parsed = verifyBRC52CertificateBinary(binary)
        expect(parsed.unsignedPrefix).toEqual(prefix)
        expect(parsed.certificateBinary).toEqual(binary)
        expect(parsed.fields).toEqual(Object.fromEntries(fields))
        const exported = exportBRC52Envelope(binary)
        expect(exported.certificateBinary).toBe(Buffer.from(binary).toString('base64'))
        expect(exported.credential.credentialSubject.encryptedFields).toEqual(
          Object.fromEntries(fields)
        )
        expect(parseBRC52Envelope(JSON.stringify(exported)).source.unsignedPrefix).toEqual(prefix)
      })
    )
  })

  test('never authenticates unsigned-prefix mutations under the unchanged signature', () => {
    const binary = createSyntheticBRC52Binary([['field', opaqueCiphertext]])
    const prefixLength = expectedPrefix([['field', opaqueCiphertext]], 0).length
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: prefixLength - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (index, difference) => {
          const changed = [...binary]
          changed[index] ^= difference
          expect(() => verifyBRC52CertificateBinary(changed)).toThrow()
          expect(() => exportBRC52Envelope(changed)).toThrow()
        }
      )
    )
  })

  test('rejects every generated truncation and nonminimal CompactSize spelling', () => {
    const binary = createSyntheticBRC52Binary([['field', opaqueCiphertext]])
    fc.assert(
      fc.property(fc.integer({ min: 0, max: binary.length - 1 }), length => {
        expect(() => verifyBRC52CertificateBinary(binary.slice(0, length))).toThrow()
      })
    )
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 252 }), vout => {
        const signed = createSyntheticBRC52Binary([], `${zeroTxid}.${vout}`)
        const nonminimal = [...signed.slice(0, 162), 253, vout, 0, ...signed.slice(163)]
        expect(() => verifyBRC52CertificateBinary(nonminimal)).toThrow('CompactSize')
      })
    )
  })

  test('rejects wrapper proof, graph additions and rewritten signed facts without trusting claims', () => {
    const binary = createSyntheticBRC52Binary([['field', opaqueCiphertext]], `${zeroTxid}.1`)
    fc.assert(
      fc.property(
        fc.constantFrom(
          'issuer',
          'ciphertext',
          'serial',
          'proof',
          'network',
          'context',
          'envelope-proof'
        ),
        fc.string({ maxLength: 32 }),
        (claim, value) => {
          const wrapped = exportBRC52Envelope(binary)
          if (claim === 'issuer') wrapped.credential.issuer = `${wrapped.credential.issuer}changed`
          else if (claim === 'ciphertext')
            wrapped.credential.credentialSubject.encryptedFields.field = `changed:${value}`
          else if (claim === 'serial') wrapped.credential.serialNumber = `changed:${value}`
          else if (claim === 'proof')
            Object.assign(wrapped.credential, { proof: { type: 'invented', value } })
          else if (claim === 'network') Object.assign(wrapped.credential, { network: value })
          else if (claim === 'context')
            wrapped.credential['@context'][0] =
              `https://untrusted.invalid/${encodeURIComponent(value)}`
          else Object.assign(wrapped, { proof: { type: 'invented', value } })
          expect(verifyBRC52Envelope('application/json', JSON.stringify(wrapped))).toMatchObject({
            verified: false,
            verifiedDocument: null
          })
        }
      )
    )
  })
})
