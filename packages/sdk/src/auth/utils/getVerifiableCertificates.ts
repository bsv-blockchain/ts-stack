import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { OriginatorDomainNameStringUnder250Bytes, WalletInterface } from '../../wallet/Wallet.interfaces.js'
import { RequestedCertificateSet } from '../types.js'
import { snapshotBoundedAuthData } from '../AuthMessageValidation.js'

const MAX_CERTIFICATES = 100

function snapshotRequestedKeyring(
  value: unknown,
  requestedFields: string[]
): Record<string, string> {
  const keyring = snapshotBoundedAuthData(value)
  if (keyring == null || typeof keyring !== 'object' || Array.isArray(keyring)) {
    throw new Error('Wallet returned an invalid verifier keyring')
  }
  const keys = Reflect.ownKeys(keyring)
  if (keys.length > requestedFields.length) {
    throw new Error('Wallet verifier keyring reveals unrequested certificate fields')
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(keyring, key)
    if (
      typeof key !== 'string' ||
      !requestedFields.includes(key) ||
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      throw new Error('Wallet verifier keyring reveals unrequested certificate fields')
    }
  }
  return keyring as Record<string, string>
}

/**
 * Retrieves an array of verifiable certificates based on the request.
 * Returned keyrings are restricted to requested fields. The v0.1 request shape
 * is an allowlist and does not guarantee that the wallet owns every listed
 * type or can reveal every field.
 *
 * @private
 * @param {RequestedCertificateSet} requestedCertificates - The set of certificates requested by the peer.
 * @param {string} verifierIdentityKey - The public key of the verifier requesting the certificates.
 * @returns {Promise<VerifiableCertificate[]>} An array of verifiable certificates.
 */
export const getVerifiableCertificates = async (
  wallet: WalletInterface,
  requestedCertificates: RequestedCertificateSet,
  verifierIdentityKey: string,
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<VerifiableCertificate[]> => {
  requestedCertificates = snapshotBoundedAuthData(requestedCertificates)
  // Find matching certificates we have
  // Note: This may return multiple certificates that match the correct type.
  const matchingCertificates = snapshotBoundedAuthData(
    await wallet.listCertificates(
      {
        certifiers: requestedCertificates.certifiers,
        types: Object.keys(requestedCertificates.types)
      },
      originator
    )
  )
  if (
    matchingCertificates == null ||
    !Array.isArray(matchingCertificates.certificates) ||
    matchingCertificates.certificates.length > MAX_CERTIFICATES
  ) {
    throw new Error(`Wallet cannot return more than ${MAX_CERTIFICATES} matching certificates`)
  }

  // For each certificate requested, create a verifiable cert with selectively revealed fields
  return await Promise.all(
    matchingCertificates.certificates.map(async (certificate) => {
      const requestedFields = requestedCertificates.types[certificate.type]
      if (
        !requestedCertificates.certifiers.includes(certificate.certifier) ||
        !Array.isArray(requestedFields)
      ) {
        throw new Error('Wallet returned a certificate outside the requested certifier/type set')
      }
      const proof = snapshotBoundedAuthData(
        await wallet.proveCertificate(
          {
            certificate,
            fieldsToReveal: requestedFields,
            verifier: verifierIdentityKey
          },
          originator
        )
      )
      const keyringForVerifier = snapshotRequestedKeyring(
        proof.keyringForVerifier,
        requestedFields
      )
      return new VerifiableCertificate(
        certificate.type,
        certificate.serialNumber,
        certificate.subject,
        certificate.certifier,
        certificate.revocationOutpoint,
        certificate.fields,
        keyringForVerifier,
        certificate.signature
      )
    })
  )
}
