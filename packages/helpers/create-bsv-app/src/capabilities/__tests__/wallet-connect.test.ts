import { describe, expect, test } from '@jest/globals'
import { walletConnect } from '../wallet-connect'
import { newBuilder } from '../../scaffold/base-app'

const ctx = { name: 'demo', network: 'test' as const, bsvDir: 'src/bsv', stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } }, layout: 'frontend-only' as const }

describe('wallet-connect', () => {
  test('id + defaultSelected + roles', () => {
    expect(walletConnect.id).toBe('wallet-connect')
    expect(walletConnect.defaultSelected).toBe(true)
    expect(walletConnect.roles).toEqual(['shared', 'client', 'server'])
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
  test('ships a shared bsv.css theme (accent #2196F3) imported by WalletProviders', () => {
    const client = walletConnect.files(ctx).client ?? []
    const css = client.find(f => f.path === 'bsv.css')
    expect(css?.content).toContain('--bsv-accent: #2196F3')
    expect(css?.content).toContain('.bsv-page')
    const providers = client.find(f => f.path === 'WalletProviders.tsx')
    expect(providers?.content).toContain("import './bsv.css'")
  })
  test('client ships serverIdentity helper that fetches the baseline /api/identity route', () => {
    const client = walletConnect.files(ctx).client ?? []
    const helper = client.find(f => f.path === 'serverIdentity.ts')
    expect(helper).toBeDefined()
    expect(helper?.content).toContain('export async function getServerIdentity')
    expect(helper?.content).toContain('/api/identity')
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
  test('baseEdits mounts the WalletRelayService on the server (relay needs a backend)', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    expect(b.server.imports.join()).toContain("import { WalletRelayService } from '@bsv/wallet-relay'")
    expect(b.server.setup.join()).toContain('new WalletRelayService({ app, server, wallet: serverWallet')
  })
  test('relay client points at the server via API_BASE_URL', () => {
    const provider = (walletConnect.files(ctx).client ?? []).find(f => f.path === 'WalletConnectionContext.tsx')
    expect(provider?.content).toContain('apiUrl = API_BASE_URL')
    expect(provider?.content).toContain("from './config.js'")
  })
  test('deps name the right packages', () => {
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/auth')
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/sdk')
    const client = walletConnect.npmDependencies(ctx).client ?? {}
    expect(Object.keys(client)).toEqual(expect.arrayContaining(['@bsv/wallet-relay', 'react']))
    expect(Object.keys(client)).not.toContain('@bsv/sdk')
    // server gets the relay + its peer deps (qrcode, ws)
    const server = walletConnect.npmDependencies(ctx).server ?? {}
    expect(Object.keys(server)).toEqual(expect.arrayContaining(['@bsv/wallet-relay', 'qrcode', 'ws']))
  })
  test('wallet-connect provides ConnectWallet + client config and only main.* baseEdits (Home is a generated base file)', () => {
    const ctx2 = { name: 'd', network: 'test' as const, bsvDir: 'src/bsv', stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } }, layout: 'frontend-only' as const }
    const client = (walletConnect.files(ctx2).client ?? []).map(f => f.path)
    expect(client).toEqual(expect.arrayContaining(['ConnectWallet.tsx', 'config.ts', 'WalletContext.tsx']))
    expect(client).not.toContain('Home.tsx') // Home is assembled from HOME_TEMPLATE, not a capability file
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
  test('agentsSection has the How it works / How it\'s used / Future integrations structure', () => {
    const md = walletConnect.agentsSection(ctx)
    expect(md).toContain('### How it works')
    expect(md).toContain("### How it's used")
    expect(md).toContain('### Future integrations')
  })
})
