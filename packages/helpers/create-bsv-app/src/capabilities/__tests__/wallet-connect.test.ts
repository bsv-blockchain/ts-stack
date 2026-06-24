import { describe, expect, test } from '@jest/globals'
import { walletConnect } from '../wallet-connect'

const ctx = { name: 'demo', network: 'test' as const, bsvDir: 'src/bsv', stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } }, layout: 'frontend-only' as const }

describe('wallet-connect', () => {
  test('id + defaultSelected + roles', () => {
    expect(walletConnect.id).toBe('wallet-connect')
    expect(walletConnect.defaultSelected).toBe(true)
    expect(walletConnect.roles).toEqual(['shared', 'client'])
  })
  test('shared helper is the @bsv/auth proof primitive (object-arg API)', () => {
    const shared = walletConnect.files(ctx).shared ?? []
    const auth = shared.find(f => f.path === 'auth.ts')
    expect(auth).toBeDefined()
    expect(auth?.content).toContain('AuthProofClient')
    expect(auth?.content).toContain('createAuthProof({') // object-arg, NOT positional
    expect(auth?.content).not.toMatch(/createAuthProof\(\s*wallet\s*,/) // guard the old positional bug
  })
  test('client gets acquisition helper and all three context files (bare paths, always emitted)', () => {
    const client = walletConnect.files(ctx).client ?? []
    const paths = client.map(f => f.path)
    expect(paths).toContain('walletAcquisition.ts')
    expect(paths).toContain('WalletConnectionContext.tsx')
    expect(paths).toContain('WalletContext.tsx')
    expect(paths).toContain('WalletProviders.tsx')
  })
  test('glue is undefined (contexts moved to core files)', () => {
    expect(walletConnect.glue).toBeUndefined()
  })
  test('clientEntry wraps App in WalletProviders importing from bsvDir', () => {
    const entry = walletConnect.clientEntry?.(ctx)
    expect(entry?.path).toBe('src/main.tsx')
    expect(entry?.content).toContain('WalletProviders')
    expect(entry?.content).toContain('./bsv/WalletProviders')
    expect(entry?.content).toContain('<App')
  })
  test('deps name the right packages', () => {
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/auth')
    const client = walletConnect.npmDependencies(ctx).client ?? {}
    expect(Object.keys(client)).toEqual(expect.arrayContaining(['@bsv/sdk', '@bsv/wallet-relay', 'react']))
  })
})
