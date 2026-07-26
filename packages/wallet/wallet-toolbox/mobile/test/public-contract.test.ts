import { describe, expect, it } from 'vitest'
import * as mobile from '../../src/index.mobile'

const requiredExports = [
  'ArcSSEClient',
  'Services',
  'StorageClient',
  'Wallet',
  'WalletPermissionsManager',
  'WalletSettingsManager',
  'WalletSigner',
  'WalletStorageManager',
  'sdk'
] as const

const unavailableExports = ['Setup', 'SetupClient', 'StorageIdb', 'StorageKnex', 'ShamirWalletManager'] as const

describe('@bsv/wallet-toolbox-mobile public contract', () => {
  it.each(requiredExports)('exports %s', name => {
    expect(mobile[name]).toBeDefined()
  })

  it.each(unavailableExports)('does not expose unsupported export %s', name => {
    expect(name in mobile).toBe(false)
  })
})
