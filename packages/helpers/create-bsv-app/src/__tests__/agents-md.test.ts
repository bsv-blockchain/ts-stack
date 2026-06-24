// src/__tests__/agents-md.test.ts
import { describe, expect, test } from '@jest/globals'
import { renderAgentsMd } from '../agents-md'
import { walletConnect } from '../capabilities/wallet-connect'
import { walletLogin } from '../capabilities/wallet-login'
import type { ProjectConfig } from '../config/model'

const config: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-connect', 'wallet-login'],
  glue: false,
  packageManager: 'npm',
  network: 'test'
}

describe('renderAgentsMd', () => {
  test('includes header, deps, and the wallet-login section', () => {
    // wallet-login requires wallet-connect; render both so @bsv/auth (from wallet-connect) appears in deps
    const md = renderAgentsMd(config, [walletConnect, walletLogin])
    expect(md).toContain('# demo — agent guide')
    expect(md).toContain('## Install dependencies')
    expect(md).toContain('@bsv/auth')
    expect(md).toContain('## wallet-login')
    expect(md).toContain('## wallet-connect')
  })

  test('throws on file conflict (two caps same path different content)', () => {
    const capX = {
      id: 'x',
      title: 'X',
      description: 'x',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'clash.ts', content: 'from-x' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    const capY = {
      id: 'y',
      title: 'Y',
      description: 'y',
      roles: ['shared' as const],
      files: () => ({ shared: [{ path: 'clash.ts', content: 'from-y' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    expect(() => renderAgentsMd(config, [capX, capY])).toThrow(/file conflict/i)
  })
})
