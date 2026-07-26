// src/__tests__/placement.test.ts
import { describe, expect, test } from '@jest/globals'
import { planPlacement } from '../engine'
import { walletConnect } from '../capabilities/wallet-connect'
import { walletLogin } from '../capabilities/wallet-login'
import type { Capability, CapabilityContext } from '../types'
import type { ProjectConfig } from '../config/model'

const monorepoConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: {
    frontend: { framework: 'react', variant: 'react-ts' },
    backend: { framework: 'express' }
  },
  targets: { client: 'client', server: 'server' },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-connect', 'wallet-login'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}

const customBsvDirConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: {
    frontend: { framework: 'react', variant: 'react-ts' },
    backend: { framework: 'express' }
  },
  targets: { client: 'client', server: 'server' },
  bsvDir: 'lib/bsv',
  capabilities: ['wallet-connect', 'wallet-login'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}

// Fake capability with glue files
const capWithGlue: Capability = {
  id: 'glue-cap',
  title: 'Glue Cap',
  description: 'fake cap with glue',
  roles: ['shared'],
  files: () => ({ shared: [{ path: 'util.ts', content: '// util' }] }),
  glue: (_ctx: CapabilityContext) => ({ shared: [{ path: 'glue-entry.ts', content: '// glue' }] }),
  npmDependencies: () => ({}),
  agentsSection: () => ''
}

// wallet-login requires wallet-connect; pass both (as resolveCapabilities would return in expand mode)
const bothCaps = [walletConnect, walletLogin]

describe('planPlacement — monorepo', () => {
  test('shared file (auth.ts) is duplicated into BOTH client and server bsvDir', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('client/src/bsv/auth.ts')
    expect(paths).toContain('server/src/bsv/auth.ts')
  })

  test('client-only file (useWalletLogin.tsx) is placed under client/ only', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('client/src/bsv/useWalletLogin.tsx')
    expect(paths).not.toContain('server/src/bsv/useWalletLogin.tsx')
  })

  test('server-only file (loginRoute.ts) is placed under server/ only', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('server/src/bsv/loginRoute.ts')
    expect(paths).not.toContain('client/src/bsv/loginRoute.ts')
  })

  test('no root-level bsv files in monorepo', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).not.toContain('src/bsv/auth.ts')
    expect(paths).not.toContain('src/bsv/useWalletLogin.tsx')
  })

  test('deps.client has @bsv/auth and @bsv/sdk (from wallet-connect shared role)', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    expect(result.deps.client).toHaveProperty('@bsv/auth')
    expect(result.deps.client).toHaveProperty('@bsv/sdk')
  })

  test('deps.server has @bsv/auth, @bsv/sdk and express (wallet-connect shared + wallet-login server)', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    expect(result.deps.server).toHaveProperty('@bsv/auth')
    expect(result.deps.server).toHaveProperty('@bsv/sdk')
    expect(result.deps.server).toHaveProperty('express')
  })

  test('deps.server includes the relay peer deps (wallet-connect runs WalletRelayService server-side)', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    expect(result.deps.server).toHaveProperty('@bsv/wallet-relay')
    expect(result.deps.server).toHaveProperty('qrcode')
    expect(result.deps.server).toHaveProperty('ws')
  })

  test('deps.client does not have express (server-only dep)', () => {
    const result = planPlacement(monorepoConfig, bothCaps)
    expect(result.deps.client).not.toHaveProperty('express')
  })
})

describe('planPlacement — custom bsvDir', () => {
  test('files are placed under custom bsvDir in monorepo', () => {
    const result = planPlacement(customBsvDirConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).toContain('client/lib/bsv/auth.ts')
    expect(paths).toContain('server/lib/bsv/auth.ts')
    expect(paths).toContain('client/lib/bsv/useWalletLogin.tsx')
    expect(paths).toContain('server/lib/bsv/loginRoute.ts')
  })

  test('default bsvDir paths are absent when custom bsvDir is set', () => {
    const result = planPlacement(customBsvDirConfig, bothCaps)
    const paths = result.utilFiles.map(f => f.path)
    expect(paths).not.toContain('client/src/bsv/auth.ts')
    expect(paths).not.toContain('server/src/bsv/auth.ts')
  })
})

describe('planPlacement — glue toggle', () => {
  test('glue files NOT produced when config.glue is false', () => {
    const result = planPlacement({ ...monorepoConfig, glue: false }, [capWithGlue])
    expect(result.glueFiles).toHaveLength(0)
  })

  test('glue files ARE produced when config.glue is true', () => {
    const result = planPlacement({ ...monorepoConfig, glue: true }, [capWithGlue])
    expect(result.glueFiles.length).toBeGreaterThan(0)
  })

  test('glue files placed at target root (NOT under bsvDir)', () => {
    const result = planPlacement({ ...monorepoConfig, glue: true }, [capWithGlue])
    const paths = result.glueFiles.map(f => f.path)
    // glue-entry.ts should be at client/glue-entry.ts and server/glue-entry.ts, NOT under src/bsv/
    for (const p of paths) {
      expect(p).not.toContain(monorepoConfig.bsvDir)
    }
    expect(paths.some(p => p.endsWith('glue-entry.ts'))).toBe(true)
  })

  test('util files from capWithGlue are under bsvDir', () => {
    const result = planPlacement({ ...monorepoConfig, glue: true }, [capWithGlue])
    const paths = result.utilFiles.map(f => f.path)
    expect(paths.every(p => p.includes(monorepoConfig.bsvDir))).toBe(true)
  })
})
