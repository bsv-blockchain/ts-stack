import { base64ToBytes } from './WalletByteEncoding.js'

/** Compatibility bound for existing certificates, not a rule for new issuance. */
export const MAX_EXISTING_CERTIFICATE_TYPE_BYTES = 128

export function existingCertificateTypeBytes(value: unknown): number[] {
  if (typeof value !== 'string' || value.length > 172) {
    throw new Error('Certificate type must be bounded canonical base64')
  }
  const bytes = base64ToBytes(value)
  if (bytes.length < 1 || bytes.length > MAX_EXISTING_CERTIFICATE_TYPE_BYTES) {
    throw new Error('Existing certificate type must encode 1 to 128 bytes')
  }
  return bytes
}
