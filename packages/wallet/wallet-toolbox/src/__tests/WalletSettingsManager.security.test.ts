import { PrivateKey } from '@bsv/sdk'
import { DEFAULT_SETTINGS, WalletSettingsManager, validateTrustSettings } from '../WalletSettingsManager'

const certifier = PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey().toString()

function validTrustSettings() {
  return {
    trustLevel: 1,
    trustedCertifiers: [
      {
        name: 'Certifier',
        description: 'Trusted test certifier',
        identityKey: certifier,
        trust: 1
      }
    ]
  }
}

describe('WalletSettingsManager authorization policy validation', () => {
  test('rejects zero thresholds, invalid trust weights, and duplicate certifiers', () => {
    expect(() => validateTrustSettings({ ...validTrustSettings(), trustLevel: 0 })).toThrow('trustLevel')
    expect(() =>
      validateTrustSettings({
        ...validTrustSettings(),
        trustedCertifiers: [{ ...validTrustSettings().trustedCertifiers[0], trust: Infinity }]
      })
    ).toThrow('.trust')
    expect(() =>
      validateTrustSettings({
        ...validTrustSettings(),
        trustedCertifiers: [validTrustSettings().trustedCertifiers[0], validTrustSettings().trustedCertifiers[0]]
      })
    ).toThrow('must be unique')
  })

  test('rejects accessors without invoking them before storing policy', async () => {
    const manager = new WalletSettingsManager({} as never)
    manager.kv = { set: jest.fn() } as never
    let calls = 0
    const trustSettings = validTrustSettings() as Record<string, unknown>
    Object.defineProperty(trustSettings, 'trustLevel', {
      enumerable: true,
      get: () => {
        calls++
        return 1
      }
    })

    await expect(manager.set({ ...DEFAULT_SETTINGS, trustSettings: trustSettings as never })).rejects.toThrow(
      'data property'
    )
    expect(calls).toBe(0)
    expect(manager.kv.set).not.toHaveBeenCalled()
  })

  test('rejects corrupted stored policy instead of weakening authorization', async () => {
    const manager = new WalletSettingsManager({} as never)
    manager.kv = {
      get: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ ...DEFAULT_SETTINGS, trustSettings: { ...validTrustSettings(), trustLevel: 0 } })
        )
    } as never

    await expect(manager.get()).rejects.toThrow('trustLevel')
  })
})
