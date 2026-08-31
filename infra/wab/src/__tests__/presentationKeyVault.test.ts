import {
  decryptPresentationKey,
  encryptPresentationKey,
  presentationKeyLookup,
  presentationKeyVaultMode,
  validatePresentationKeyVaultConfig
} from '../security/presentationKeyVault'

describe('presentation key vault', () => {
  const key = 'ab'.repeat(32)
  const originalKey = process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY
  const originalMode = process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE

  afterEach(() => {
    if (originalKey == null) delete process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY
    else process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = originalKey
    if (originalMode == null) delete process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE
    else process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = originalMode
  })

  it('encrypts credentials with authenticated randomized ciphertext', () => {
    const first = encryptPresentationKey(key)
    const second = encryptPresentationKey(key)

    expect(first).not.toBe(second)
    expect(first).not.toContain(key)
    expect(decryptPresentationKey(first)).toBe(key)
    expect(decryptPresentationKey(second)).toBe(key)
  })

  it('uses a stable keyed lookup and rejects ciphertext tampering', () => {
    expect(presentationKeyLookup(key)).toBe(presentationKeyLookup(key))
    expect(presentationKeyLookup(key)).not.toBe(presentationKeyLookup('cd'.repeat(32)))

    const encrypted = encryptPresentationKey(key)
    const fields = encrypted.split('.')
    fields[2] = `${fields[2][0] === 'A' ? 'B' : 'A'}${fields[2].slice(1)}`
    expect(() => decryptPresentationKey(fields.join('.'))).toThrow()
  })

  it('defaults safely for legacy and dual-write rollouts', () => {
    delete process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE
    delete process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY
    expect(validatePresentationKeyVaultConfig()).toBe('legacy')

    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = '2'.repeat(64)
    expect(validatePresentationKeyVaultConfig()).toBe('dual-write')
  })

  it('requires a valid key only when encryption is configured', () => {
    delete process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'dual-write'
    expect(() => presentationKeyVaultMode()).toThrow('is required')
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'encrypted'
    expect(() => presentationKeyVaultMode()).toThrow('is required')

    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_MODE = 'legacy'
    process.env.WAB_PRESENTATION_KEY_ENCRYPTION_KEY = 'not-a-key'
    expect(() => presentationKeyVaultMode()).toThrow('must be exactly 64 hexadecimal characters')
  })
})
