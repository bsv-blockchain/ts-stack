// src/__tests__/wallet-login.test.ts
import { describe, expect, test } from '@jest/globals'
import { walletLogin } from '../capabilities/wallet-login'

const ctx = { name: 'demo', network: 'test' as const, bsvDir: 'src/bsv', stack: {}, layout: 'monorepo' as const }

describe('wallet-login (variant)', () => {
  test('requires wallet-connect; no glue/clientEntry/defaultSelected', () => {
    expect(walletLogin.requires).toEqual(['wallet-connect'])
    expect(walletLogin.glue).toBeUndefined()
    expect(walletLogin.clientEntry).toBeUndefined()
    expect(walletLogin.defaultSelected).toBeUndefined()
    expect(walletLogin.roles).toEqual(['client', 'server'])
  })
  test('client hook uses useWallet + the shared auth helper, action login', () => {
    const client = walletLogin.files(ctx).client ?? []
    const hook = client.find(f => f.path === 'useWalletLogin.tsx')
    expect(hook?.content).toContain('useWallet')
    expect(hook?.content).toContain('createAuthProof')
    expect(hook?.content).toContain("'login'")
  })
  test('server route verifies via the shared auth helper', () => {
    const server = walletLogin.files(ctx).server ?? []
    const route = server.find(f => f.path === 'loginRoute.ts')
    expect(route?.content).toContain('verifyAuthProof')
    expect(route?.content).toContain("action: 'login'") // double-quotes needed: string contains single-quote
  })
})
