import { PublicKey } from '@bsv/sdk'

export const MAX_MESSAGE_BOX_BYTES = 128
export const MAX_MESSAGE_ID_BYTES = 256

export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}

export function isExactBoundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !containsControlCharacter(value)
  )
}

export function isCanonicalMessageBox(value: unknown): value is string {
  return isExactBoundedText(value, MAX_MESSAGE_BOX_BYTES)
}

export function isCanonicalMessageId(value: unknown): value is string {
  return isExactBoundedText(value, MAX_MESSAGE_ID_BYTES)
}

export function canonicalIdentityKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return PublicKey.fromString(value).toString()
  } catch {
    return undefined
  }
}
