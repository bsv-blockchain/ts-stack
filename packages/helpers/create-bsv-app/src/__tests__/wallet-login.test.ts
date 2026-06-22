// src/__tests__/wallet-login.test.ts
import { describe, expect, test } from '@jest/globals'
import { walletLogin } from '../capabilities/wallet-login'
import type { CapabilityContext } from '../types'

const ctx: CapabilityContext = {
  name: 'demo',
  network: 'test',
  bsvDir: 'src/bsv',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  layout: 'frontend-only'
}

describe('wallet-login capability', () => {
  test('roles are shared, client, server', () => {
    expect(walletLogin.roles).toEqual(['shared', 'client', 'server'])
  })

  test('shared files includes auth.ts built on @bsv/auth', () => {
    const roleFiles = walletLogin.files(ctx)
    const shared = roleFiles.shared ?? []
    const authFile = shared.find(f => f.path === 'auth.ts')
    expect(authFile).toBeDefined()
    expect(authFile?.content).toContain("from '@bsv/auth'")
    expect(authFile?.content).toContain('AuthProofClient')
    expect(authFile?.content).toContain('AuthProofServer')
  })

  test('client files includes useWalletLogin.tsx built on @bsv/wallet-relay', () => {
    const roleFiles = walletLogin.files(ctx)
    const client = roleFiles.client ?? []
    const hook = client.find(f => f.path === 'useWalletLogin.tsx')
    expect(hook).toBeDefined()
    expect(hook?.content).toContain("from '@bsv/wallet-relay/react'")
    expect(hook?.content).toContain('useWalletRelayClient')
  })

  test('server files includes loginRoute.ts', () => {
    const roleFiles = walletLogin.files(ctx)
    const server = roleFiles.server ?? []
    const route = server.find(f => f.path === 'loginRoute.ts')
    expect(route).toBeDefined()
    expect(route?.content).toContain('verifyLoginProof')
  })

  test('npmDependencies has @bsv/auth in shared, @bsv/wallet-relay in client', () => {
    const deps = walletLogin.npmDependencies(ctx)
    expect(deps.shared).toHaveProperty('@bsv/auth')
    expect(deps.client).toHaveProperty('@bsv/wallet-relay')
    expect(deps.server).toHaveProperty('express')
  })

  test('agentsSection mentions @bsv/auth and wallet-login', () => {
    const md = walletLogin.agentsSection(ctx)
    expect(md).toContain('@bsv/auth')
    expect(md).toContain('wallet-login')
    expect(md).toContain('useWalletLogin')
  })
})
