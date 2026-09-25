import { PrivateKey, PushDrop, Utils, VerifiableCertificate } from '@bsv/sdk'
import {
  filterCertificatesByAttributes,
  filterCertificatesByIdentityKey,
  parseResults,
  transformVerifiableCertificatesWithTrust
} from '../identityUtils'
import { createIdentityVerificationFixture } from './identityVerification.fixtures'

const subject = PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey().toString()
const certifier = PrivateKey.fromHex('2'.padStart(64, '0')).toPublicKey().toString()
const secondCertifier = PrivateKey.fromHex('3'.padStart(64, '0')).toPublicKey().toString()

describe('identity overlay certificate verification', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('rejects a certificate when cryptographic verification returns false', async () => {
    const fixture = await createIdentityVerificationFixture()
    const verify = jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValue(false)

    await expect(
      parseResults({
        type: 'output-list',
        outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }]
      }, fixture.confirmedTracker)
    ).resolves.toEqual([])
    expect(verify).toHaveBeenCalledTimes(1)
  })

  test('rejects an identity token without the subject field signature', async () => {
    const fixture = await createIdentityVerificationFixture()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    const decoded = PushDrop.decode(fixture.certificateTransaction.outputs[0].lockingScript)
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      lockingPublicKey: decoded.lockingPublicKey,
      fields: [Utils.toArray('{}', 'utf8')]
    } as never)
    const verify = jest.spyOn(VerifiableCertificate.prototype, 'verify')

    await expect(
      parseResults(
        { type: 'output-list', outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }] },
        fixture.confirmedTracker
      )
    ).resolves.toEqual([])
    expect(verify).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  test('does not amplify one certifier trust through duplicate certificates', () => {
    const certificate = {
      type: Utils.toBase64(Array(32).fill(1)),
      serialNumber: Utils.toBase64(Array(32).fill(2)),
      subject,
      certifier,
      signature: '3006020101020101',
      fields: { name: 'ciphertext' },
      keyring: { name: 'key' },
      decryptedFields: { name: 'Alice' }
    } as never
    const trustSettings = {
      trustLevel: 2,
      trustedCertifiers: [
        { name: 'One', description: 'First certifier', identityKey: certifier, trust: 1 },
        {
          name: 'Two',
          description: 'Second certifier',
          identityKey: secondCertifier,
          trust: 1
        }
      ]
    }

    expect(transformVerifiableCertificatesWithTrust(trustSettings, [certificate, certificate]).certificates).toEqual([])

    const independent = { ...certificate, certifier: secondCertifier }
    const accepted = transformVerifiableCertificatesWithTrust(trustSettings, [certificate, independent as never])
    expect(accepted.totalCertificates).toBe(2)
  })

  test('copy-isolates nested certificate data returned from the identity cache pipeline', () => {
    const certificate = {
      type: Utils.toBase64(Array(32).fill(1)),
      serialNumber: Utils.toBase64(Array(32).fill(2)),
      subject,
      certifier,
      revocationOutpoint: `${'ab'.repeat(32)}.0`,
      signature: '3006020101020101',
      fields: { name: 'ciphertext' },
      keyring: { name: 'key' },
      decryptedFields: { name: 'Alice' }
    } as never
    const settings = {
      trustLevel: 1,
      trustedCertifiers: [{ name: 'One', description: 'First certifier', identityKey: certifier, trust: 1 }]
    }

    const first = transformVerifiableCertificatesWithTrust(settings, [certificate])
    first.certificates[0].decryptedFields.name = 'Mallory'
    first.certificates[0].fields.name = 'substituted'
    first.certificates[0].publiclyRevealedKeyring.name = 'substituted'

    const second = transformVerifiableCertificatesWithTrust(settings, [certificate])
    expect(second.certificates[0].decryptedFields.name).toBe('Alice')
    expect(second.certificates[0].fields.name).toBe('ciphertext')
    expect(second.certificates[0].publiclyRevealedKeyring.name).toBe('key')
  })

  test('binds authenticated certificates to the identity query answered by the lookup host', () => {
    const otherSubject = PrivateKey.fromHex('5'.padStart(64, '0')).toPublicKey().toString()
    const expected = {
      subject,
      decryptedFields: { name: 'Alice', city: 'London' }
    } as VerifiableCertificate
    const substituted = {
      subject: otherSubject,
      decryptedFields: { name: 'Alice', city: 'London' }
    } as VerifiableCertificate

    expect(filterCertificatesByIdentityKey([substituted, expected], subject)).toEqual([expected])
  })

  test('binds authenticated certificates to every requested public attribute', () => {
    const expected = {
      subject,
      decryptedFields: { name: 'Alice', city: 'London' }
    } as VerifiableCertificate
    const substituted = {
      subject,
      decryptedFields: { name: 'Mallory', city: 'London' }
    } as VerifiableCertificate

    expect(
      filterCertificatesByAttributes([substituted, expected], {
        name: 'alice',
        city: 'LONDON'
      })
    ).toEqual([expected])
  })

  test('treats the any attribute as an all-fields search, not a field name', () => {
    const match = {
      subject,
      decryptedFields: { userName: 'Deggen', profilePhoto: 'uhrp://x' }
    } as unknown as VerifiableCertificate
    const unrelated = {
      subject,
      decryptedFields: { userName: 'Mallory', profilePhoto: 'uhrp://y' }
    } as unknown as VerifiableCertificate

    expect(filterCertificatesByAttributes([match, unrelated], { any: 'deggen' })).toEqual([match])
    expect(filterCertificatesByAttributes([match], { any: 'd' })).toEqual([])
  })

  test('mirrors overlay fuzzy matching for named attributes', () => {
    const cert = {
      subject,
      decryptedFields: { name: 'Alice Smith', userName: 'alice' }
    } as unknown as VerifiableCertificate

    expect(filterCertificatesByAttributes([cert], { name: 'ali smi' })).toEqual([cert])
    expect(filterCertificatesByAttributes([cert], { userName: 'ali' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { name: 'bob' })).toEqual([])
  })

  test('rejects blank, short, and non-string attribute matches', () => {
    const cert = {
      subject,
      decryptedFields: { name: 'Al', age: 42 }
    } as unknown as VerifiableCertificate

    expect(filterCertificatesByAttributes([cert], { name: '   ' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { age: '42' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { any: 'al' })).toEqual([cert])
    expect(filterCertificatesByAttributes([cert], { any: 'zz' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { any: 'bob' })).toEqual([])
  })
})
