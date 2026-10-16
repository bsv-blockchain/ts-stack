import { MasterCertificate, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { _tu } from '../../test/utils/TestUtilsWalletStorage'

/**
 * Wallet storage created before @bsv/sdk 2.8.0 can hold certificates whose
 * `type` is shorter than 32 bytes. The wallet must keep listing, proving and
 * relinquishing them so applications can migrate to canonical types
 * (bsv-blockchain/ts-stack#1085).
 */
describe('Wallet legacy certificate type compatibility', () => {
  jest.setTimeout(30000)

  const legacyType = Utils.toBase64(Array.from({ length: 16 }, (_, index) => index + 1))
  const serialNumber = Utils.toBase64(Array.from({ length: 32 }).fill(2) as number[])

  test('lists, proves and relinquishes a stored certificate with a pre-2.8 short type', async () => {
    const { wallet, storage, activeStorage, userId, identityKey } = await _tu.createSQLiteTestWallet({
      databaseName: 'legacyCertificateTypeCompatibility',
      dropAll: true
    })
    try {
      const certifierKey = PrivateKey.fromRandom()
      const certifier = certifierKey.toPublicKey().toString()
      const { certificateFields, masterKeyring } = await MasterCertificate.createCertificateFields(
        new ProtoWallet(certifierKey),
        identityKey,
        { name: 'Alice', email: 'alice@example.com' }
      )
      const now = new Date()
      await activeStorage.insertCertificate({
        created_at: now,
        updated_at: now,
        certificateId: 0,
        userId,
        type: legacyType,
        serialNumber,
        certifier,
        subject: identityKey,
        revocationOutpoint: `${'00'.repeat(32)}.0`,
        signature: '3006020101020101',
        isDeleted: false,
        fields: Object.keys(certificateFields).map(fieldName => ({
          created_at: now,
          updated_at: now,
          userId,
          certificateId: 0,
          fieldName,
          fieldValue: certificateFields[fieldName],
          masterKey: masterKeyring[fieldName]
        }))
      })

      const listed = await wallet.listCertificates({ certifiers: [certifier], types: [legacyType] })
      expect(listed.totalCertificates).toBe(1)
      expect(listed.certificates[0]).toMatchObject({ type: legacyType, serialNumber, certifier })

      const verifier = PrivateKey.fromRandom().toPublicKey().toString()
      const proof = await wallet.proveCertificate({
        certificate: { type: legacyType, serialNumber, certifier },
        fieldsToReveal: ['name'],
        verifier
      })
      expect(Object.keys(proof.keyringForVerifier)).toEqual(['name'])

      await expect(wallet.relinquishCertificate({ type: legacyType, serialNumber, certifier })).resolves.toEqual({
        relinquished: true
      })
      await expect(wallet.listCertificates({ certifiers: [], types: [] })).resolves.toMatchObject({
        totalCertificates: 0
      })
    } finally {
      await storage.destroy()
    }
  })
})
