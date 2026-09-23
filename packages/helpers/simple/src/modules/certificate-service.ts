import { compareCodeUnits } from '../core/code-unit-order'
import { stringifyBRC100 } from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  canonicalIdentityKey,
  fetchCertificateServiceJson,
  normalizeCertificateServiceUrl,
  snapshotPlainDataRecord,
  validateCertificateData,
  validateCertificateServiceInfo,
  validateCredentialFields,
  validateSchemaId
} from '../core/certificate-validation'
import { CertificateData } from '../core/types'
import { WalletCore } from '../core/WalletCore'

export interface RemoteCertificateRequest {
  serverUrl: string
  schemaId?: string
  fields?: Record<string, string>
  replaceExisting?: boolean
  /**
   * Explicitly trusted transport override for controlled tests or local
   * development. The default accepts only the configured public HTTPS origin
   * and pins public DNS results.
   */
  fetch?: typeof fetch
}

function canonicalBase64Identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 44) throw new TypeError(`Invalid ${name}`)
  try {
    const bytes = toArray(value, 'base64')
    if (bytes.length !== 32 || toBase64(bytes) !== value) throw new TypeError(`Invalid ${name}`)
  } catch {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

function sameRecord(left: Record<string, string>, right: unknown): boolean {
  const record = snapshotPlainDataRecord(right)
  if (record == null) return false
  const leftKeys = Object.keys(left).sort(compareCodeUnits)
  const rightKeys = Object.keys(record).sort(compareCodeUnits)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && record[key] === left[key])
  )
}

function assertAcquiredCertificate(value: unknown, certificate: CertificateData): void {
  const record = snapshotPlainDataRecord(value)
  if (
    record == null ||
    record.type !== certificate.type ||
    record.serialNumber !== certificate.serialNumber ||
    record.subject !== certificate.subject ||
    record.certifier !== certificate.certifier ||
    record.revocationOutpoint !== certificate.revocationOutpoint ||
    record.signature !== certificate.signature ||
    !sameRecord(certificate.fields, record.fields)
  ) {
    throw new Error('Wallet did not affirmatively acquire the requested certificate')
  }
}

function existingCertificateIds(
  value: unknown,
  expected: { type: string; certifier: string }
): string[] {
  const record = snapshotPlainDataRecord(value)
  if (record == null || !Array.isArray(record.certificates) || record.certificates.length > 100) {
    throw new Error('Wallet returned an invalid certificate list')
  }
  const serials: string[] = []
  for (let index = 0; index < record.certificates.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(record.certificates, String(index))
    const row =
      descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
        ? undefined
        : snapshotPlainDataRecord(descriptor.value)
    if (row == null) {
      throw new Error('Wallet returned an invalid certificate list')
    }
    if (
      row.type !== expected.type ||
      canonicalIdentityKey(row.certifier, 'listed certificate certifier') !== expected.certifier
    ) {
      throw new Error('Wallet returned a certificate outside the requested issuer and type')
    }
    serials.push(canonicalBase64Identifier(row.serialNumber, 'listed certificate serial number'))
  }
  return [...new Set(serials)]
}

export async function acquireRemoteCertificate(
  core: WalletCore,
  config: RemoteCertificateRequest
): Promise<CertificateData> {
  const ownedConfig = snapshotPlainDataRecord(config)
  if (ownedConfig == null) throw new TypeError('Invalid remote certificate request')
  if (ownedConfig.fetch != null && typeof ownedConfig.fetch !== 'function') {
    throw new TypeError('Invalid remote certificate transport')
  }
  const serviceUrl = normalizeCertificateServiceUrl(ownedConfig.serverUrl)
  const info = validateCertificateServiceInfo(
    await fetchCertificateServiceJson(
      serviceUrl,
      'info',
      {},
      ownedConfig.fetch as typeof fetch | undefined
    )
  )
  const identityKey = canonicalIdentityKey(core.getIdentityKey(), 'wallet identity key')
  const client = core.getClient()
  const existingSerials =
    ownedConfig.replaceExisting === false
      ? []
      : existingCertificateIds(
          await client.listCertificates({
            certifiers: [info.certifierPublicKey],
            types: [info.certificateType],
            limit: 100
          }),
          { type: info.certificateType, certifier: info.certifierPublicKey }
        )

  const schemaId = validateSchemaId(ownedConfig.schemaId)
  const fields =
    ownedConfig.fields == null ? undefined : validateCredentialFields(ownedConfig.fields)
  const certificate = await validateCertificateData(
    await fetchCertificateServiceJson(
      serviceUrl,
      'certify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100({
          identityKey,
          ...(schemaId == null ? {} : { schemaId }),
          ...(fields == null ? {} : { fields })
        })
      },
      ownedConfig.fetch as typeof fetch | undefined
    ),
    {
      certifier: info.certifierPublicKey,
      subject: identityKey,
      type: info.certificateType
    }
  )

  const acquired = await client.acquireCertificate({
    type: certificate.type,
    certifier: certificate.certifier,
    acquisitionProtocol: 'direct',
    fields: certificate.fields,
    serialNumber: certificate.serialNumber,
    revocationOutpoint: certificate.revocationOutpoint,
    signature: certificate.signature,
    keyringRevealer: 'certifier',
    keyringForSubject: certificate.keyringForSubject
  })
  assertAcquiredCertificate(acquired, certificate)

  for (const serialNumber of existingSerials) {
    // A same-serial reissue cannot be distinguished from the just-imported
    // row through the current relinquishment API; retain it rather than risk
    // deleting the newly authenticated certificate.
    if (serialNumber === certificate.serialNumber) continue
    const result = await client.relinquishCertificate({
      type: certificate.type,
      serialNumber,
      certifier: certificate.certifier
    })
    const record = snapshotPlainDataRecord(result)
    if (record == null || record.relinquished !== true) {
      throw new Error('Wallet did not affirmatively relinquish the replaced certificate')
    }
  }

  return certificate
}
