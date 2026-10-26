import {
  ProtoWallet,
  PrivateKey,
  MasterCertificate,
  Random,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  canonicalCertificateType,
  legacyCompatibleCertificateType,
  snapshotPlainDataRecord,
  validateCertificateData,
  validateCredentialFields
} from '../core/certificate-validation'
import { WalletCore } from '../core/WalletCore'
import { CertificateData, CertifierConfig } from '../core/types'
import { acquireRemoteCertificate, RemoteCertificateRequest } from './certificate-service'

const DEFAULT_CERTIFICATE_TYPE_SOURCE = 'certification'

function uniqueCertificateTypes(types: string[]): string[] {
  return [...new Set(types)]
}

// ============================================================================
// Standalone Certifier (no wallet dependency for construction)
// ============================================================================

export class Certifier {
  private readonly protoWallet: ProtoWallet
  private readonly pubKey: string
  private readonly certType: string
  private readonly certTypes: string[]
  private readonly defaultFields: Record<string, string>
  private readonly includeTimestamp: boolean

  private constructor(config: {
    privateKey: PrivateKey
    certificateType: string
    certificateTypes: string[]
    defaultFields: Record<string, string>
    includeTimestamp: boolean
  }) {
    this.protoWallet = new ProtoWallet(config.privateKey)
    this.pubKey = config.privateKey.toPublicKey().toString()
    this.certType = config.certificateType
    this.certTypes = [...config.certificateTypes]
    this.defaultFields = Object.assign(Object.create(null), config.defaultFields)
    this.includeTimestamp = config.includeTimestamp
  }

  /** The short identifier emitted by pre-0.6 releases. */
  static getLegacyCertificateType(): string {
    return toBase64(toArray(DEFAULT_CERTIFICATE_TYPE_SOURCE, 'utf8'))
  }

  /** The canonical 32-byte identifier emitted by new default certifiers. */
  static getCanonicalCertificateType(): string {
    return toBase64(sha256(toArray(DEFAULT_CERTIFICATE_TYPE_SOURCE, 'utf8')))
  }

  static async create(config?: CertifierConfig): Promise<Certifier> {
    const ownedConfig = config == null ? undefined : snapshotPlainDataRecord(config)
    if (config != null && ownedConfig == null)
      throw new TypeError('Invalid certifier configuration')
    let key: PrivateKey
    if (ownedConfig?.privateKey == null) {
      const bytes = Random(32)
      const hex = Array.from(bytes, (b: number) => b.toString(16).padStart(2, '0')).join('')
      key = new PrivateKey(hex, 'hex')
    } else {
      if (typeof ownedConfig.privateKey !== 'string') {
        throw new TypeError('Invalid certifier private key')
      }
      key = new PrivateKey(ownedConfig.privateKey, 'hex')
    }

    const defaultCanonicalType = Certifier.getCanonicalCertificateType()
    let certificateType = defaultCanonicalType
    let certificateTypes = uniqueCertificateTypes([
      defaultCanonicalType,
      Certifier.getLegacyCertificateType()
    ])
    if (ownedConfig?.certificateType != null) {
      try {
        certificateType = canonicalCertificateType(ownedConfig.certificateType)
        certificateTypes =
          certificateType === defaultCanonicalType
            ? uniqueCertificateTypes([certificateType, Certifier.getLegacyCertificateType()])
            : [certificateType]
      } catch {
        const legacyType = legacyCompatibleCertificateType(ownedConfig.certificateType)
        certificateType = toBase64(sha256(toArray(legacyType, 'base64')))
        certificateTypes = uniqueCertificateTypes([certificateType, legacyType])
      }
    }

    return new Certifier({
      privateKey: key,
      certificateType,
      certificateTypes,
      defaultFields: validateCredentialFields(ownedConfig?.defaultFields ?? { certified: 'true' }),
      includeTimestamp: ownedConfig?.includeTimestamp !== false
    })
  }

  getInfo(): { publicKey: string; certificateType: string } {
    return {
      publicKey: this.pubKey,
      certificateType: this.certType
    }
  }

  /** Identifiers for explicit offline migration of persisted pre-canonical records. */
  getCertificateTypeMigration(): { canonical: string; legacy: string[] } {
    return {
      canonical: this.certTypes[0],
      legacy: this.certTypes.slice(1)
    }
  }

  async certify(
    wallet: WalletCore,
    additionalFields?: Record<string, string>
  ): Promise<CertificateData> {
    try {
      const identityKey = wallet.getIdentityKey()

      const additional = validateCredentialFields(additionalFields ?? {})
      const fields = Object.assign(
        Object.create(null) as Record<string, string>,
        this.defaultFields,
        additional
      )
      if (this.includeTimestamp && fields.timestamp == null) {
        fields.timestamp = Math.floor(Date.now() / 1000).toString()
      }

      const masterCert = await MasterCertificate.issueCertificateForSubject(
        this.protoWallet,
        identityKey,
        fields,
        this.certType,
        async () => '00'.repeat(32) + '.0'
      )

      const certData = await validateCertificateData({
        type: masterCert.type,
        serialNumber: masterCert.serialNumber,
        subject: masterCert.subject,
        certifier: masterCert.certifier,
        revocationOutpoint: masterCert.revocationOutpoint,
        fields: masterCert.fields,
        signature: masterCert.signature as string,
        keyringForSubject: masterCert.masterKeyring
      })

      // Acquire certificate directly into the wallet
      const acquisition = {
        type: certData.type,
        certifier: certData.certifier,
        acquisitionProtocol: 'direct',
        fields: certData.fields,
        serialNumber: certData.serialNumber,
        revocationOutpoint: certData.revocationOutpoint,
        signature: certData.signature,
        keyringRevealer: 'certifier',
        keyringForSubject: certData.keyringForSubject
      } as const
      validateWalletArgs('acquireCertificate', acquisition)
      const acquisitionRequest = snapshotWalletResultRequest('acquireCertificate', acquisition)
      validateWalletResult(
        'acquireCertificate',
        await wallet.getClient().acquireCertificate(acquisition),
        acquisitionRequest
      )

      return certData
    } catch (error) {
      throw new Error(`Certification failed: ${(error as Error).message}`)
    }
  }
}

// ============================================================================
// Certificate methods that attach to a wallet
// ============================================================================

export function createCertificationMethods(core: WalletCore): {
  acquireCertificateFrom: (config: RemoteCertificateRequest) => Promise<CertificateData>
  listCertificatesFrom: (config: {
    certifiers: string[]
    types: string[]
    limit?: number
  }) => Promise<{ totalCertificates: number; certificates: any[] }>
  relinquishCert: (args: { type: string; serialNumber: string; certifier: string }) => Promise<void>
} {
  return {
    async acquireCertificateFrom(config: RemoteCertificateRequest): Promise<CertificateData> {
      try {
        return await acquireRemoteCertificate(core, config)
      } catch (error) {
        throw new Error(`Certificate acquisition failed: ${(error as Error).message}`)
      }
    },

    async listCertificatesFrom(config: {
      certifiers: string[]
      types: string[]
      limit?: number
    }): Promise<{ totalCertificates: number; certificates: any[] }> {
      try {
        const ownedConfig = snapshotPlainDataRecord(config)
        if (ownedConfig == null) throw new TypeError('Invalid certificate list configuration')
        const args = {
          certifiers: ownedConfig.certifiers as string[],
          types: ownedConfig.types as string[],
          limit: ownedConfig.limit == null ? 100 : (ownedConfig.limit as number)
        }
        validateWalletArgs('listCertificates', args)
        const request = snapshotWalletResultRequest('listCertificates', args)
        const result = validateWalletResult(
          'listCertificates',
          await core.getClient().listCertificates(args),
          request
        )
        return {
          totalCertificates: result.totalCertificates,
          certificates: [...result.certificates]
        }
      } catch (error) {
        throw new Error(`Failed to list certificates: ${(error as Error).message}`)
      }
    },

    async relinquishCert(args: {
      type: string
      serialNumber: string
      certifier: string
    }): Promise<void> {
      try {
        const ownedArgs = snapshotPlainDataRecord(args)
        if (ownedArgs == null) throw new TypeError('Invalid certificate relinquishment')
        const request = {
          type: ownedArgs.type as string,
          serialNumber: ownedArgs.serialNumber as string,
          certifier: ownedArgs.certifier as string
        }
        validateWalletArgs('relinquishCertificate', request)
        const binding = snapshotWalletResultRequest('relinquishCertificate', request)
        validateWalletResult(
          'relinquishCertificate',
          await core.getClient().relinquishCertificate(request),
          binding
        )
      } catch (error) {
        throw new Error(`Failed to relinquish certificate: ${(error as Error).message}`)
      }
    }
  }
}
