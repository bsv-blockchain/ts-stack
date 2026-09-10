import type { WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'
import { StorageClient as StorageMobile } from '../StorageMobile'

describe.each([
  ['client', StorageClient],
  ['mobile', StorageMobile]
])('%s remote storage transport security', (_name, Client) => {
  const wallet = {} as WalletInterface

  test('requires HTTPS for non-loopback servers', () => {
    expect(() => new Client(wallet, 'http://storage.example.com/rpc')).toThrow(
      'Wallet storage endpoint requires HTTPS except on localhost'
    )
    expect(() => new Client(wallet, 'https://storage.example.com/rpc')).not.toThrow()
  })

  test('allows HTTP only on explicit loopback hosts', () => {
    expect(() => new Client(wallet, 'http://localhost:8042')).not.toThrow()
    expect(() => new Client(wallet, 'http://127.0.0.1:8042')).not.toThrow()
    expect(() => new Client(wallet, 'http://[::1]:8042')).not.toThrow()
    expect(() => new Client(wallet, 'http://wallet.localhost:8042')).not.toThrow()
  })

  test('rejects ambiguous endpoint components', () => {
    expect(() => new Client(wallet, '/rpc')).toThrow('absolute URL')
    expect(() => new Client(wallet, 'https://user:pass@storage.example.com/rpc')).toThrow(
      'cannot include credentials, query, or fragment'
    )
    expect(() => new Client(wallet, 'https://storage.example.com/rpc?redirect=evil')).toThrow(
      'cannot include credentials, query, or fragment'
    )
  })
})
