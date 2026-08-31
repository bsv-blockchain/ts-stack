import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

const CIPHERTEXT_PREFIX = 'v1'
const KEY_CONTEXT = Buffer.from('bsv-wab-presentation-key:v1', 'utf8')
const REDACTED_PREFIXES = ['encrypted_', 'redacted_'] as const

export type PresentationKeyVaultMode = 'legacy' | 'dual-write' | 'encrypted'

function configuredEncryptionKey(): Buffer | undefined {
  const encoded = process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY?.trim()
  if (encoded == null || encoded === '') return undefined
  if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error(
      'WAB_PRESENTATION_KEY_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.'
    )
  }
  return Buffer.from(encoded, 'hex')
}

function encryptionKey(): Buffer {
  const key = configuredEncryptionKey()
  if (key == null) {
    throw new Error(
      'WAB_PRESENTATION_KEY_ENCRYPTION_KEY is required in dual-write and encrypted modes.'
    )
  }
  return key
}

export function hasPresentationKeyVaultKey(): boolean {
  return configuredEncryptionKey() != null
}

export function presentationKeyVaultMode(): PresentationKeyVaultMode {
  const configuredMode = process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE?.trim().toLowerCase()
  const hasKey = hasPresentationKeyVaultKey()
  const mode =
    configuredMode === '' || configuredMode == null
      ? hasKey
        ? 'dual-write'
        : 'legacy'
      : configuredMode
  if (mode !== 'legacy' && mode !== 'dual-write' && mode !== 'encrypted') {
    throw new Error(
      'WAB_PRESENTATION_KEY_ENCRYPTION_MODE must be legacy, dual-write, or encrypted.'
    )
  }
  if (mode !== 'legacy' && !hasKey) {
    throw new Error(
      'WAB_PRESENTATION_KEY_ENCRYPTION_KEY is required in dual-write and encrypted modes.'
    )
  }
  return mode
}

export function validatePresentationKeyVaultConfig(): PresentationKeyVaultMode {
  return presentationKeyVaultMode()
}

export function presentationKeyLookup(key: string): string {
  return createHmac('sha256', encryptionKey())
    .update('lookup:v1\0', 'utf8')
    .update(key, 'utf8')
    .digest('hex')
}

export function encryptPresentationKey(key: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce)
  cipher.setAAD(KEY_CONTEXT)
  const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    CIPHERTEXT_PREFIX,
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.')
}

export function decryptPresentationKey(encoded: string): string {
  const [version, nonceEncoded, tagEncoded, ciphertextEncoded, extra] = encoded.split('.')
  if (
    version !== CIPHERTEXT_PREFIX ||
    nonceEncoded == null ||
    tagEncoded == null ||
    ciphertextEncoded == null ||
    extra !== undefined
  ) {
    throw new Error('Stored presentation key has an unsupported encrypted format.')
  }
  const nonce = Buffer.from(nonceEncoded, 'base64url')
  const tag = Buffer.from(tagEncoded, 'base64url')
  const ciphertext = Buffer.from(ciphertextEncoded, 'base64url')
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Stored presentation key has invalid encrypted fields.')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce)
  decipher.setAAD(KEY_CONTEXT)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function redactedPresentationKey(rowId: number, purpose = 'primary'): string {
  return `redacted_${purpose}_${rowId}`
}

export function isRedactedPresentationKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && REDACTED_PREFIXES.some(prefix => value.startsWith(prefix))
}
