// src/__tests__/wallet-login.test.ts
import { describe, expect, test } from '@jest/globals'
import { walletLogin } from '../capabilities/wallet-login'

const base = { appName: 'demo', network: 'test' as const }

describe('wallet-login capability', () => {
  test('always emits the shared agnostic auth util', () => {
    for (const framework of ['express', 'react'] as const) {
      const paths = walletLogin.files({ ...base, framework }).map(f => f.path)
      expect(paths).toContain('src/bsv/auth.ts')
    }
  })

  test('the shared util is built on the @bsv/auth abstraction', () => {
    const authFile = walletLogin.files({ ...base, framework: 'express' }).find(f => f.path === 'src/bsv/auth.ts')
    expect(authFile).toBeDefined()
    const util = authFile?.content ?? ''
    expect(util).toContain("from '@bsv/auth'")
    expect(util).toContain('AuthProofClient')
    expect(util).toContain('AuthProofServer')
  })

  test('express framework adds an Express login route', () => {
    const expressFiles = walletLogin.files({ ...base, framework: 'express' })
    const paths = expressFiles.map(f => f.path)
    expect(paths).toContain('src/bsv/loginRoute.ts')
    const routeFile = expressFiles.find(f => f.path === 'src/bsv/loginRoute.ts')
    expect(routeFile).toBeDefined()
    expect(routeFile?.content).toContain('verifyLoginProof')
  })

  test('react framework adds a hook built on @bsv/wallet-relay', () => {
    const files = walletLogin.files({ ...base, framework: 'react' })
    const hook = files.find(f => f.path === 'src/bsv/useWalletLogin.tsx')
    expect(hook).toBeDefined()
    expect(hook?.content).toContain("from '@bsv/wallet-relay/react'")
    expect(hook?.content).toContain('useWalletRelayClient')
  })

  test('npmDependencies vary by framework and always include @bsv/auth', () => {
    expect(walletLogin.npmDependencies({ ...base, framework: 'express' })).toHaveProperty('@bsv/auth')
    expect(walletLogin.npmDependencies({ ...base, framework: 'express' })).toHaveProperty('express')
    expect(walletLogin.npmDependencies({ ...base, framework: 'react' })).toHaveProperty('@bsv/wallet-relay')
    expect(walletLogin.npmDependencies({ ...base, framework: 'react' })).toHaveProperty('react')
  })

  test('agentsSection names the abstraction lib and the emitted files', () => {
    const md = walletLogin.agentsSection({ ...base, framework: 'react' })
    expect(md).toContain('@bsv/auth')
    expect(md).toContain('src/bsv/auth.ts')
    expect(md).toContain('useWalletLogin')
  })
})
