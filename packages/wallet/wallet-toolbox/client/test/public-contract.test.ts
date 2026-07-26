import { describe, expect, it } from 'vitest'
import * as client from '../../src/index.client'

const requiredExports = [
  'Services',
  'SetupClient',
  'StorageClient',
  'StorageIdb',
  'Wallet',
  'WalletPermissionsManager',
  'WalletSettingsManager',
  'WalletSigner',
  'WalletStorageManager',
  'sdk'
] as const

const nodeOnlyExports = ['Setup', 'StorageKnex', 'ShamirWalletManager'] as const

describe('@bsv/wallet-toolbox-client public contract', () => {
  it.each(requiredExports)('exports %s', name => {
    expect(client[name]).toBeDefined()
  })

  it.each(nodeOnlyExports)('does not expose Node-only export %s', name => {
    expect(name in client).toBe(false)
  })
})
