import { validateWABAdminConfig } from '../security/adminAuth'

describe('WAB administrative token configuration', () => {
  it('allows the intentionally disabled state and strong configured tokens', () => {
    expect(() => validateWABAdminConfig(undefined)).not.toThrow()
    expect(() => validateWABAdminConfig('a'.repeat(32))).not.toThrow()
  })

  it('fails startup configuration for a non-empty short token', () => {
    expect(() => validateWABAdminConfig('too-short')).toThrow(
      'WAB_ADMIN_TOKEN must contain at least 32 characters'
    )
  })
})
