import { compareCodeUnits } from '../core/code-unit-order'
import {
  ProtoWallet,
  PrivateKey,
  MasterCertificate,
  Random,
  Script,
  OP,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import {
  canonicalCertificateType,
  canonicalIdentityKey,
  legacyCompatibleCertificateType,
  snapshotPlainDataRecord,
  validateCertificateData,
  validateCredentialFields,
  validateSchemaId
} from '../core/certificate-validation'
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
import { acquireRemoteCertificate, RemoteCertificateRequest } from './certificate-service'

// ============================================================================
// Constants
// ============================================================================

const VC_CONTEXT = 'https://www.w3.org/2018/credentials/v1'
const PROOF_TYPE = 'BSVMasterCertificateProof2024'
const REVOCATION_TYPE = 'BSVHashLockRevocation2024'
const ZERO_REVOCATION_OUTPOINT = `${'00'.repeat(32)}.0`
const CREDENTIAL_FIELD_TYPES = new Set([
  'text',
  'email',
  'date',
  'number',
  'textarea',
  'checkbox',
  'select'
])

function uniqueCertificateTypes(types: string[]): string[] {
  return [...new Set(types)]
}

function denseBytes(value: unknown, maximum: number, name: string): number[] {
  if (!Array.isArray(value) || value.length > maximum) throw new CredentialError(`Invalid ${name}`)
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      Object.getOwnPropertyDescriptor(descriptor, 'value') == null ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new CredentialError(`Invalid ${name}`)
    }
    bytes.push(descriptor.value as number)
  }
  return bytes
}

function snapshotRevocationRecord(value: unknown): RevocationRecord {
  const record = snapshotPlainDataRecord(value)
  if (record == null || typeof record.secret !== 'string' || typeof record.outpoint !== 'string') {
    throw new CredentialError('Invalid credential revocation record')
  }
  return {
    secret: record.secret,
    outpoint: record.outpoint,
    beef: denseBytes(record.beef, 64 * 1024 * 1024, 'credential revocation BEEF')
  }
}

function boundedSchemaText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    value !== value.trim()
  ) {
    throw new CredentialError(`Invalid credential schema ${name}`)
  }
  return value
}

function boundedSchemaOptionalString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maximum) {
    throw new CredentialError(`Invalid credential schema ${name}`)
  }
  return value
}

function denseOwnArray(value: unknown, maximum: number, message: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new CredentialError(message)
  const snapshot: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new CredentialError(message)
    }
    snapshot.push(descriptor.value)
  }
  return snapshot
}

function ownSchemaConfig(config: CredentialSchemaConfig): CredentialSchemaConfig {
  const record = snapshotPlainDataRecord(config)
  if (record == null) {
    throw new CredentialError('Credential schema must contain at most 100 declared fields')
  }
  const rawFields = denseOwnArray(
    record.fields,
    100,
    'Credential schema must contain at most 100 declared fields'
  )
  const id = validateSchemaId(record.id)
  if (id == null) throw new CredentialError('Credential schema identifier is required')
  const keys = new Set<string>()
  const fields = rawFields.map(rawField => {
    const field = snapshotPlainDataRecord(rawField)
    if (field == null) throw new CredentialError('Invalid credential field schema')
    const key = boundedSchemaText(field.key, 'field key', 50)
    if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new CredentialError('Credential schema field keys must be safe and unique')
    }
    keys.add(key)
    if (typeof field.type !== 'string' || !CREDENTIAL_FIELD_TYPES.has(field.type)) {
      throw new CredentialError(`Invalid credential field type for ${key}`)
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw new CredentialError(`Invalid credential required flag for ${key}`)
    }
    const options =
      field.options == null
        ? undefined
        : denseOwnArray(field.options, 100, `Invalid credential field options for ${key}`).map(
            rawOption => {
              const option = snapshotPlainDataRecord(rawOption)
              if (option == null) {
                throw new CredentialError(`Invalid credential field options for ${key}`)
              }
              return Object.assign(Object.create(null), {
                value: boundedSchemaOptionalString(option.value, 'option value', 256),
                label: boundedSchemaOptionalString(option.label, 'option label', 256)
              })
            }
          )
    if (
      options != null &&
      (options.length > 100 || new Set(options.map(option => option.value)).size !== options.length)
    ) {
      throw new CredentialError(`Credential field options for ${key} must be bounded and unique`)
    }
    return Object.assign(Object.create(null), {
      key,
      label: boundedSchemaOptionalString(field.label, 'field label', 256),
      type: field.type as CredentialSchemaConfig['fields'][number]['type'],
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.placeholder === undefined
        ? {}
        : {
            placeholder: boundedSchemaOptionalString(field.placeholder, 'field placeholder', 512)
          }),
      ...(field.format === undefined
        ? {}
        : { format: boundedSchemaOptionalString(field.format, 'field format', 256) }),
      ...(field.helpText === undefined
        ? {}
        : { helpText: boundedSchemaOptionalString(field.helpText, 'field help text', 1024) }),
      ...(field.group === undefined
        ? {}
        : { group: boundedSchemaOptionalString(field.group, 'field group', 50) }),
      ...(options == null ? {} : { options })
    })
  })
  const fieldGroups =
    record.fieldGroups == null
      ? undefined
      : denseOwnArray(record.fieldGroups, 100, 'Invalid credential field groups').map(rawGroup => {
          const group = snapshotPlainDataRecord(rawGroup)
          if (group == null) throw new CredentialError('Invalid credential field groups')
          return Object.assign(Object.create(null), {
            key: boundedSchemaText(group.key, 'field group key', 50),
            label: boundedSchemaOptionalString(group.label, 'field group label', 256)
          })
        })
  if (record.validate != null && typeof record.validate !== 'function') {
    throw new CredentialError('Invalid credential schema validation callback')
  }
  if (record.computedFields != null && typeof record.computedFields !== 'function') {
    throw new CredentialError('Invalid credential schema computed-fields callback')
  }
  return Object.assign(Object.create(null) as CredentialSchemaConfig, {
    id,
    name: boundedSchemaOptionalString(record.name, 'name', 128),
    fields,
    ...(record.description === undefined
      ? {}
      : { description: boundedSchemaOptionalString(record.description, 'description', 2048) }),
    ...(record.certificateTypeBase64 === undefined
      ? {}
      : { certificateTypeBase64: record.certificateTypeBase64 as string }),
    ...(record.legacyCertificateTypesBase64 === undefined
      ? {}
      : { legacyCertificateTypesBase64: record.legacyCertificateTypesBase64 as string[] }),
    ...(fieldGroups == null ? {} : { fieldGroups }),
    ...(record.validate === undefined
      ? {}
      : { validate: record.validate as CredentialSchemaConfig['validate'] }),
    ...(record.computedFields === undefined
      ? {}
      : { computedFields: record.computedFields as CredentialSchemaConfig['computedFields'] })
  })
}

function exactStringArray(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  for (let index = 0; index < expected.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      Object.getOwnPropertyDescriptor(descriptor, 'value') == null ||
      descriptor.value !== expected[index]
    ) {
      return false
    }
  }
  return true
}

function canonicalIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    return undefined
  return value
}

function credentialSubjectMatches(value: unknown, certificate: CertificateData): boolean {
  const record = snapshotPlainDataRecord(value)
  if (record == null || record.id !== `did:bsv:${certificate.subject}`) return false
  const expectedKeys = ['id', ...Object.keys(certificate.fields)].sort(compareCodeUnits)
  const actualKeys = Object.keys(record).sort(compareCodeUnits)
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index]) &&
    Object.entries(certificate.fields).every(([key, field]) => record[key] === field)
  )
}

// ============================================================================
// CredentialSchema
// ============================================================================

export class CredentialSchema {
  private readonly config: CredentialSchemaConfig
  private readonly certificateTypes: string[]

  constructor(config: CredentialSchemaConfig) {
    const ownedConfig = ownSchemaConfig(config)
    const defaultCanonicalType = CredentialSchema.getCanonicalCertificateType(ownedConfig.id)
    const defaultLegacyType = CredentialSchema.getLegacyCertificateType(ownedConfig.id)
    let certificateType = defaultCanonicalType
    let legacyTypes = [defaultLegacyType]
    if (ownedConfig.certificateTypeBase64 != null) {
      try {
        certificateType = canonicalCertificateType(ownedConfig.certificateTypeBase64)
        legacyTypes = certificateType === defaultCanonicalType ? [defaultLegacyType] : []
      } catch {
        const legacyType = legacyCompatibleCertificateType(ownedConfig.certificateTypeBase64)
        certificateType = toBase64(sha256(toArray(legacyType, 'base64')))
        legacyTypes = [legacyType]
      }
    }
    if (ownedConfig.legacyCertificateTypesBase64 != null) {
      legacyTypes.push(
        ...denseOwnArray(
          ownedConfig.legacyCertificateTypesBase64,
          100,
          'Invalid legacy certificate types'
        ).map(legacyCompatibleCertificateType)
      )
    }
    legacyTypes = uniqueCertificateTypes(legacyTypes).filter(type => type !== certificateType)
    this.config = Object.assign(Object.create(null) as CredentialSchemaConfig, {
      ...ownedConfig,
      certificateTypeBase64: certificateType,
      ...(legacyTypes.length === 0 ? {} : { legacyCertificateTypesBase64: legacyTypes })
    })
    this.certificateTypes = [certificateType, ...legacyTypes]
  }

  /** The short identifier emitted by pre-0.6 schema defaults. */
  static getLegacyCertificateType(schemaId: string): string {
    const id = validateSchemaId(schemaId)
    if (id == null) throw new CredentialError('Credential schema identifier is required')
    return toBase64(toArray(id, 'utf8'))
  }

  /** The canonical 32-byte identifier emitted by new schema defaults. */
  static getCanonicalCertificateType(schemaId: string): string {
    const id = validateSchemaId(schemaId)
    if (id == null) throw new CredentialError('Credential schema identifier is required')
    return toBase64(sha256(toArray(id, 'utf8')))
  }

  /**
   * Validate field values against schema requirements.
   * Returns null if valid, or an error message string.
   */
  validate(values: Record<string, string>): string | null {
    let normalized: Record<string, string>
    try {
      normalized = validateCredentialFields(values)
    } catch {
      return 'Credential fields are malformed'
    }
    const fields = new Map(this.config.fields.map(field => [field.key, field]))
    for (const key of Object.keys(normalized)) {
      if (!fields.has(key)) return `Credential field ${key} is not declared by the schema`
    }

    // Check required fields
    for (const field of this.config.fields) {
      const value = normalized[field.key]
      if (field.required === true && (value?.trim() === '' || value?.trim() == null)) {
        return `${field.label} is required`
      }
      if (value == null || value === '') continue
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return `${field.label} must be a valid email address`
      }
      if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return `${field.label} must be a YYYY-MM-DD date`
      }
      if (
        field.type === 'number' &&
        (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
      ) {
        return `${field.label} must be a finite number`
      }
      if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
        return `${field.label} must be true or false`
      }
      if (
        field.type === 'select' &&
        (field.options == null || !field.options.some(option => option.value === value))
      ) {
        return `${field.label} must be one of the declared options`
      }
    }

    // Run custom validation
    if (this.config.validate != null) {
      const result = this.config.validate(
        Object.assign(Object.create(null) as Record<string, string>, normalized)
      )
      if (result == null) return null
      if (typeof result !== 'string' || result.length === 0 || result.length > 512) {
        return 'Credential schema validation failed'
      }
      return result
    }

    return null
  }

  /**
   * Merge computed fields into values.
   */
  computeFields(values: Record<string, string>): Record<string, string> {
    const ownedValues = validateCredentialFields(values)
    const callbackValues = Object.assign(Object.create(null) as Record<string, string>, ownedValues)
    const computed = validateCredentialFields(this.config.computedFields?.(callbackValues) ?? {})
    return Object.assign(Object.create(null) as Record<string, string>, ownedValues, computed)
  }

  /**
   * Get schema metadata.
   */
  getInfo(): {
    id: string
    name: string
    description?: string
    certificateTypeBase64: string
    fieldCount: number
  } {
    return {
      id: this.config.id,
      name: this.config.name,
      description: this.config.description,
      certificateTypeBase64: this.config.certificateTypeBase64 as string,
      fieldCount: this.config.fields.length
    }
  }

  /** Identifiers for explicit offline migration of persisted pre-canonical records. */
  getCertificateTypeMigration(): { canonical: string; legacy: string[] } {
    return {
      canonical: this.certificateTypes[0],
      legacy: this.certificateTypes.slice(1)
    }
  }

  /** Get the full config. */
  getConfig(): CredentialSchemaConfig {
    return {
      ...this.config,
      fields: this.config.fields.map(field => ({
        ...field,
        ...(field.options == null ? {} : { options: field.options.map(option => ({ ...option })) })
      })),
      ...(this.config.fieldGroups == null
        ? {}
        : { fieldGroups: this.config.fieldGroups.map(group => ({ ...group })) }),
      ...(this.config.legacyCertificateTypesBase64 == null
        ? {}
        : { legacyCertificateTypesBase64: [...this.config.legacyCertificateTypesBase64] })
    }
  }
}

// ============================================================================
// MemoryRevocationStore (browser / tests)
// ============================================================================

export class MemoryRevocationStore implements RevocationStore {
  private readonly records = new Map<string, RevocationRecord>()

  async save(serialNumber: string, record: RevocationRecord): Promise<void> {
    this.records.set(serialNumber, snapshotRevocationRecord(record))
  }

  async load(serialNumber: string): Promise<RevocationRecord | undefined> {
    const record = this.records.get(serialNumber)
    return record == null ? undefined : { ...record, beef: [...record.beef] }
  }

  async delete(serialNumber: string): Promise<void> {
    this.records.delete(serialNumber)
  }

  async has(serialNumber: string): Promise<boolean> {
    return this.records.has(serialNumber)
  }

  async findByOutpoint(outpoint: string): Promise<boolean> {
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

  private constructor(config: {
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

  static async create(config: CredentialIssuerConfig): Promise<CredentialIssuer> {
    const ownedConfig = snapshotPlainDataRecord(config)
    if (ownedConfig == null || typeof ownedConfig.privateKey !== 'string') {
      throw new CredentialError('Invalid credential issuer configuration')
    }
    const privateKey = new PrivateKey(ownedConfig.privateKey, 'hex')

    const schemas = new Map<string, CredentialSchema>()
    if (ownedConfig.schemas != null) {
      const configuredSchemas = denseOwnArray(
        ownedConfig.schemas,
        100,
        'Credential issuer schemas must be a dense array of at most 100 schemas'
      )
      for (const value of configuredSchemas) {
        const schema = new CredentialSchema(value as CredentialSchemaConfig)
        const schemaId = schema.getInfo().id
        if (schemaId == null || schemas.has(schemaId)) {
          throw new CredentialError('Credential schema identifiers must be non-empty and unique')
        }
        schemas.set(schemaId, schema)
      }
    }

    const revocation =
      ownedConfig.revocation == null ? undefined : snapshotPlainDataRecord(ownedConfig.revocation)
    if (ownedConfig.revocation != null && revocation == null) {
      throw new CredentialError('Invalid credential revocation configuration')
    }
    if (revocation?.enabled != null && typeof revocation.enabled !== 'boolean') {
      throw new CredentialError('Invalid credential revocation configuration')
    }
    const revocationEnabled = revocation?.enabled === true
    const revocationWallet = revocation?.wallet

    if (revocationEnabled && revocationWallet == null) {
      throw new CredentialError('Revocation enabled but no wallet provided')
    }

    // Default to MemoryRevocationStore (browser-safe).
    // For Node.js servers, pass a FileRevocationStore via revocation.store.
    const store = (revocation?.store as RevocationStore | undefined) ?? new MemoryRevocationStore()

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
  async issue(
    subjectIdentityKey: string,
    schemaId: string,
    fields: Record<string, string>
  ): Promise<VerifiableCredential> {
    const subject = canonicalIdentityKey(subjectIdentityKey, 'credential subject')
    const normalizedSchemaId = validateSchemaId(schemaId)
    if (normalizedSchemaId == null) throw new CredentialError('Credential schema is required')
    const requestedFields = validateCredentialFields(fields)

    // Lookup schema
    const schema = this.schemas.get(normalizedSchemaId)
    if (schema == null) {
      throw new CredentialError(`Unknown schema: ${normalizedSchemaId}`)
    }

    // Validate
    const validationError = schema.validate(requestedFields)
    if (validationError != null) {
      throw new CredentialError(`Validation failed: ${validationError}`)
    }

    // Compute fields
    const allFields = validateCredentialFields(schema.computeFields(requestedFields))

    // Create revocation UTXO if enabled
    let revocationOutpoint = '00'.repeat(32) + '.0'
    let revocationSecret = ''
    let revocationBeef: number[] = []

    if (this.revocationEnabled && this.revocationWallet != null) {
      const secretBytes = Random(32)
      revocationSecret = toHex(secretBytes)
      const hashBytes = sha256(secretBytes)

      const lockingScript = new Script()
        .writeOpCode(OP.OP_SHA256)
        .writeBin(Array.from(hashBytes))
        .writeOpCode(OP.OP_EQUAL)

      const result = snapshotPlainDataRecord(
        await this.revocationWallet.createAction({
          description: 'Certificate revocation UTXO',
          outputs: [
            {
              lockingScript: lockingScript.toHex(),
              satoshis: 1,
              outputDescription: 'Revocation hash-lock',
              basket: 'revocation-utxos',
              tags: ['revocation']
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        })
      )

      if (
        result == null ||
        typeof result.txid !== 'string' ||
        !/^[0-9a-f]{64}$/.test(result.txid)
      ) {
        throw new CredentialError('Failed to create revocation UTXO: no txid returned')
      }

      revocationOutpoint = `${result.txid}.0`
      revocationBeef =
        result.tx == null
          ? []
          : denseBytes(result.tx, 64 * 1024 * 1024, 'credential revocation BEEF')
    }

    // Issue MasterCertificate
    const certType = schema.getInfo().certificateTypeBase64
    const masterCert = await MasterCertificate.issueCertificateForSubject(
      this.protoWallet,
      subject,
      allFields,
      certType,
      async () => revocationOutpoint
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
  async verify(vc: VerifiableCredential): Promise<VerificationResult> {
    const errors: string[] = []
    let certificate: CertificateData | undefined
    let credentialType: string | undefined
    try {
      const credential = snapshotPlainDataRecord(vc)
      const bsv = snapshotPlainDataRecord(credential?._bsv)
      if (credential == null || bsv == null) throw new TypeError('Invalid credential')
      const legacyCertificateTypes = uniqueCertificateTypes(
        [...this.schemas.values()].flatMap(schema => schema.getCertificateTypeMigration().legacy)
      )
      certificate = await validateCertificateData(
        bsv.certificate,
        { certifier: this.pubKey },
        { legacyCertificateTypes }
      )
      const schema = [...this.schemas.values()].find(
        candidate =>
          certificate != null &&
          [
            candidate.getCertificateTypeMigration().canonical,
            ...candidate.getCertificateTypeMigration().legacy
          ].includes(certificate.type)
      )
      if (schema == null) throw new TypeError('Unknown credential schema')
      credentialType = schema.getInfo().name.replace(/\s+/g, '')
      const issuedAt = canonicalIsoDate(credential.issuanceDate)
      const proof = snapshotPlainDataRecord(credential.proof)
      const status =
        credential.credentialStatus == null
          ? undefined
          : snapshotPlainDataRecord(credential.credentialStatus)
      const expectedStatus =
        certificate.revocationOutpoint === ZERO_REVOCATION_OUTPOINT
          ? credential.credentialStatus == null
          : status != null &&
            status.id === `bsv:${certificate.revocationOutpoint}` &&
            status.type === REVOCATION_TYPE
      if (
        !exactStringArray(credential['@context'], [VC_CONTEXT]) ||
        !exactStringArray(credential.type, ['VerifiableCredential', credentialType]) ||
        credential.id != null ||
        credential.expirationDate != null ||
        credential.issuer !== `did:bsv:${certificate.certifier}` ||
        issuedAt == null ||
        !credentialSubjectMatches(credential.credentialSubject, certificate) ||
        !expectedStatus ||
        proof == null ||
        proof.type !== PROOF_TYPE ||
        proof.created !== issuedAt ||
        proof.proofPurpose !== 'assertionMethod' ||
        proof.verificationMethod !== `did:bsv:${certificate.certifier}#key-1` ||
        proof.signatureValue !== certificate.signature
      ) {
        throw new TypeError('Credential wrapper does not match its signed certificate')
      }
    } catch {
      errors.push('Credential structure or signature is invalid')
    }

    let revoked = false
    if (
      certificate != null &&
      errors.length === 0 &&
      certificate.revocationOutpoint !== ZERO_REVOCATION_OUTPOINT
    ) {
      try {
        const hasRecord = await this.store.findByOutpoint(certificate.revocationOutpoint)
        if (hasRecord === true) revoked = false
        else if (hasRecord === false) revoked = true
        else errors.push('Credential revocation status is unavailable')
      } catch {
        errors.push('Credential revocation status is unavailable')
      }
    }

    if (revoked) {
      errors.push('Credential has been revoked')
    }

    return {
      valid: errors.length === 0,
      revoked,
      errors,
      ...(certificate == null ? {} : { issuer: `did:bsv:${certificate.certifier}` }),
      ...(certificate == null ? {} : { subject: `did:bsv:${certificate.subject}` }),
      ...(credentialType == null ? {} : { type: `VerifiableCredential, ${credentialType}` })
    }
  }

  /**
   * Revoke a credential by spending its hash-locked UTXO.
   */
  async revoke(serialNumber: string): Promise<{ txid: string }> {
    if (!this.revocationEnabled || this.revocationWallet == null) {
      throw new CredentialError('Revocation is not enabled')
    }

    const loadedRecord = await this.store.load(serialNumber)
    if (loadedRecord == null) {
      throw new CredentialError('Certificate already revoked or not found')
    }
    const record = snapshotRevocationRecord(loadedRecord)
    const outpointMatch = /^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/.exec(record.outpoint)
    if (
      !/^[0-9a-f]{64}$/.test(record.secret) ||
      outpointMatch == null ||
      Number(outpointMatch[2]) > 0xffffffff
    ) {
      throw new CredentialError('Invalid credential revocation record')
    }

    const secretBytes = toArray(record.secret, 'hex')
    const unlockingScript = new Script().writeBin(secretBytes).toHex()

    const result = snapshotPlainDataRecord(
      await this.revocationWallet.createAction({
        description: 'Revoke certificate',
        inputBEEF: record.beef.length > 0 ? record.beef : undefined,
        inputs: [
          {
            outpoint: record.outpoint,
            unlockingScript,
            inputDescription: 'Spend revocation UTXO'
          }
        ],
        outputs: [],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
    )

    if (result == null || typeof result.txid !== 'string' || !/^[0-9a-f]{64}$/.test(result.txid)) {
      throw new CredentialError('Revocation transaction failed: no txid returned')
    }

    // Only delete after successful spend
    await this.store.delete(serialNumber)

    return { txid: result.txid }
  }

  /**
   * Check if a credential has been revoked.
   */
  async isRevoked(serialNumber: string): Promise<boolean> {
    const hasRecord = await this.store.has(serialNumber)
    return !hasRecord
  }

  /**
   * Get issuer info.
   */
  getInfo(): {
    publicKey: string
    did: string
    schemas: Array<{ id: string; name: string; certificateTypeBase64: string }>
  } {
    const schemaList: Array<{ id: string; name: string; certificateTypeBase64: string }> = []
    for (const [id, schema] of this.schemas) {
      const info = schema.getInfo()
      schemaList.push({
        id,
        name: info.name,
        certificateTypeBase64: info.certificateTypeBase64
      })
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

function requiredCertificateString(
  record: Record<string, unknown>,
  key: keyof CertificateData
): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 * 1024) {
    throw new TypeError(`Invalid certificate ${key}`)
  }
  return value
}

function snapshotCertificateForCredential(value: unknown): CertificateData {
  const record = snapshotPlainDataRecord(value)
  if (record == null) throw new TypeError('Invalid certificate data')
  let type: string
  try {
    type = canonicalCertificateType(record.type)
  } catch {
    type = legacyCompatibleCertificateType(record.type)
  }
  return Object.assign(Object.create(null) as CertificateData, {
    type,
    serialNumber: requiredCertificateString(record, 'serialNumber'),
    subject: canonicalIdentityKey(record.subject, 'certificate subject'),
    certifier: canonicalIdentityKey(record.certifier, 'certificate certifier'),
    revocationOutpoint: requiredCertificateString(record, 'revocationOutpoint'),
    fields: validateCredentialFields(record.fields),
    signature: requiredCertificateString(record, 'signature'),
    keyringForSubject: validateCredentialFields(record.keyringForSubject)
  })
}

/**
 * Wrap a CertificateData into a W3C Verifiable Credential.
 */
export function toVerifiableCredential(
  cert: CertificateData,
  issuerKey: string,
  options?: { credentialType?: string }
): VerifiableCredential {
  const ownedCertificate = snapshotCertificateForCredential(cert)
  const ownedOptions =
    options == null
      ? (Object.create(null) as Record<string, unknown>)
      : snapshotPlainDataRecord(options)
  if (ownedOptions == null) throw new TypeError('Invalid verifiable credential options')
  const now = new Date().toISOString()
  const credentialType = ownedOptions.credentialType ?? 'BSVCertificate'
  if (
    typeof credentialType !== 'string' ||
    credentialType.length === 0 ||
    new TextEncoder().encode(credentialType).byteLength > 256
  ) {
    throw new TypeError('Invalid verifiable credential type')
  }
  const canonicalIssuerKey = canonicalIdentityKey(issuerKey, 'credential issuer')
  const fields = ownedCertificate.fields

  return {
    '@context': [VC_CONTEXT],
    type: ['VerifiableCredential', credentialType],
    issuer: `did:bsv:${canonicalIssuerKey}`,
    issuanceDate: now,
    credentialSubject: {
      id: `did:bsv:${ownedCertificate.subject}`,
      ...fields
    },
    credentialStatus:
      ownedCertificate.revocationOutpoint === ZERO_REVOCATION_OUTPOINT
        ? undefined
        : {
            id: `bsv:${ownedCertificate.revocationOutpoint}`,
            type: REVOCATION_TYPE
          },
    proof: {
      type: PROOF_TYPE,
      created: now,
      proofPurpose: 'assertionMethod',
      verificationMethod: `did:bsv:${canonicalIssuerKey}#key-1`,
      signatureValue: ownedCertificate.signature
    },
    _bsv: {
      certificate: ownedCertificate
    }
  }
}

/**
 * Wrap an array of VCs into an unsigned W3C presentation-shaped envelope.
 *
 * The current synchronous API has no holder wallet, verifier challenge, or
 * audience and therefore cannot create authentication evidence. Consumers must
 * not treat the returned `proof` metadata as a signature or replay protection.
 */
export function toVerifiablePresentation(
  credentials: VerifiableCredential[],
  holderKey: string
): VerifiablePresentation {
  if (!Array.isArray(credentials) || credentials.length > 1000) {
    throw new TypeError('Verifiable credentials must be a bounded dense array')
  }
  const ownedCredentials: VerifiableCredential[] = []
  for (let index = 0; index < credentials.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(credentials, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new TypeError('Verifiable credentials must be a bounded dense own-data array')
    }
    const credential = snapshotPlainDataRecord(descriptor.value)
    if (credential == null) throw new TypeError('Invalid verifiable credential')
    ownedCredentials.push(Object.assign(Object.create(null) as VerifiableCredential, credential))
  }
  const canonicalHolderKey = canonicalIdentityKey(holderKey, 'presentation holder')
  const now = new Date().toISOString()

  return {
    '@context': [VC_CONTEXT],
    type: ['VerifiablePresentation'],
    holder: `did:bsv:${canonicalHolderKey}`,
    verifiableCredential: ownedCredentials,
    proof: {
      type: PROOF_TYPE,
      created: now,
      proofPurpose: 'authentication',
      verificationMethod: `did:bsv:${canonicalHolderKey}#key-1`
    }
  }
}

// ============================================================================
// Wallet-integrated credential methods
// ============================================================================

export function createCredentialMethods(core: WalletCore): {
  acquireCredential: (config: RemoteCertificateRequest) => Promise<VerifiableCredential>
  listCredentials: (config: {
    certifiers: string[]
    types: string[]
    limit?: number
  }) => Promise<VerifiableCredential[]>
  createPresentation: (credentials: VerifiableCredential[]) => VerifiablePresentation
} {
  return {
    /**
     * Acquire a Verifiable Credential from a remote issuer server.
     */
    async acquireCredential(config: RemoteCertificateRequest): Promise<VerifiableCredential> {
      try {
        const certData = await acquireRemoteCertificate(core, config)
        return toVerifiableCredential(certData, certData.certifier)
      } catch (error) {
        throw new CredentialError(`Credential acquisition failed: ${(error as Error).message}`)
      }
    },

    /**
     * List wallet certificates wrapped as Verifiable Credentials.
     */
    async listCredentials(config: {
      certifiers: string[]
      types: string[]
      limit?: number
    }): Promise<VerifiableCredential[]> {
      try {
        const ownedConfig = snapshotPlainDataRecord(config)
        if (ownedConfig == null) throw new TypeError('Invalid credential list configuration')
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

        return result.certificates.map((value: unknown) => {
          const cert = snapshotPlainDataRecord(value)
          if (
            cert == null ||
            !args.certifiers.includes(cert.certifier as string) ||
            !args.types.includes(cert.type as string)
          ) {
            throw new TypeError('Wallet returned a certificate outside the requested scope')
          }
          const fields = validateCredentialFields(cert.fields)
          const keyringForSubject = validateCredentialFields(cert.keyringForSubject ?? {})
          const issuerKey = cert.certifier as string
          return toVerifiableCredential(
            {
              type: cert.type as string,
              serialNumber: cert.serialNumber as string,
              subject: cert.subject as string,
              certifier: cert.certifier as string,
              revocationOutpoint: cert.revocationOutpoint as string,
              fields,
              signature: cert.signature as string,
              keyringForSubject
            },
            issuerKey
          )
        })
      } catch (error) {
        throw new CredentialError(`Failed to list credentials: ${(error as Error).message}`)
      }
    },

    /**
     * Build an unsigned presentation envelope. This does not prove holder
     * control and must not authorize a replay-sensitive operation.
     */
    createPresentation(credentials: VerifiableCredential[]): VerifiablePresentation {
      return toVerifiablePresentation(credentials, core.getIdentityKey())
    }
  }
}
