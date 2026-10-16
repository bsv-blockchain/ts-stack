/**
 * Regression coverage for bsv-blockchain/ts-stack#1085.
 *
 * Certificates issued before @bsv/sdk 2.8.0 may carry a `type` shorter than
 * the canonical 32 bytes. Wallet methods that operate on certificates a wallet
 * already holds (list, prove, relinquish) and result validation accept those
 * historical types during the deprecation window. New issuance and the binary
 * wallet wire remain canonical: `acquireCertificate` still requires exactly 32
 * bytes and the wire rejects a legacy type explicitly instead of misaligning.
 */
import { jest } from '@jest/globals'
import {
  validateAcquireDirectCertificateArgs,
  validateAcquireIssuanceCertificateArgs,
  validateListCertificatesArgs,
  validateProveCertificateArgs,
  validateRelinquishCertificateArgs
} from '../validationHelpers.js'
import { validateWalletResult } from '../WalletResultValidation.js'
import WalletWireProcessor from '../substrates/WalletWireProcessor.js'
import WalletWireTransceiver from '../substrates/WalletWireTransceiver.js'
import { WalletInterface } from '../Wallet.interfaces.js'
import * as Utils from '../../primitives/utils.js'

const PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VERIFIER = '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const bytes = (length: number): string =>
  Utils.toBase64(Array.from({ length }, (_, index) => (index * 7 + 1) & 0xff))
const LEGACY_TYPE = bytes(16)
const CANONICAL_TYPE = bytes(32)
const OVERSIZED_TYPE = bytes(33)
const SERIAL_NUMBER = Utils.toBase64(Array.from({ length: 32 }).fill(2) as number[])
const OUTPOINT = `${'ab'.repeat(32)}.0`
const SIGNATURE = '3006020101020101'
const WIRE_MESSAGE = /binary wallet wire carries only 32-byte certificate types/

const certificate = (type: string): Record<string, unknown> => ({
  type,
  serialNumber: SERIAL_NUMBER,
  subject: PUBLIC_KEY,
  certifier: PUBLIC_KEY,
  revocationOutpoint: OUTPOINT,
  signature: SIGNATURE,
  fields: {}
})

describe('legacy certificate types in wallet argument validation', () => {
  it('accepts a legacy type filter on listCertificates', () => {
    const vargs = validateListCertificatesArgs({ certifiers: [], types: [LEGACY_TYPE] })
    expect(vargs.types).toEqual([LEGACY_TYPE])
  })

  it('accepts a legacy type on relinquishCertificate', () => {
    const vargs = validateRelinquishCertificateArgs({
      type: LEGACY_TYPE,
      serialNumber: SERIAL_NUMBER,
      certifier: PUBLIC_KEY
    })
    expect(vargs.type).toBe(LEGACY_TYPE)
  })

  it('accepts a legacy type on proveCertificate', () => {
    const vargs = validateProveCertificateArgs({
      certificate: { type: LEGACY_TYPE, serialNumber: SERIAL_NUMBER, certifier: PUBLIC_KEY },
      fieldsToReveal: [],
      verifier: VERIFIER
    })
    expect(vargs.type).toBe(LEGACY_TYPE)
  })

  it.each([
    [
      'listCertificates',
      () => validateListCertificatesArgs({ certifiers: [], types: [OVERSIZED_TYPE] })
    ],
    [
      'relinquishCertificate',
      () =>
        validateRelinquishCertificateArgs({
          type: OVERSIZED_TYPE,
          serialNumber: SERIAL_NUMBER,
          certifier: PUBLIC_KEY
        })
    ],
    [
      'proveCertificate',
      () =>
        validateProveCertificateArgs({
          certificate: { type: OVERSIZED_TYPE },
          fieldsToReveal: [],
          verifier: VERIFIER
        })
    ]
  ])('still rejects an oversized type on %s', (_call, validate) => {
    expect(validate).toThrow('no more than 32 bytes')
  })

  it('still requires an exact 32-byte serial number on relinquishCertificate', () => {
    expect(() =>
      validateRelinquishCertificateArgs({
        type: LEGACY_TYPE,
        serialNumber: LEGACY_TYPE,
        certifier: PUBLIC_KEY
      })
    ).toThrow('exactly 32 bytes')
  })

  it('still requires an exact 32-byte type for issuance acquisition', () => {
    expect(() =>
      validateAcquireIssuanceCertificateArgs({
        acquisitionProtocol: 'issuance',
        type: LEGACY_TYPE,
        certifier: PUBLIC_KEY,
        certifierUrl: 'https://certifier.example.com',
        fields: { name: 'Alice' }
      })
    ).toThrow('exactly 32 bytes')
  })

  it('still requires an exact 32-byte type for direct acquisition', () => {
    expect(() =>
      validateAcquireDirectCertificateArgs({
        acquisitionProtocol: 'direct',
        type: LEGACY_TYPE,
        certifier: PUBLIC_KEY,
        fields: { name: 'ZW5j' },
        serialNumber: SERIAL_NUMBER,
        revocationOutpoint: OUTPOINT,
        signature: SIGNATURE,
        keyringRevealer: 'certifier',
        keyringForSubject: { name: 'a2V5' }
      })
    ).toThrow('exactly 32 bytes')
  })

  it('accepts a canonical type everywhere', () => {
    expect(
      validateAcquireIssuanceCertificateArgs({
        acquisitionProtocol: 'issuance',
        type: CANONICAL_TYPE,
        certifier: PUBLIC_KEY,
        certifierUrl: 'https://certifier.example.com',
        fields: { name: 'Alice' }
      }).type
    ).toBe(CANONICAL_TYPE)
    expect(validateListCertificatesArgs({ certifiers: [], types: [CANONICAL_TYPE] }).types).toEqual(
      [CANONICAL_TYPE]
    )
  })
})

describe('legacy certificate types in wallet result validation', () => {
  it('keeps a legacy certificate in an unfiltered listCertificates result', () => {
    const result = validateWalletResult(
      'listCertificates',
      {
        totalCertificates: 2,
        certificates: [certificate(LEGACY_TYPE), certificate(CANONICAL_TYPE)]
      },
      { certifiers: [], types: [] }
    )
    expect(result.certificates.map(c => c.type)).toEqual([LEGACY_TYPE, CANONICAL_TYPE])
  })

  it('binds a legacy certificate to the requested legacy type filter', () => {
    expect(() =>
      validateWalletResult(
        'listCertificates',
        { totalCertificates: 1, certificates: [certificate(CANONICAL_TYPE)] },
        { certifiers: [], types: [LEGACY_TYPE] }
      )
    ).toThrow('requested types')
  })

  it('accepts a legacy certificate in a discovery result', () => {
    const result = validateWalletResult(
      'discoverByIdentityKey',
      {
        totalCertificates: 1,
        certificates: [
          {
            ...certificate(LEGACY_TYPE),
            certifierInfo: {
              name: 'Certifier',
              iconUrl: 'https://certifier.example.com/icon.png',
              description: 'Trusted certifier',
              trust: 1
            },
            publiclyRevealedKeyring: {},
            decryptedFields: {}
          }
        ]
      },
      { identityKey: PUBLIC_KEY }
    )
    expect(result.certificates[0].type).toBe(LEGACY_TYPE)
  })

  it('still rejects an oversized type and a legacy serial number', () => {
    expect(() =>
      validateWalletResult(
        'listCertificates',
        { totalCertificates: 1, certificates: [certificate(OVERSIZED_TYPE)] },
        { certifiers: [], types: [] }
      )
    ).toThrow('canonical signed wallet certificate')
    expect(() =>
      validateWalletResult(
        'listCertificates',
        {
          totalCertificates: 1,
          certificates: [{ ...certificate(CANONICAL_TYPE), serialNumber: LEGACY_TYPE }]
        },
        { certifiers: [], types: [] }
      )
    ).toThrow('canonical signed wallet certificate')
  })
})

describe('legacy certificate types on the binary wallet wire', () => {
  it.each([
    [
      'listCertificates',
      (client: WalletWireTransceiver) =>
        client.listCertificates({ certifiers: [], types: [LEGACY_TYPE] })
    ],
    [
      'relinquishCertificate',
      (client: WalletWireTransceiver) =>
        client.relinquishCertificate({
          type: LEGACY_TYPE,
          serialNumber: SERIAL_NUMBER,
          certifier: PUBLIC_KEY
        })
    ],
    [
      'proveCertificate',
      (client: WalletWireTransceiver) =>
        client.proveCertificate({
          certificate: certificate(LEGACY_TYPE),
          fieldsToReveal: [],
          verifier: VERIFIER
        })
    ]
  ])('rejects a legacy type on %s before invoking the wallet', async (method, invoke) => {
    const called = jest.fn()
    const processor = new WalletWireProcessor({ [method]: called } as unknown as WalletInterface)
    const client = new WalletWireTransceiver(processor)

    await expect(invoke(client)).rejects.toThrow(WIRE_MESSAGE)
    expect(called).not.toHaveBeenCalled()
  })

  it('reports a legacy certificate in a listCertificates result instead of misaligning it', async () => {
    const processor = new WalletWireProcessor({
      listCertificates: async () => ({
        totalCertificates: 1,
        certificates: [certificate(LEGACY_TYPE)]
      })
    } as unknown as WalletInterface)
    const client = new WalletWireTransceiver(processor)

    await expect(client.listCertificates({ certifiers: [], types: [] })).rejects.toThrow(
      WIRE_MESSAGE
    )
  })

  it('rejects a proveCertificate request without a type before invoking the wallet', async () => {
    const proveCertificate = jest.fn()
    const processor = new WalletWireProcessor({ proveCertificate } as unknown as WalletInterface)
    const client = new WalletWireTransceiver(processor)

    await expect(
      client.proveCertificate({ certificate: {}, fieldsToReveal: [], verifier: VERIFIER })
    ).rejects.toThrow(/decodes to 0 bytes/)
    expect(proveCertificate).not.toHaveBeenCalled()
  })

  it('still carries a canonical certificate across the wire', async () => {
    const processor = new WalletWireProcessor({
      listCertificates: async () => ({
        totalCertificates: 1,
        certificates: [certificate(CANONICAL_TYPE)]
      })
    } as unknown as WalletInterface)
    const client = new WalletWireTransceiver(processor)

    const result = await client.listCertificates({ certifiers: [], types: [CANONICAL_TYPE] })
    expect(result.certificates[0].type).toBe(CANONICAL_TYPE)
  })
})
