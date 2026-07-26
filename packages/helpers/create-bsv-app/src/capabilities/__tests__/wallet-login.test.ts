import { describe, expect, test } from '@jest/globals'
import { walletLogin } from '../wallet-login'
import { newBuilder } from '../../scaffold/base-app'

const ctx = {
  name: 'd',
  network: 'test' as const,
  bsvDir: 'src/bsv',
  stack: {},
  layout: 'monorepo' as const
}

describe('wallet-login', () => {
  test('requires wallet-connect; roles client + server', () => {
    expect(walletLogin.requires).toEqual(['wallet-connect'])
    expect(walletLogin.glue).toBeUndefined()
    expect(walletLogin.defaultSelected).toBeUndefined()
    expect(walletLogin.roles).toEqual(['client', 'server'])
  })
  test('client files include WalletLogin.tsx and useWalletLogin.tsx', () => {
    const client = walletLogin.files(ctx).client ?? []
    const paths = client.map(f => f.path)
    expect(paths).toContain('WalletLogin.tsx')
    expect(paths).toContain('useWalletLogin.tsx')
  })
  test('client hook uses useWallet + the shared auth helper, action login', () => {
    const client = walletLogin.files(ctx).client ?? []
    const hook = client.find(f => f.path === 'useWalletLogin.tsx')
    expect(hook?.content).toContain('useWallet')
    expect(hook?.content).toContain('createAuthProof')
    expect(hook?.content).toContain("'login'")
  })
  test('counterparty is auto-resolved (no hard-coded SERVER_IDENTITY_KEY placeholder)', () => {
    const client = walletLogin.files(ctx).client ?? []
    const page = client.find(f => f.path === 'WalletLogin.tsx')
    const hook = client.find(f => f.path === 'useWalletLogin.tsx')
    expect(page?.content).toContain('getServerIdentity')
    expect(page?.content).not.toContain("SERVER_IDENTITY_KEY = ''")
    expect(hook?.content).toContain('getServerIdentity')
    expect(hook?.content).toContain('serverIdentityKey?: string') // now optional
  })
  test('server route verifies via the shared auth helper', () => {
    const server = walletLogin.files(ctx).server ?? []
    const route = server.find(f => f.path === 'loginRoute.ts')
    expect(route?.content).toContain('verifyAuthProof')
    expect(route?.content).toContain("action: 'login'")
  })
  test('wallet-login adds a WalletLogin page + route descriptor + server route via baseEdits', () => {
    expect((walletLogin.files(ctx).client ?? []).map(f => f.path)).toContain('WalletLogin.tsx')
    const b = newBuilder()
    walletLogin.baseEdits?.({ builder: b, ctx })
    expect(b.app.routes).toContainEqual({
      path: '/login',
      component: 'WalletLogin',
      importPath: './bsv/WalletLogin',
      label: 'Wallet login'
    })
    expect(b.server.routes.join()).toContain('/api/login')
    expect(b.server.imports.join()).toContain('loginRoute')
  })
  test('login page renders a removable step-by-step activity log', () => {
    const page = (walletLogin.files(ctx).client ?? []).find(f => f.path === 'WalletLogin.tsx')
    expect(page?.content).toContain('demo activity log (safe to delete)')
    expect(page?.content).toContain('Signing a login proof')
    expect(page?.content).toContain('the server trusts this identity')
  })
  test("agentsSection has the How it works / How it's used / Future integrations structure + JWT session sketch", () => {
    const md = walletLogin.agentsSection(ctx)
    expect(md).toContain('### How it works')
    expect(md).toContain("### How it's used")
    expect(md).toContain('### Future integrations')
    expect(md).toContain('SignJWT') // the going-further JWT snippet
  })
})
