import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
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
      parseResults(
        {
          type: 'output-list',
          outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }]
        },
        fixture.confirmedTracker
      )
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
    expect(filterCertificatesByAttributes([cert], { name: 'al', company: ' ' })).toEqual([cert])
    expect(filterCertificatesByAttributes([cert], { age: '42' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { any: 'al' })).toEqual([cert])
    expect(filterCertificatesByAttributes([cert], { any: 'zz' })).toEqual([])
    expect(filterCertificatesByAttributes([cert], { any: 'bob' })).toEqual([])
  })

  test('mirrors overlay text search for any: diacritics, phrases, exclusions, unsearchable fields', () => {
    const jose = {
      subject,
      decryptedFields: { name: 'José Alice Smith', profilePhoto: 'uhrp://bob' }
    } as unknown as VerifiableCertificate

    expect(filterCertificatesByAttributes([jose], { any: 'jose' })).toEqual([jose])
    expect(filterCertificatesByAttributes([jose], { any: '"Alice Smith"' })).toEqual([jose])
    expect(filterCertificatesByAttributes([jose], { any: '"Smith Alice"' })).toEqual([])
    expect(filterCertificatesByAttributes([jose], { any: 'alice -smith' })).toEqual([])
    expect(filterCertificatesByAttributes([jose], { any: 'bob' })).toEqual([])
  })
  test.each([
    {
      label: 'complete name',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'alice'
      },
      accepted: true
    },
    {
      label: 'partial word',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'ali'
      },
      accepted: false
    },
    {
      label: 'stopword only',
      fields: {
        name: 'The Alice Smith'
      },
      attributes: {
        any: 'the'
      },
      accepted: false
    },
    {
      label: 'stopword and name',
      fields: {
        name: 'The Alice Smith'
      },
      attributes: {
        any: 'the alice'
      },
      accepted: true
    },
    {
      label: 'punctuation separates words',
      fields: {
        name: 'Alice-Smith'
      },
      attributes: {
        any: 'smith'
      },
      accepted: true
    },
    {
      label: 'hyphenated query',
      fields: {
        name: 'Alice Jones'
      },
      attributes: {
        any: 'Alice-Smith'
      },
      accepted: true
    },
    {
      label: 'whole excluded word',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'alice -smith'
      },
      accepted: false
    },
    {
      label: 'excluded partial word',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'alice -smi'
      },
      accepted: true
    },
    {
      label: 'excluded name suffix',
      fields: {
        name: 'Alice Smithson'
      },
      attributes: {
        any: 'alice -smith'
      },
      accepted: true
    },
    {
      label: 'excluded stopword',
      fields: {
        name: 'The Alice Smith'
      },
      attributes: {
        any: 'alice -the'
      },
      accepted: true
    },
    {
      label: 'required phrase',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: '"Alice Smith"'
      },
      accepted: true
    },
    {
      label: 'phrase preserves spacing',
      fields: {
        name: 'Alice  Smith'
      },
      attributes: {
        any: '"Alice Smith"'
      },
      accepted: false
    },
    {
      label: 'phrase word order',
      fields: {
        name: 'Smith Alice'
      },
      attributes: {
        any: '"Alice Smith"'
      },
      accepted: false
    },
    {
      label: 'quoted stopword only',
      fields: {
        name: 'The Alice Smith'
      },
      attributes: {
        any: '"the"'
      },
      accepted: false
    },
    {
      label: 'quoted stopword with indexed name',
      fields: {
        name: 'The Alice Smith'
      },
      attributes: {
        any: '"the" alice'
      },
      accepted: true
    },
    {
      label: 'negative phrase',
      fields: {
        name: 'Alice Smith Jones'
      },
      attributes: {
        any: 'alice -"smith jones"'
      },
      accepted: false
    },
    {
      label: 'negative phrase does not exclude individual word',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'alice -"smith jones"'
      },
      accepted: true
    },
    {
      label: 'empty phrase',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: '"" nobody alice'
      },
      accepted: true
    },
    {
      label: 'space after minus',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'alice - nobody'
      },
      accepted: true
    },
    {
      label: 'diacritics',
      fields: {
        name: 'José Smith'
      },
      attributes: {
        any: 'jose'
      },
      accepted: true
    },
    {
      label: 'ASCII apostrophe',
      fields: {
        name: "Alice O'Neil"
      },
      attributes: {
        any: "O'Neil"
      },
      accepted: true
    },
    {
      label: 'two-character search remains fuzzy',
      fields: {
        name: 'Alice Smith'
      },
      attributes: {
        any: 'al'
      },
      accepted: true
    },
    {
      label: 'excluded image metadata',
      fields: {
        name: 'Alice Smith',
        icon: 'Bob',
        profilePhoto: 'Bob'
      },
      attributes: {
        any: 'bob'
      },
      accepted: false
    },
    {
      label: 'ordered named tokens',
      fields: {
        name: 'Alice Barbara Smith'
      },
      attributes: {
        name: 'ali smi'
      },
      accepted: true
    },
    {
      label: 'reversed named tokens',
      fields: {
        name: 'Smith Alice'
      },
      attributes: {
        name: 'ali smi'
      },
      accepted: false
    },
    {
      label: 'line boundary',
      fields: {
        name: 'Alice\nSmith'
      },
      attributes: {
        name: 'ali smi'
      },
      accepted: false
    },
    {
      label: 'literal punctuation',
      fields: {
        name: 'Alice (Smith)'
      },
      attributes: {
        name: 'alice (smith)'
      },
      accepted: true
    },
    {
      label: 'literal plus',
      fields: {
        name: 'C++ Club'
      },
      attributes: {
        name: 'c++ club'
      },
      accepted: true
    },
    {
      label: 'Greek sigma case folding',
      fields: {
        name: 'ΟΣ'
      },
      attributes: {
        name: 'ος'
      },
      accepted: true
    },
    {
      label: 'username stays exact',
      fields: {
        userName: 'Alice'
      },
      attributes: {
        userName: 'alice'
      },
      accepted: false
    },
    {
      label: 'blank optional named attribute',
      fields: {
        name: 'Alice'
      },
      attributes: {
        name: 'ali',
        city: ' '
      },
      accepted: true
    }
  ])('SDK and Toolbox identity parity: $label', ({ fields, attributes, accepted }) => {
    const certificate = {
      type: Utils.toBase64(Array(32).fill(1)),
      serialNumber: Utils.toBase64(Array(32).fill(2)),
      subject,
      certifier,
      revocationOutpoint: `${'ab'.repeat(32)}.0`,
      signature: '3006020101020101',
      fields: {},
      publiclyRevealedKeyring: {},
      certifierInfo: { name: 'Certifier', iconUrl: 'https://example.com/icon.png', description: 'Trusted', trust: 1 },
      decryptedFields: fields
    }
    const selected = filterCertificatesByAttributes(
      [certificate as unknown as VerifiableCertificate],
      attributes as Record<string, string>
    )
    expect(selected).toEqual(accepted ? [certificate] : [])
    const validate = (): unknown =>
      validateWalletResult(
        'discoverByAttributes',
        { totalCertificates: 1, certificates: [certificate] },
        { attributes }
      )
    if (accepted) expect(validate).not.toThrow()
    else expect(validate).toThrow('Invalid discoverByAttributes result')
  })

  test('ignores inherited attributes and rejects invalid requested values without coercion', () => {
    const certificate = { subject, decryptedFields: { name: 'Alice' } } as VerifiableCertificate
    const inherited = Object.create({ any: 'bob' }) as Record<string, string>
    inherited.name = 'alice'
    expect(filterCertificatesByAttributes([certificate], inherited)).toEqual([certificate])
    expect(filterCertificatesByAttributes([certificate], { any: 42 } as never)).toEqual([])
    expect(filterCertificatesByAttributes([certificate], { name: 42 } as never)).toEqual([])
    expect(filterCertificatesByAttributes([certificate], null as never)).toEqual([])
    expect(filterCertificatesByAttributes([certificate], [] as never)).toEqual([])
    const inheritedFields = Object.create({ name: 'Alice' }) as Record<string, string>
    expect(
      filterCertificatesByAttributes([{ subject, decryptedFields: inheritedFields } as VerifiableCertificate], {
        name: 'alice'
      })
    ).toEqual([])
  })
})
