// src/__tests__/plan.test.ts
import { describe, expect, test } from '@jest/globals'
import { planPlacement } from '../engine'
import { walletConnect } from '../capabilities/wallet-connect'
import { walletLogin } from '../capabilities/wallet-login'
import type { ProjectConfig } from '../config/model'

const frontendConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  targets: { client: '' },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-connect', 'wallet-login'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}

const backendConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: { backend: { framework: 'express' } },
  targets: { server: '' },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-connect', 'wallet-login'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}

// wallet-login requires wallet-connect; pass both (as resolveCapabilities would return in expand mode)
const bothCaps = [walletConnect, walletLogin]

describe('planPlacement', () => {
  test('frontend-only: shared + client files placed at root bsvDir, no server files', () => {
    const result = planPlacement(frontendConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('src/bsv/auth.ts')
    expect(paths).toContain('src/bsv/useWalletLogin.tsx')
    expect(paths).not.toContain('src/bsv/loginRoute.ts')
  })

  test('frontend-only: logical client deps target the root client package', () => {
    const result = planPlacement(frontendConfig, bothCaps)
    expect(result.deps.client).toHaveProperty('@bsv/auth')
    expect(result.deps.client).toHaveProperty('@bsv/sdk')
  })

  test('backend-only: shared + server files placed at root bsvDir, no client files', () => {
    const result = planPlacement(backendConfig, bothCaps)
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
