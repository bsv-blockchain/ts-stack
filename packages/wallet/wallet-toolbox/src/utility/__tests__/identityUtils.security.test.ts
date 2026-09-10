import { PushDrop, Transaction, Utils, VerifiableCertificate } from '@bsv/sdk'
import { parseResults } from '../identityUtils'

describe('identity overlay certificate verification', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('rejects a certificate when cryptographic verification returns false', async () => {
    const certificate = {
      type: Buffer.alloc(32, 1).toString('base64'),
      serialNumber: Buffer.alloc(32, 2).toString('base64'),
      subject: '02' + '11'.repeat(32),
      certifier: '02' + '22'.repeat(32),
      revocationOutpoint: `${'ab'.repeat(32)}.0`,
      fields: { name: 'encrypted-name' },
      keyring: { name: 'encrypted-key' },
      signature: '3006020101020101'
    }
    jest.spyOn(Transaction, 'fromBEEF').mockReturnValue({
      outputs: [{ lockingScript: {} }]
    } as never)
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      fields: [Utils.toArray(JSON.stringify(certificate), 'utf8')]
    } as never)
    jest.spyOn(VerifiableCertificate.prototype, 'decryptFields').mockResolvedValue({ name: 'Alice' })
    jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValue(false)

    await expect(
      parseResults({
        type: 'output-list',
        outputs: [{ beef: [1], outputIndex: 0 }]
      })
    ).resolves.toEqual([])
  })
})
