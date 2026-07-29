import { AcquireCertificateArgs, AuthFetch, Certificate, MasterCertificate, ProtoWallet } from '@bsv/sdk'
import * as sdk from '@bsv/sdk'
import { _tu } from '../../test/utils/TestUtilsWalletStorage'
import { Wallet } from '../Wallet'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return {
    ...actual,
    createNonce: jest.fn(actual.createNonce),
    verifyNonce: jest.fn(actual.verifyNonce)
  }
})

describe('Wallet.acquireCertificate compatibility', () => {
  jest.setTimeout(30000)

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  test('stores a valid direct certificate through the public wallet interface', async () => {
    const { wallet, storage } = await _tu.createSQLiteTestWallet({
      databaseName: 'acquireCertificateCompatibilityDirect',
      dropAll: true
    })
    try {
      const subject = wallet.identityKey
      const { cert: sample, certifier } = _tu.makeSampleCert(subject)
      const certifierWallet = new ProtoWallet(certifier)
      const { certificateFields, masterKeyring } = await MasterCertificate.createCertificateFields(
        certifierWallet,
        subject,
        sample.fields
      )
      const certificate = new Certificate(
        sample.type,
        sample.serialNumber,
        subject,
        sample.certifier,
        sample.revocationOutpoint,
        certificateFields
      )
      await certificate.sign(certifierWallet)

      const result = await wallet.acquireCertificate({
        acquisitionProtocol: 'direct',
        type: certificate.type,
        serialNumber: certificate.serialNumber,
        certifier: certificate.certifier,
        revocationOutpoint: certificate.revocationOutpoint,
        fields: certificate.fields,
        signature: certificate.signature,
        keyringRevealer: 'certifier',
        keyringForSubject: masterKeyring
      })

      expect(result).toMatchObject({
        type: certificate.type,
        subject,
        serialNumber: certificate.serialNumber,
        certifier: certificate.certifier,
        revocationOutpoint: certificate.revocationOutpoint,
        signature: certificate.signature,
        fields: certificate.fields
      })
      await expect(
        wallet.listCertificates({
          types: [certificate.type],
          certifiers: [certificate.certifier]
        })
      ).resolves.toMatchObject({ totalCertificates: 1 })
    } finally {
      await storage.destroy()
    }
  })

  test('accepts a valid issuance response and preserves its public result', async () => {
    const { wallet, storage } = await _tu.createSQLiteTestWallet({
      databaseName: 'acquireCertificateCompatibilityIssuance',
      dropAll: true
    })
    try {
      const args = issuanceArgs()
      const certificateFields = { name: 'encrypted-name' }
      const masterKeyring = { name: 'encrypted-key' }
      mockIssuanceDependencies(wallet, args, certificateFields, masterKeyring, {
        certificate: issuedCertificate(wallet, args, certificateFields),
        serverNonce: Buffer.alloc(48, 2).toString('base64')
      })

      const result = await wallet.acquireCertificate(args)

      expect(result).toMatchObject({
        type: args.type,
        subject: wallet.identityKey,
        certifier: args.certifier,
        fields: certificateFields
      })
      expect(AuthFetch.prototype.fetch).toHaveBeenCalledWith(
        `${args.certifierUrl}/signCertificate`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      )
    } finally {
      await storage.destroy()
    }
  })

  test('normalizes invalid direct-certificate verification as an args error', async () => {
    const { wallet, storage } = await _tu.createSQLiteTestWallet({
      databaseName: 'acquireCertificateCompatibilityInvalidDirect',
      dropAll: true
    })
    try {
      await expect(
        wallet.acquireCertificate({
          acquisitionProtocol: 'direct',
          type: Buffer.alloc(32, 1).toString('base64'),
          serialNumber: Buffer.alloc(32, 2).toString('base64'),
          certifier: '02' + '22'.repeat(32),
          revocationOutpoint: `${'ab'.repeat(32)}.0`,
          fields: { name: 'encrypted-name' },
          signature: '00',
          keyringRevealer: 'certifier',
          keyringForSubject: {
            name: Buffer.alloc(32, 3).toString('base64')
          }
        })
      ).rejects.toThrow('valid encrypted and signed certificate and keyring from revealer')
    } finally {
      await storage.destroy()
    }
  })

  test.each([
    {
      name: 'rejects a response authenticated as another certifier',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        identity: '03' + '33'.repeat(32),
        body: {
          certificate: issuedCertificate(wallet, args, fields),
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid certifier'
      })
    },
    {
      name: 'rejects a response without a certificate',
      configure: () => ({
        body: {
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'No certificate received'
      })
    },
    {
      name: 'rejects a response without a server nonce',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: issuedCertificate(wallet, args, fields)
        },
        error: 'No serverNonce received'
      })
    },
    {
      name: 'rejects a serial number that is not bound to the nonces',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: issuedCertificate(wallet, args, fields),
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        invalidHmac: true,
        error: 'Invalid serialNumber'
      })
    },
    {
      name: 'rejects certificate fields that differ from the request',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: issuedCertificate(wallet, args, {
            ...fields,
            unexpected: 'field'
          }),
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'different numbers of keys'
      })
    },
    {
      name: 'rejects a certificate type that differs from the request',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: {
            ...issuedCertificate(wallet, args, fields),
            type: Buffer.alloc(32, 9).toString('base64')
          },
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid certificate type'
      })
    },
    {
      name: 'rejects a certificate issued to another subject',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: {
            ...issuedCertificate(wallet, args, fields),
            subject: '03' + '44'.repeat(32)
          },
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid certificate subject'
      })
    },
    {
      name: 'rejects a certificate naming another certifier',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: {
            ...issuedCertificate(wallet, args, fields),
            certifier: '03' + '55'.repeat(32)
          },
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid certifier'
      })
    },
    {
      name: 'rejects a certificate without a revocation outpoint',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: {
            ...issuedCertificate(wallet, args, fields),
            revocationOutpoint: ''
          },
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid revocationOutpoint'
      })
    },
    {
      name: 'rejects a certificate with a changed encrypted field value',
      configure: (wallet: Wallet, args: AcquireCertificateArgs, fields: Record<string, string>) => ({
        body: {
          certificate: issuedCertificate(wallet, args, {
            ...fields,
            name: 'different-encrypted-name'
          }),
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Invalid field'
      })
    },
    {
      name: 'rejects a certificate missing an expected encrypted field',
      configure: (wallet: Wallet, args: AcquireCertificateArgs) => ({
        body: {
          certificate: issuedCertificate(wallet, args, {
            other: 'encrypted-name'
          }),
          serverNonce: Buffer.alloc(48, 2).toString('base64')
        },
        error: 'Missing field'
      })
    }
  ])('$name', async ({ configure }) => {
    const { wallet, storage } = await _tu.createSQLiteTestWallet({
      databaseName: `acquireCertificateCompatibilityError${Date.now()}`,
      dropAll: true
    })
    try {
      const args = issuanceArgs()
      const certificateFields = { name: 'encrypted-name' }
      const configured = configure(wallet, args, certificateFields)
      mockIssuanceDependencies(
        wallet,
        args,
        certificateFields,
        { name: 'encrypted-key' },
        configured.body,
        configured.identity,
        configured.invalidHmac
      )

      await expect(wallet.acquireCertificate(args)).rejects.toThrow(configured.error)
    } finally {
      await storage.destroy()
    }
  })

  test('rejects an unknown acquisition protocol without altering storage', async () => {
    const { wallet, storage } = await _tu.createSQLiteTestWallet({
      databaseName: 'acquireCertificateCompatibilityUnknown',
      dropAll: true
    })
    try {
      await expect(
        wallet.acquireCertificate({
          ...issuanceArgs(),
          acquisitionProtocol: 'future-protocol'
        } as unknown as AcquireCertificateArgs)
      ).rejects.toThrow('future-protocol is unrecognized')
      await expect(wallet.listCertificates({ types: [], certifiers: [] })).resolves.toMatchObject({
        totalCertificates: 0
      })
    } finally {
      await storage.destroy()
    }
  })
})

function issuanceArgs(): AcquireCertificateArgs {
  return {
    acquisitionProtocol: 'issuance',
    type: Buffer.alloc(32, 1).toString('base64'),
    certifier: '02' + '22'.repeat(32),
    certifierUrl: 'https://certifier.example',
    fields: { name: 'Alice' }
  }
}

function issuedCertificate(
  wallet: Wallet,
  args: AcquireCertificateArgs,
  fields: Record<string, string>
): Record<string, unknown> {
  return {
    type: args.type,
    serialNumber: Buffer.alloc(32, 3).toString('base64'),
    subject: wallet.identityKey,
    certifier: args.certifier,
    revocationOutpoint: `${'ab'.repeat(32)}.0`,
    fields,
    signature: '30'
  }
}

function mockIssuanceDependencies(
  wallet: Wallet,
  args: AcquireCertificateArgs,
  certificateFields: Record<string, string>,
  masterKeyring: Record<string, string>,
  body: Record<string, unknown>,
  responseIdentity = args.certifier,
  invalidHmac = false
): void {
  jest.mocked(sdk.createNonce).mockResolvedValue(Buffer.alloc(48, 1).toString('base64'))
  jest.spyOn(MasterCertificate, 'createCertificateFields').mockResolvedValue({ certificateFields, masterKeyring })
  jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-bsv-auth-identity-key': responseIdentity
      }
    })
  )
  jest.mocked(sdk.verifyNonce).mockResolvedValue(true)
  jest.spyOn(wallet, 'verifyHmac').mockResolvedValue({ valid: !invalidHmac })
  jest.spyOn(Certificate.prototype, 'verify').mockResolvedValue(true)
  jest.spyOn(MasterCertificate, 'decryptFields').mockResolvedValue({
    ...certificateFields
  })
}
