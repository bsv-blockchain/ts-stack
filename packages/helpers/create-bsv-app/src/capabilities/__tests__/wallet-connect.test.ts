import { describe, expect, test } from '@jest/globals'
import { walletConnect } from '../wallet-connect'
import { newBuilder } from '../../scaffold/base-app'

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
  test('baseEdits wraps App in WalletProviders (assembler path)', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    expect(b.main.imports.join()).toContain('WalletProviders')
    expect(b.main.wraps).toEqual([{ open: '<WalletProviders>', close: '</WalletProviders>' }])
  })
  test('deps name the right packages', () => {
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/auth')
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/sdk')
    const client = walletConnect.npmDependencies(ctx).client ?? {}
    expect(Object.keys(client)).toEqual(expect.arrayContaining(['@bsv/wallet-relay', 'react']))
    expect(Object.keys(client)).not.toContain('@bsv/sdk')
  })
  test('wallet-connect provides ConnectWallet + Home and only main.* baseEdits', () => {
    const ctx2 = { name: 'd', network: 'test' as const, bsvDir: 'src/bsv', stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } }, layout: 'frontend-only' as const }
    const client = (walletConnect.files(ctx2).client ?? []).map(f => f.path)
    expect(client).toEqual(expect.arrayContaining(['ConnectWallet.tsx', 'Home.tsx', 'WalletContext.tsx']))
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx: ctx2 })
    expect(b.main.wraps).toEqual([{ open: '<WalletProviders>', close: '</WalletProviders>' }])
    expect(b.main.imports.join()).toContain('WalletProviders')
    expect(b.app.routes).toEqual([]) // route-free toolkit
    expect(b.server.routes).toEqual([])
    expect(walletConnect.npmDependencies(ctx2).shared).toHaveProperty('@bsv/sdk')
    expect(walletConnect.npmDependencies(ctx2).client).toHaveProperty('react-router-dom')
  })
  test('WalletContext is a connect state machine (connect/connectMobile/cancel/status)', () => {
    const wc = (walletConnect.files({ name: 'd', network: 'test', bsvDir: 'src/bsv', stack: {}, layout: 'frontend-only' } as any).client ?? []).find(f => f.path === 'WalletContext.tsx')
    for (const s of ['connect', 'connectMobile', 'cancel', 'status']) expect(wc?.content).toContain(s)
  })
})
