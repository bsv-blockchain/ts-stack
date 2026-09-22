import { MasterCertificate, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  fetchCertificateServiceJson,
  validateCertificateData,
  validateCertificateServiceInfo
} from '../certificate-validation'
import { CertificateData } from '../types'
import legacyCredentialFixture from './fixtures/pre-0.6-credential.json'

const PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const CERTIFIER_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const CERTIFICATE_TYPE = toBase64(Array.from({ length: 32 }, () => 1))
const CERTIFICATE_SERIAL = toBase64(Array.from({ length: 32 }, () => 2))
const ZERO_OUTPOINT = `${'00'.repeat(32)}.0`

async function signedCertificate(type = CERTIFICATE_TYPE): Promise<CertificateData> {
  const master = new MasterCertificate(
    type,
    CERTIFICATE_SERIAL,
    SUBJECT_KEY,
    CERTIFIER_KEY,
    ZERO_OUTPOINT,
    { name: 'QWxpY2U=' },
    { name: 'AA==' }
  )
  await master.sign(new ProtoWallet(new PrivateKey(PRIVATE_KEY, 'hex')))
  return {
    type: master.type,
    serialNumber: master.serialNumber,
    subject: master.subject,
    certifier: master.certifier,
    revocationOutpoint: master.revocationOutpoint,
    fields: { ...master.fields },
    signature: master.signature as string,
    keyringForSubject: { ...master.masterKeyring }
  }
}

describe('certificate validation trust boundaries', () => {
  it('returns owned null-prototype field snapshots', async () => {
    const result = await validateCertificateData(await signedCertificate())

    expect(Object.getPrototypeOf(result.fields)).toBeNull()
    expect(Object.getPrototypeOf(result.keyringForSubject)).toBeNull()
  })

  it.each(['type', 'fields', 'keyringForSubject'] as const)(
    'does not source a missing %s from Object.prototype',
    async property => {
      const certificate = await signedCertificate()
      const inheritedValue = certificate[property]
      const withoutOwnProperty: Partial<CertificateData> = { ...certificate }
      delete withoutOwnProperty[property]
      Object.defineProperty(Object.prototype, property, {
        value: inheritedValue,
        configurable: true
      })

      try {
        await expect(validateCertificateData(withoutOwnProperty)).rejects.toThrow(
          property === 'type' ? 'Invalid certificate type' : 'Invalid certificate'
        )
      } finally {
        Reflect.deleteProperty(Object.prototype, property)
      }
    }
  )

  it('rejects accessor fields even when Object.prototype supplies an ambient descriptor value', async () => {
    const certificate = await signedCertificate()
    Object.defineProperty(certificate, 'type', {
      get: () => {
        throw new Error('untrusted getter must not run')
      },
      enumerable: true,
      configurable: true
    })
    Object.defineProperty(Object.prototype, 'value', {
      value: CERTIFICATE_TYPE,
      configurable: true
    })

    try {
      await expect(validateCertificateData(certificate)).rejects.toThrow(
        'Invalid certificate response'
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, 'value')
    }
  })

  it('verifies a historical signed fixture only for an exact configured local legacy type', async () => {
    const certificate = legacyCredentialFixture.certificate as CertificateData

    await expect(validateCertificateData(certificate)).rejects.toThrow('Invalid certificate type')
    await expect(
      validateCertificateData(certificate, {}, { legacyCertificateTypes: [certificate.type] })
    ).resolves.toMatchObject({ type: certificate.type })
    await expect(
      validateCertificateData(certificate, {}, { legacyCertificateTypes: ['Y2VydGlmaWNhdGlvbg=='] })
    ).rejects.toThrow('Invalid certificate type')
    await expect(
      validateCertificateData(
        { ...certificate, signature: `${certificate.signature.slice(0, -2)}00` },
        {},
        { legacyCertificateTypes: [certificate.type] }
      )
    ).rejects.toThrow('Certificate signature is invalid')
  })

  it('does not source remote issuer metadata or error text from Object.prototype', async () => {
    Object.defineProperty(Object.prototype, 'certifierPublicKey', {
      value: CERTIFIER_KEY,
      configurable: true
    })
    Object.defineProperty(Object.prototype, 'error', {
      value: 'ambient error text',
      configurable: true
    })

    try {
      expect(() => validateCertificateServiceInfo({ certificateType: CERTIFICATE_TYPE })).toThrow(
        'Invalid certificate service certifier'
      )
      await expect(
        fetchCertificateServiceJson(
          new URL('https://issuer.example'),
          'info',
          {},
          (async () => new Response('{}', { status: 503 })) as typeof fetch
        )
      ).rejects.toThrow('Certificate service returned HTTP 503')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'certifierPublicKey')
      Reflect.deleteProperty(Object.prototype, 'error')
    }
  })

  it('keeps remote service-advertised certificate types strictly 32 bytes', () => {
    expect(() =>
      validateCertificateServiceInfo({
        certifierPublicKey: CERTIFIER_KEY,
        certificateType: toBase64(toArray('certification', 'utf8'))
      })
    ).toThrow('Invalid certificate type')
  })

  it('pairs certificate fields with subject keys in code-unit order', async () => {
    const fields = { z: 'QQ==', ä: 'QQ==', A: 'QQ==' }
    const keyringForSubject = { A: 'QQ==', ä: 'QQ==', z: 'QQ==' }
    const originalSort = Array.prototype.sort
    Array.prototype.sort = function (compareFn?: (left: string, right: string) => number) {
      if (typeof compareFn !== 'function') {
        throw new Error('Array.prototype.sort was called without a comparator')
      }
      return originalSort.call(this, compareFn)
    }
    try {
      await expect(
        validateCertificateData({
          type: CERTIFICATE_TYPE,
          serialNumber: CERTIFICATE_SERIAL,
          subject: SUBJECT_KEY,
          certifier: CERTIFIER_KEY,
          revocationOutpoint: ZERO_OUTPOINT,
          fields,
          signature: '00',
          keyringForSubject
        })
      ).rejects.not.toThrow('Invalid certificate subject keyring')
      await expect(
        validateCertificateData({
          type: CERTIFICATE_TYPE,
          serialNumber: CERTIFICATE_SERIAL,
          subject: SUBJECT_KEY,
          certifier: CERTIFIER_KEY,
          revocationOutpoint: ZERO_OUTPOINT,
          fields,
          signature: '00',
          keyringForSubject: { z: 'QQ==' }
        })
      ).rejects.toThrow('Invalid certificate subject keyring')
    } finally {
      Array.prototype.sort = originalSort
    }
  })
})
