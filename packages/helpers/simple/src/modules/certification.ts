import {
  ProtoWallet,
  PrivateKey,
  MasterCertificate,
  Utils,
  Random
} from '@bsv/sdk'
import { WalletCore } from '../core/WalletCore'
import { CertificateData } from '../core/types'

// ============================================================================
// Standalone Certifier (no wallet dependency for construction)
// ============================================================================

export class Certifier {
  private readonly protoWallet: ProtoWallet
  private readonly pubKey: string
  private readonly certType: string
  private readonly defaultFields: Record<string, string>
  private readonly includeTimestamp: boolean

  private constructor (config: {
    privateKey: PrivateKey
    certificateType: string
    defaultFields: Record<string, string>
    includeTimestamp: boolean
  }) {
    this.protoWallet = new ProtoWallet(config.privateKey)
    this.pubKey = config.privateKey.toPublicKey().toString()
    this.certType = config.certificateType
    this.defaultFields = config.defaultFields
    this.includeTimestamp = config.includeTimestamp
  }

  static async create (config?: {
    privateKey?: string
    certificateType?: string
    defaultFields?: Record<string, string>
    includeTimestamp?: boolean
  }): Promise<Certifier> {
    let key: PrivateKey
    if (config?.privateKey != null) {
      key = new PrivateKey(config.privateKey, 'hex')
    } else {
      const bytes = Random(32)
      const hex = Array.from(bytes, (b: number) => b.toString(16).padStart(2, '0')).join('')
      key = new PrivateKey(hex, 'hex')
    }

    return new Certifier({
      privateKey: key,
      certificateType: config?.certificateType ?? Utils.toBase64(Utils.toArray('certification', 'utf8')),
      defaultFields: config?.defaultFields ?? { certified: 'true' },
      includeTimestamp: config?.includeTimestamp !== false
    })
  }

  getInfo (): { publicKey: string, certificateType: string } {
    return {
      publicKey: this.pubKey,
      certificateType: this.certType
    }
  }

  async certify (wallet: WalletCore, additionalFields?: Record<string, string>): Promise<CertificateData> {
    try {
      const identityKey = wallet.getIdentityKey()

      const fields: Record<string, string> = { ...this.defaultFields, ...additionalFields }
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

      const certData: CertificateData = {
        type: masterCert.type,
        serialNumber: masterCert.serialNumber,
        subject: masterCert.subject,
        certifier: masterCert.certifier,
        revocationOutpoint: masterCert.revocationOutpoint,
        fields: masterCert.fields,
        signature: masterCert.signature as string,
        keyringForSubject: masterCert.masterKeyring
      }

      // Acquire certificate directly into the wallet
      await wallet.getClient().acquireCertificate({
        type: certData.type,
        certifier: certData.certifier,
        acquisitionProtocol: 'direct',
        fields: certData.fields,
        serialNumber: certData.serialNumber,
        revocationOutpoint: certData.revocationOutpoint,
        signature: certData.signature,
        keyringRevealer: 'certifier',
        keyringForSubject: certData.keyringForSubject
      })

      return certData
    } catch (error) {
      throw new Error(`Certification failed: ${(error as Error).message}`)
    }
  }
}

// ============================================================================
// Certificate methods that attach to a wallet
// ============================================================================

export function createCertificationMethods (core: WalletCore): {
  acquireCertificateFrom: (config: { serverUrl: string, replaceExisting?: boolean }) => Promise<CertificateData>
  listCertificatesFrom: (config: { certifiers: string[], types: string[], limit?: number }) => Promise<{ totalCertificates: number, certificates: any[] }>
  relinquishCert: (args: { type: string, serialNumber: string, certifier: string }) => Promise<void>
} {
  return {
    async acquireCertificateFrom (config: {
      serverUrl: string
      replaceExisting?: boolean
    }): Promise<any> {
      try {
        const client = core.getClient()

        const infoRes = await fetch(`${config.serverUrl}?action=info`)
        if (!infoRes.ok) throw new Error(`Server returned ${infoRes.status}`)
        const info = await infoRes.json() as { certifierPublicKey: string, certificateType: string }
        const { certifierPublicKey, certificateType } = info

        if (config.replaceExisting !== false) {
          const existing = await client.listCertificates({
            certifiers: [certifierPublicKey],
            types: [certificateType],
            limit: 100
          })
          if (existing.certificates.length > 0) {
            for (const cert of existing.certificates) {
              try {
                await client.relinquishCertificate({
                  type: certificateType,
                  serialNumber: cert.serialNumber,
                  certifier: certifierPublicKey
                })
              } catch {}
            }
          }
        }

        const certRes = await fetch(`${config.serverUrl}?action=certify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identityKey: core.getIdentityKey() })
        })
        if (!certRes.ok) {
          const errData = await certRes.json().catch(() => ({})) as { error?: string }
          throw new Error(errData.error ?? `Server returned ${certRes.status}`)
        }
        const certData = await certRes.json() as CertificateData

        await client.acquireCertificate({
          type: certData.type,
          certifier: certData.certifier,
          acquisitionProtocol: 'direct',
          fields: certData.fields,
          serialNumber: certData.serialNumber,
          revocationOutpoint: certData.revocationOutpoint,
          signature: certData.signature,
          keyringRevealer: 'certifier',
          keyringForSubject: certData.keyringForSubject
        })

        return certData
      } catch (error) {
        throw new Error(`Certificate acquisition failed: ${(error as Error).message}`)
      }
    },

    async listCertificatesFrom (config: {
      certifiers: string[]
      types: string[]
      limit?: number
    }): Promise<{ totalCertificates: number, certificates: any[] }> {
      try {
        const result = await core.getClient().listCertificates({
          certifiers: config.certifiers,
          types: config.types,
          limit: config.limit ?? 100
        })
        return {
          totalCertificates: result.totalCertificates,
          certificates: result.certificates ?? []
        }
      } catch (error) {
        throw new Error(`Failed to list certificates: ${(error as Error).message}`)
      }
    },

    async relinquishCert (args: {
      type: string
      serialNumber: string
      certifier: string
    }): Promise<void> {
      try {
        await core.getClient().relinquishCertificate(args)
      } catch (error) {
        throw new Error(`Failed to relinquish certificate: ${(error as Error).message}`)
      }
    }
  }
}
