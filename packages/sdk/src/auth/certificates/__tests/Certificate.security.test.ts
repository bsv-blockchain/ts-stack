import Certificate from '../Certificate.js'
import * as Utils from '../../../primitives/utils.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import { CompletedProtoWallet } from './CompletedProtoWallet.js'

const VALID_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VALID_TYPE = Utils.toBase64(Array(32).fill(1))
const VALID_SERIAL = Utils.toBase64(Array(32).fill(2))
const PREFIX = [
  ...Array(32).fill(0),
  ...Array(32).fill(0),
  ...Utils.toArray(VALID_PUBLIC_KEY, 'hex'),
  ...Utils.toArray(VALID_PUBLIC_KEY, 'hex'),
  ...Array(32).fill(0),
  0
]

describe('Certificate binary field safety', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the prototype-sensitive field name %s while decoding',
    fieldName => {
      const fieldNameBytes = Utils.toArray(fieldName, 'utf8')
      const binary = [...PREFIX, 1, fieldNameBytes.length, ...fieldNameBytes, 0]
      expect(() => Certificate.fromBinary(binary)).toThrow('Unsafe certificate field name')
    }
  )

  it('rejects duplicate field names instead of silently overwriting signed data', () => {
    const fieldNameBytes = Utils.toArray('name', 'utf8')
    const field = [fieldNameBytes.length, ...fieldNameBytes, 0]
    expect(() => Certificate.fromBinary([...PREFIX, 2, ...field, ...field])).toThrow(
      'Duplicate certificate field name'
    )
  })

  it('rejects an excessive field count before iterating certificate data', () => {
    expect(() => Certificate.fromBinary([...PREFIX, 0xfe, 0xa1, 0x86, 0x01, 0x00])).toThrow(
      'field count exceeds the maximum'
    )
  })

  it('rejects unsafe field names while serializing', () => {
    const fields = Object.create(null) as Record<string, string>
    fields.constructor = 'value'
    const certificate = new Certificate(
      VALID_TYPE,
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      fields
    )
    expect(() => certificate.toBinary()).toThrow('Unsafe certificate field name')
  })

  it.each([
    ['type', Utils.toBase64(Array(31).fill(1)), VALID_SERIAL, VALID_PUBLIC_KEY, VALID_PUBLIC_KEY],
    [
      'serial number',
      VALID_TYPE,
      Utils.toBase64(Array(31).fill(2)),
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY
    ],
    ['subject', VALID_TYPE, VALID_SERIAL, '00'.repeat(33), VALID_PUBLIC_KEY],
    ['certifier', VALID_TYPE, VALID_SERIAL, VALID_PUBLIC_KEY, '00'.repeat(33)]
  ])(
    'rejects an invalid fixed-width %s while serializing',
    (_field, type, serial, subject, certifier) => {
      const certificate = new Certificate(
        type,
        serial,
        subject,
        certifier,
        `${'00'.repeat(32)}.0`,
        {}
      )
      expect(() => certificate.toBinary()).toThrow(`Invalid certificate ${_field}`)
    }
  )

  it('rejects a malformed DER signature while serializing', () => {
    const certificate = new Certificate(
      VALID_TYPE,
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      {},
      '00'
    )
    expect(() => certificate.toBinary()).toThrow('Signature DER')
  })

  it('rejects non-canonical textual identifiers before signing or serializing', () => {
    const certificate = new Certificate(
      VALID_TYPE.replace(/=$/, ''),
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      {}
    )
    expect(() => certificate.toBinary()).toThrow('expected canonical base64')
  })

  it('rejects sparse and oversized binary inputs before parsing', () => {
    const sparse: number[] = []
    sparse.length = PREFIX.length
    sparse[0] = 0
    expect(() => Certificate.fromBinary(sparse)).toThrow('dense byte array')
    expect(() => Certificate.fromBinary(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow(
      'at most 16777216 bytes'
    )
  })

  it('rejects accessors and oversized values in the signed field record', () => {
    const accessorFields = Object.create(null) as Record<string, string>
    Object.defineProperty(accessorFields, 'name', {
      enumerable: true,
      get: () => 'Alice'
    })
    const accessorCertificate = new Certificate(
      VALID_TYPE,
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      accessorFields
    )
    expect(() => accessorCertificate.toBinary()).toThrow('own string data property')

    const oversizedCertificate = new Certificate(
      VALID_TYPE,
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      { name: 'x'.repeat(1024 * 1024 + 1) }
    )
    expect(() => oversizedCertificate.toBinary()).toThrow('exceeds the maximum')
  })

  it('does not attach a signature if the certificate changes during asynchronous signing', async () => {
    const wallet = new CompletedProtoWallet(new PrivateKey(22))
    const certificate = new Certificate(
      VALID_TYPE,
      VALID_SERIAL,
      VALID_PUBLIC_KEY,
      VALID_PUBLIC_KEY,
      `${'00'.repeat(32)}.0`,
      { name: 'Alice' }
    )
    const originalCreateSignature = wallet.createSignature.bind(wallet)
    let release!: () => void
    let signingStarted!: () => void
    const signingStartedPromise = new Promise<void>(resolve => {
      signingStarted = resolve
    })
    const releasePromise = new Promise<void>(resolve => {
      release = resolve
    })
    jest.spyOn(wallet, 'createSignature').mockImplementation(async args => {
      signingStarted()
      await releasePromise
      return await originalCreateSignature(args)
    })

    const signing = certificate.sign(wallet)
    await signingStartedPromise
    certificate.fields.name = 'Mallory'
    release()

    await expect(signing).rejects.toThrow('changed while its signature was being created')
    expect(certificate.signature).toBeUndefined()
  })
})
