// src/__tests__/agents-md.test.ts
import { describe, expect, test } from '@jest/globals'
import { renderAgentsMd } from '../agents-md'
import { walletLogin } from '../capabilities/wallet-login'
import type { ProjectConfig } from '../config/model'

const config: ProjectConfig = {
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

describe('renderAgentsMd', () => {
  test('includes header, deps, and the wallet-login section', () => {
    const md = renderAgentsMd(config, [walletLogin])
    expect(md).toContain('# demo — agent guide')
    expect(md).toContain('## Install dependencies')
    expect(md).toContain('@bsv/auth')
    expect(md).toContain('## wallet-login')
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
