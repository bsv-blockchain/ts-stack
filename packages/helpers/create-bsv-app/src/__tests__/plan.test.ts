// src/__tests__/plan.test.ts
import { describe, expect, test } from '@jest/globals'
import { planPlacement } from '../engine'
import { walletLogin } from '../capabilities/wallet-login'
import type { ProjectConfig } from '../config/model'

const frontendConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-login'],
  glue: false,
  packageManager: 'npm',
  network: 'test'
}

const backendConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  stack: { backend: { framework: 'express' } },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-login'],
  glue: false,
  packageManager: 'npm',
  network: 'test'
}

describe('planPlacement', () => {
  test('frontend-only: shared + client files placed at root bsvDir, no server files', () => {
    const result = planPlacement(frontendConfig, [walletLogin])
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('src/bsv/auth.ts')
    expect(paths).toContain('src/bsv/useWalletLogin.tsx')
    expect(paths).not.toContain('src/bsv/loginRoute.ts')
  })

  test('frontend-only: deps.root has @bsv/auth and @bsv/wallet-relay', () => {
    const result = planPlacement(frontendConfig, [walletLogin])
    expect(result.deps.root).toHaveProperty('@bsv/auth')
    expect(result.deps.root).toHaveProperty('@bsv/wallet-relay')
  })

  test('backend-only: shared + server files placed at root bsvDir, no client files', () => {
    const result = planPlacement(backendConfig, [walletLogin])
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('src/bsv/auth.ts')
    expect(paths).toContain('src/bsv/loginRoute.ts')
    expect(paths).not.toContain('src/bsv/useWalletLogin.tsx')
  })

  test('throws on a file conflict (two caps emit the same path with different content)', () => {
    // two fake caps emit the same path with different content
    const capA = {
      id: 'a',
      title: 'A',
      description: 'a',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'clash.ts', content: 'content-from-a' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    const capB = {
      id: 'b',
      title: 'B',
      description: 'b',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'clash.ts', content: 'content-from-b' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    expect(() => planPlacement(frontendConfig, [capA, capB])).toThrow(/file conflict/i)
  })

  test('deduplicates when two caps emit same path with identical content', () => {
    const capA = {
      id: 'a',
      title: 'A',
      description: 'a',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'dup.ts', content: 'same-content' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    const capC = {
      id: 'c',
      title: 'C',
      description: 'c',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'dup.ts', content: 'same-content' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    const result = planPlacement(frontendConfig, [capA, capC])
    const paths = result.utilFiles.map(f => f.path)
    expect(paths.filter(p => p === 'src/bsv/dup.ts')).toHaveLength(1)
  })
})
