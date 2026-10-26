import type {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import { AuthMessage, RequestedCertificateSet } from '../types.js'
import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { snapshotBoundedAuthData } from '../AuthMessageValidation.js'

const MAX_CERTIFICATES = 100

function assertRequestedDisclosedFields(
  value: unknown,
  requestedFields: string[],
  serialNumber: string
): void {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Certificate ${serialNumber} returned invalid disclosed fields`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Certificate ${serialNumber} returned invalid disclosed fields`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length === 0 ||
    keys.length > requestedFields.length ||
    keys.some(key => typeof key !== 'string' || !requestedFields.includes(key))
  ) {
    throw new Error(`Certificate ${serialNumber} did not reveal a non-empty requested field set`)
  }
  for (const field of keys) {
    if (typeof field !== 'string') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      throw new Error(`Certificate ${serialNumber} returned an invalid requested field`)
    }
  }
}

/**
 * Validates and processes the certificates received from a peer.
 *
 * @private
 * @param {AuthMessage} message - The message containing the certificates to validate.
 * @returns {Promise<void>}
 * @throws Will throw an error if certificate validation or field decryption fails.
 *
 * This helper validates presentation binding, certificate signatures, requested
 * certifier/type/fields, and disclosed-field keys. It does not query the chain
 * for each certificate's revocation outpoint because `WalletInterface` exposes
 * no authenticated arbitrary-outpoint status operation. Callers requiring
 * revocation enforcement must perform that check through a trusted chain
 * source before granting access and fail closed on an unavailable verdict.
 *
 * BRC-103 v0.1 policy matching is allowlist validation: every supplied
 * certificate and disclosed field must be requested, but this helper does not
 * prove that every listed type or field was supplied. Callers must enforce
 * complete application authorization against the resulting certificates.
 */
export const validateCertificates = async (
  verifierWallet: WalletInterface,
  message: AuthMessage,
  certificatesRequested?: RequestedCertificateSet,
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<void> => {
  message = snapshotBoundedAuthData(message)
  certificatesRequested =
    certificatesRequested === undefined ? undefined : snapshotBoundedAuthData(certificatesRequested)
  if (message.certificates == null || message.certificates.length === 0) {
    throw new Error('No certificates were provided in the AuthMessage.')
  }
  if (!Array.isArray(message.certificates) || message.certificates.length > MAX_CERTIFICATES) {
    throw new Error(`AuthMessage cannot contain more than ${MAX_CERTIFICATES} certificates.`)
  }

  await Promise.all(
    message.certificates.map(async (incomingCert: VerifiableCertificate) => {
      if (incomingCert.subject !== message.identityKey) {
        throw new Error(
          `The subject of one of your certificates ("${incomingCert.subject}") is not the same as the request sender ("${message.identityKey}").`
        )
      }

      // Verify Certificate structure and signature
      const certToVerify = new VerifiableCertificate(
        incomingCert.type,
        incomingCert.serialNumber,
        incomingCert.subject,
        incomingCert.certifier,
        incomingCert.revocationOutpoint,
        incomingCert.fields,
        incomingCert.keyring,
        incomingCert.signature
      )
      const isValidCert = await certToVerify.verify()
      if (isValidCert !== true) {
        throw new Error(
          `The signature for the certificate with serial number ${certToVerify.serialNumber} is invalid!`
        )
      }

      // Check if the certificate matches requested certifiers, types, and fields
      let requestedFields: string[] | undefined
      if (certificatesRequested != null) {
        const { certifiers, types } = certificatesRequested

        // Check certifier matches
        if (!certifiers.includes(certToVerify.certifier)) {
          throw new Error(
            `Certificate with serial number ${certToVerify.serialNumber} has an unrequested certifier: ${certToVerify.certifier}`
          )
        }

        // Check type and fields match requested
        requestedFields = types[certToVerify.type]
        if (requestedFields == null) {
          throw new Error(`Certificate with type ${certToVerify.type} was not requested`)
        }
      }

      // Attempt to decrypt fields
      const decryptedFields = await certToVerify.decryptFields(
        verifierWallet,
        undefined,
        undefined,
        originator
      )
      if (requestedFields != null) {
        assertRequestedDisclosedFields(decryptedFields, requestedFields, certToVerify.serialNumber)
      }
    })
  )
}
