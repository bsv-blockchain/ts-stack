import { KeyDeriver, PrivateKey, Utils, VerifiableCertificate, WalletClient } from '@bsv/sdk'
import { Wallet } from '../Wallet'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { WalletSettingsManager } from '../WalletSettingsManager'
import { WalletStorageManager } from '../storage/WalletStorageManager'

// BRC-100 discovery takes limit and offset, and @bsv/sdk rejects a result
// holding more certificates than the requested limit (10 when omitted).
// totalCertificates keeps counting every trusted match.

const certifier = new PrivateKey(7).toPublicKey().toString()

function verifiedCertificate(index: number): VerifiableCertificate {
  return {
    type: Utils.toBase64(Array(32).fill(1)),
    serialNumber: Utils.toBase64(Array(32).fill(index)),
    subject: new PrivateKey(100 + index).toPublicKey().toString(),
    certifier,
    revocationOutpoint: `${'ab'.repeat(32)}.${index}`,
    signature: '3006020101020101',
    fields: {},
    keyring: {},
    decryptedFields: { userName: 'deggen' }
  } as unknown as VerifiableCertificate
}

function callerFor(count: number): WalletClient {
  const keyDeriver = new KeyDeriver(new PrivateKey(15))
  const trustSettings = {
    trustLevel: 1,
    trustedCertifiers: [{ identityKey: certifier, name: 'Certifier', description: 'Test certifier', trust: 1 }]
  }
  const wallet = new Wallet({
    chain: 'main',
    keyDeriver,
    storage: new WalletStorageManager(keyDeriver.identityKey),
    settingsManager: { get: async () => ({ trustSettings }) } as unknown as WalletSettingsManager
  })
  const certificates = Array.from({ length: count }, (_, index) => verifiedCertificate(index + 1))
  jest.spyOn(wallet as any, 'discoverOverlayCertificates').mockResolvedValue(certificates)
  const manager = new WalletPermissionsManager(wallet, 'admin.example', {
    seekPermissionsForIdentityResolution: false
  })
  return new WalletClient(manager, 'app.example')
}

describe('identity discovery pagination', () => {
  test('discoverByAttributes returns the requested page of trusted matches', async () => {
    const result = await callerFor(4).discoverByAttributes({ attributes: { userName: 'deggen' }, limit: 2, offset: 1 })
    expect(result.totalCertificates).toBe(4)
    expect(result.certificates).toHaveLength(2)
  })

  test('discoverByAttributes stays within the default limit of 10', async () => {
    const result = await callerFor(12).discoverByAttributes({ attributes: { userName: 'deggen' } })
    expect(result.totalCertificates).toBe(12)
    expect(result.certificates).toHaveLength(10)
  })

  test('an offset past the last match returns an empty page', async () => {
    const result = await callerFor(3).discoverByAttributes({ attributes: { userName: 'deggen' }, limit: 5, offset: 3 })
    expect(result).toEqual({ totalCertificates: 3, certificates: [] })
  })
})
