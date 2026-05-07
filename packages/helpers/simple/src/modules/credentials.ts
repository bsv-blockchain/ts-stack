import {
  ProtoWallet,
  PrivateKey,
  MasterCertificate,
  Utils,
  Random,
  Hash,
  Script,
  OP
} from '@bsv/sdk'
import { WalletCore } from '../core/WalletCore'
import {
  CertificateData,
  CredentialSchemaConfig,
  CredentialIssuerConfig,
  VerifiableCredential,
  VerifiablePresentation,
  VerificationResult,
  RevocationRecord,
  RevocationStore
} from '../core/types'
import { CredentialError } from '../core/errors'

// ============================================================================
// Constants
// ============================================================================

const VC_CONTEXT = 'https://www.w3.org/2018/credentials/v1'
const PROOF_TYPE = 'BSVMasterCertificateProof2024'
const REVOCATION_TYPE = 'BSVHashLockRevocation2024'

// ============================================================================
// CredentialSchema
// ============================================================================

export class CredentialSchema {
  private readonly config: CredentialSchemaConfig

  constructor (config: CredentialSchemaConfig) {
    this.config = {
      ...config,
      certificateTypeBase64: config.certificateTypeBase64 ?? Utils.toBase64(Utils.toArray(config.id, 'utf8'))
    }
  }

  /**
   * Validate field values against schema requirements.
   * Returns null if valid, or an error message string.
   */
  validate (values: Record<string, string>): string | null {
    // Check required fields
    for (const field of this.config.fields) {
      if (field.required === true && (values[field.key]?.trim() === '' || values[field.key]?.trim() == null)) {
        return `${field.label} is required`
      }
    }

    // Run custom validation
    if (this.config.validate != null) {
      return this.config.validate(values)
    }

    return null
  }

  /**
   * Merge computed fields into values.
   */
  computeFields (values: Record<string, string>): Record<string, string> {
    const computed = this.config.computedFields?.(values) ?? {}
    return { ...values, ...computed }
  }

  /**
   * Get schema metadata.
   */
  getInfo (): { id: string, name: string, description?: string, certificateTypeBase64: string, fieldCount: number } {
    return {
      id: this.config.id,
      name: this.config.name,
      description: this.config.description,
      certificateTypeBase64: this.config.certificateTypeBase64 as string,
      fieldCount: this.config.fields.length
    }
  }

  /** Get the full config. */
  getConfig (): CredentialSchemaConfig {
    return this.config
  }
}

// ============================================================================
// MemoryRevocationStore (browser / tests)
// ============================================================================

export class MemoryRevocationStore implements RevocationStore {
  private readonly records = new Map<string, RevocationRecord>()

  async save (serialNumber: string, record: RevocationRecord): Promise<void> {
    this.records.set(serialNumber, record)
  }

  async load (serialNumber: string): Promise<RevocationRecord | undefined> {
    return this.records.get(serialNumber)
  }

  async delete (serialNumber: string): Promise<void> {
    this.records.delete(serialNumber)
  }

  async has (serialNumber: string): Promise<boolean> {
    return this.records.has(serialNumber)
  }

  async findByOutpoint (outpoint: string): Promise<boolean> {
    for (const record of this.records.values()) {
      if (record.outpoint === outpoint) return true
    }
    return false
  }
}

// ============================================================================
// CredentialIssuer
// ============================================================================

export class CredentialIssuer {
  private readonly protoWallet: ProtoWallet
  private readonly privateKey: PrivateKey
  private readonly pubKey: string
  private readonly schemas: Map<string, CredentialSchema>
  private readonly revocationEnabled: boolean
  private readonly revocationWallet: any
  private readonly store: RevocationStore

  private constructor (config: {
    privateKey: PrivateKey
    schemas: Map<string, CredentialSchema>
    revocationEnabled: boolean
    revocationWallet: any
    store: RevocationStore
  }) {
    this.privateKey = config.privateKey
    this.protoWallet = new ProtoWallet(config.privateKey)
    this.pubKey = config.privateKey.toPublicKey().toString()
    this.schemas = config.schemas
    this.revocationEnabled = config.revocationEnabled
    this.revocationWallet = config.revocationWallet
    this.store = config.store
  }

  static async create (config: CredentialIssuerConfig): Promise<CredentialIssuer> {
    const privateKey = new PrivateKey(config.privateKey, 'hex')

    const schemas = new Map<string, CredentialSchema>()
    if (config.schemas != null) {
      for (const sc of config.schemas) {
        schemas.set(sc.id, new CredentialSchema(sc))
      }
    }

    const revocationEnabled = config.revocation?.enabled ?? false
    const revocationWallet = config.revocation?.wallet

    if (revocationEnabled && revocationWallet == null) {
      throw new CredentialError('Revocation enabled but no wallet provided')
    }

    // Default to MemoryRevocationStore (browser-safe).
    // For Node.js servers, pass a FileRevocationStore via revocation.store.
    const store: RevocationStore = (config.revocation as any)?.store ?? new MemoryRevocationStore()

    return new CredentialIssuer({
      privateKey,
      schemas,
      revocationEnabled,
      revocationWallet,
      store
    })
  }

  /**
   * Issue a Verifiable Credential.
   */
  async issue (
    subjectIdentityKey: string,
    schemaId: string,
    fields: Record<string, string>
  ): Promise<VerifiableCredential> {
    // Lookup schema
    const schema = this.schemas.get(schemaId)
    if (schema == null) {
      throw new CredentialError(`Unknown schema: ${schemaId}`)
    }

    // Validate
    const validationError = schema.validate(fields)
    if (validationError != null) {
      throw new CredentialError(`Validation failed: ${validationError}`)
    }

    // Compute fields
    const allFields = schema.computeFields(fields)

    // Create revocation UTXO if enabled
    let revocationOutpoint = '00'.repeat(32) + '.0'
    let revocationSecret = ''
    let revocationBeef: number[] = []

    if (this.revocationEnabled && this.revocationWallet != null) {
      const secretBytes = Random(32)
      revocationSecret = Utils.toHex(secretBytes)
      const hashBytes = Hash.sha256(secretBytes)

      const lockingScript = new Script()
        .writeOpCode(OP.OP_SHA256)
        .writeBin(Array.from(hashBytes))
        .writeOpCode(OP.OP_EQUAL)

      const result = await this.revocationWallet.createAction({
        description: 'Certificate revocation UTXO',
        outputs: [{
          lockingScript: lockingScript.toHex(),
          satoshis: 1,
          outputDescription: 'Revocation hash-lock',
          basket: 'revocation-utxos',
          tags: ['revocation']
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })

      if (result.txid == null || result.txid === '') {
        throw new CredentialError('Failed to create revocation UTXO: no txid returned')
      }

      revocationOutpoint = `${String(result.txid)}.0`
      revocationBeef = result.tx == null ? [] : Array.from(result.tx)
    }

    // Issue MasterCertificate
    const certType = schema.getInfo().certificateTypeBase64
    const masterCert = await MasterCertificate.issueCertificateForSubject(
      this.protoWallet,
      subjectIdentityKey,
      allFields,
      certType,
      async () => revocationOutpoint
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

    // Store revocation secret
    if (this.revocationEnabled && revocationSecret !== '') {
      await this.store.save(certData.serialNumber, {
        secret: revocationSecret,
        outpoint: revocationOutpoint,
        beef: revocationBeef
      })
    }

    // Wrap in W3C VC
    return toVerifiableCredential(certData, this.pubKey, {
      credentialType: schema.getInfo().name.replace(/\s+/g, '')
    })
  }

  /**
   * Verify a Verifiable Credential.
   */
  async verify (vc: VerifiableCredential): Promise<VerificationResult> {
    const errors: string[] = []

    // Check W3C context
    if (vc['@context'].length === 0 || !vc['@context'].includes(VC_CONTEXT)) {
      errors.push('Missing W3C VC context')
    }

    // Check type
    if (vc.type.length === 0 || !vc.type.includes('VerifiableCredential')) {
      errors.push('Missing VerifiableCredential type')
    }

    // Check proof
    if (vc.proof?.signatureValue == null || vc.proof.signatureValue === '') {
      errors.push('Missing proof or signature')
    }

    // Check underlying certificate
    if (vc._bsv?.certificate == null) {
      errors.push('Missing BSV certificate data')
    }

    // Check revocation status
    let revoked = false
    if (vc._bsv?.certificate != null) {
      const outpoint = vc._bsv.certificate.revocationOutpoint

      if (outpoint != null && outpoint !== '00'.repeat(32) + '.0') {
        // Check if we have the secret (unspent = not revoked)
        const hasRecord = await this.store.findByOutpoint(outpoint)
        revoked = !hasRecord
      }
    }

    if (revoked) {
      errors.push('Credential has been revoked')
    }

    return {
      valid: errors.length === 0,
      revoked,
      errors,
      issuer: vc.issuer,
      subject: vc.credentialSubject?.id,
      type: vc.type?.join(', ')
    }
  }

  /**
   * Revoke a credential by spending its hash-locked UTXO.
   */
  async revoke (serialNumber: string): Promise<{ txid: string }> {
    if (!this.revocationEnabled || this.revocationWallet == null) {
      throw new CredentialError('Revocation is not enabled')
    }

    const record = await this.store.load(serialNumber)
    if (record == null) {
      throw new CredentialError('Certificate already revoked or not found')
    }

    const secretBytes = Utils.toArray(record.secret, 'hex')
    const unlockingScript = new Script().writeBin(secretBytes).toHex()

    const result = await this.revocationWallet.createAction({
      description: 'Revoke certificate',
      inputBEEF: record.beef.length > 0 ? record.beef : undefined,
      inputs: [{
        outpoint: record.outpoint,
        unlockingScript,
        inputDescription: 'Spend revocation UTXO'
      }],
      outputs: [],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })

    if (result.txid == null || result.txid === '') {
      throw new CredentialError('Revocation transaction failed: no txid returned')
    }

    // Only delete after successful spend
    await this.store.delete(serialNumber)

    return { txid: result.txid as string }
  }

  /**
   * Check if a credential has been revoked.
   */
  async isRevoked (serialNumber: string): Promise<boolean> {
    const hasRecord = await this.store.has(serialNumber)
    return !hasRecord
  }

  /**
   * Get issuer info.
   */
  getInfo (): { publicKey: string, did: string, schemas: Array<{ id: string, name: string }> } {
    const schemaList: Array<{ id: string, name: string }> = []
    for (const [id, schema] of this.schemas) {
      const info = schema.getInfo()
      schemaList.push({ id, name: info.name })
    }

    return {
      publicKey: this.pubKey,
      did: `did:bsv:${this.pubKey}`,
      schemas: schemaList
    }
  }
}

// ============================================================================
// Standalone W3C VC/VP utilities
// ============================================================================

/**
 * Wrap a CertificateData into a W3C Verifiable Credential.
 */
export function toVerifiableCredential (
  cert: CertificateData,
  issuerKey: string,
  options?: { credentialType?: string }
): VerifiableCredential {
  const now = new Date().toISOString()
  const credentialType = options?.credentialType ?? 'BSVCertificate'

  return {
    '@context': [VC_CONTEXT],
    type: ['VerifiableCredential', credentialType],
    issuer: `did:bsv:${issuerKey}`,
    issuanceDate: now,
    credentialSubject: {
      id: `did:bsv:${cert.subject}`,
      ...cert.fields
    },
    credentialStatus: cert.revocationOutpoint === '00'.repeat(32) + '.0'
      ? undefined
      : {
          id: `bsv:${cert.revocationOutpoint}`,
          type: REVOCATION_TYPE
        },
    proof: {
      type: PROOF_TYPE,
      created: now,
      proofPurpose: 'assertionMethod',
      verificationMethod: `did:bsv:${issuerKey}#key-1`,
      signatureValue: cert.signature
    },
    _bsv: {
      certificate: cert
    }
  }
}

/**
 * Wrap an array of VCs into a W3C Verifiable Presentation.
 */
export function toVerifiablePresentation (
  credentials: VerifiableCredential[],
  holderKey: string
): VerifiablePresentation {
  const now = new Date().toISOString()

  return {
    '@context': [VC_CONTEXT],
    type: ['VerifiablePresentation'],
    holder: `did:bsv:${holderKey}`,
    verifiableCredential: credentials,
    proof: {
      type: PROOF_TYPE,
      created: now,
      proofPurpose: 'authentication',
      verificationMethod: `did:bsv:${holderKey}#key-1`
    }
  }
}

// ============================================================================
// Wallet-integrated credential methods
// ============================================================================

export function createCredentialMethods (core: WalletCore): {
  acquireCredential: (config: { serverUrl: string, schemaId?: string, fields?: Record<string, string>, replaceExisting?: boolean }) => Promise<VerifiableCredential>
  listCredentials: (config: { certifiers: string[], types: string[], limit?: number }) => Promise<VerifiableCredential[]>
  createPresentation: (credentials: VerifiableCredential[]) => VerifiablePresentation
} {
  return {
    /**
     * Acquire a Verifiable Credential from a remote issuer server.
     */
    async acquireCredential (config: {
      serverUrl: string
      schemaId?: string
      fields?: Record<string, string>
      replaceExisting?: boolean
    }): Promise<VerifiableCredential> {
      try {
        const client = core.getClient()

        // Fetch issuer info
        const infoRes = await fetch(`${config.serverUrl}?action=info`)
        if (!infoRes.ok) throw new Error(`Server returned ${infoRes.status}`)
        const info = await infoRes.json() as {
          certifierPublicKey: string
          certificateType: string
        }
        const { certifierPublicKey, certificateType } = info

        // Optionally revoke existing certs
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

        // Request certificate
        const certRes = await fetch(`${config.serverUrl}?action=certify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identityKey: core.getIdentityKey(),
            schemaId: config.schemaId,
            fields: config.fields
          })
        })
        if (!certRes.ok) {
          const errData = await certRes.json().catch(() => ({})) as { error?: string }
          throw new Error(errData.error ?? `Server returned ${certRes.status}`)
        }
        const certData = await certRes.json() as CertificateData

        // Acquire into wallet
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

        // Wrap in W3C VC
        return toVerifiableCredential(certData, certifierPublicKey)
      } catch (error) {
        throw new CredentialError(`Credential acquisition failed: ${(error as Error).message}`)
      }
    },

    /**
     * List wallet certificates wrapped as Verifiable Credentials.
     */
    async listCredentials (config: {
      certifiers: string[]
      types: string[]
      limit?: number
    }): Promise<VerifiableCredential[]> {
      try {
        const result = await core.getClient().listCertificates({
          certifiers: config.certifiers,
          types: config.types,
          limit: config.limit ?? 100
        })

        const certs = result.certificates ?? []
        return certs.map((cert: any) => {
          const issuerKey = (cert.certifier ?? config.certifiers[0]) as string
          return toVerifiableCredential(
            {
              type: cert.type,
              serialNumber: cert.serialNumber,
              subject: cert.subject,
              certifier: cert.certifier,
              revocationOutpoint: cert.revocationOutpoint ?? '00'.repeat(32) + '.0',
              fields: cert.fields ?? {},
              signature: cert.signature ?? '',
              keyringForSubject: cert.keyringForSubject ?? {}
            },
            issuerKey
          )
        })
      } catch (error) {
        throw new CredentialError(`Failed to list credentials: ${(error as Error).message}`)
      }
    },

    /**
     * Wrap Verifiable Credentials into a Verifiable Presentation.
     */
    createPresentation (credentials: VerifiableCredential[]): VerifiablePresentation {
      return toVerifiablePresentation(credentials, core.getIdentityKey())
    }
  }
}
