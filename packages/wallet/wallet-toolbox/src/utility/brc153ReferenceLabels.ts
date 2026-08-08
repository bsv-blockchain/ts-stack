import { Utils } from '@bsv/sdk'

export const BRC153_REFERENCE_PREFIX = 'reference '

/**
 * Build the BRC-153 synthetic listActions label for an action reference.
 * Encodes reference bytes as lowercase hex (labels are lowercased by validation).
 */
export function makeBrc153ReferenceLabel (referenceBase64: string): string {
  const bytes = Utils.toArray(referenceBase64, 'base64')
  return `${BRC153_REFERENCE_PREFIX}${Utils.toHex(bytes)}`
}

/**
 * True iff the label uses the reserved BRC-153 reference prefix.
 */
export function isBrc153ReferenceLabel (label: string): boolean {
  return label.startsWith(BRC153_REFERENCE_PREFIX)
}

/**
 * Ensure labels contain exactly one wallet-authored `reference <hex>`.
 * Any existing reserved-prefix labels are replaced.
 */
export function applyBrc153ReferenceLabel (labels: string[], referenceBase64: string): string[] {
  const next = labels.filter(label => !isBrc153ReferenceLabel(label))
  next.push(makeBrc153ReferenceLabel(referenceBase64))
  return next
}

/**
 * Drop caller-supplied reserved reference labels (create/internalize).
 */
export function rejectBrc153ReferenceLabels (labels: string[]): string[] {
  return labels.filter(label => !isBrc153ReferenceLabel(label))
}

/**
 * Parse a BRC-153 synthetic reference label back to the BRC-100 Base64String reference.
 * Returns undefined if the label is not a valid reference label.
 */
export function parseBrc153ReferenceLabel (label: string): string | undefined {
  if (!label.startsWith(BRC153_REFERENCE_PREFIX)) return undefined
  const hex = label.slice(BRC153_REFERENCE_PREFIX.length)
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return undefined
  return Utils.toBase64(Utils.toArray(hex, 'hex'))
}
