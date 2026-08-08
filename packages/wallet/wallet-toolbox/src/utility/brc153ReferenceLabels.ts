import { Utils } from '@bsv/sdk'

const REFERENCE_PREFIX = 'reference '

/**
 * Build the BRC-153 synthetic listActions label for an action reference.
 * Encodes reference bytes as lowercase hex (labels are lowercased by validation).
 */
export function makeBrc153ReferenceLabel (referenceBase64: string): string {
  const bytes = Utils.toArray(referenceBase64, 'base64')
  return `${REFERENCE_PREFIX}${Utils.toHex(bytes)}`
}

/**
 * Parse a BRC-153 synthetic reference label back to the BRC-100 Base64String reference.
 * Returns undefined if the label is not a valid reference label.
 */
export function parseBrc153ReferenceLabel (label: string): string | undefined {
  if (!label.startsWith(REFERENCE_PREFIX)) return undefined
  const hex = label.slice(REFERENCE_PREFIX.length)
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return undefined
  return Utils.toBase64(Utils.toArray(hex, 'hex'))
}
