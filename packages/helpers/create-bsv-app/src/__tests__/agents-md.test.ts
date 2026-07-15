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

  test('add-mode: wiring section shows route JSX and server route snippet to paste', () => {
    const md = renderAgentsMd(config, [walletConnect, walletLogin])
    // Should include a Wiring (manual) heading
    expect(md).toContain('Wiring')
    // App.tsx route import generated from the route descriptor
    expect(md).toContain("import { WalletLogin } from './bsv/WalletLogin'")
    // Route JSX generated from the route descriptor
    expect(md).toContain('<Route path="/login" element={<WalletLogin />} />')
    // Server route snippet
    expect(md).toContain("app.post('/api/login', loginRoute(serverWallet))")
    // SERVER_PRIVATE_KEY note because there is a server route
    expect(md).toContain('SERVER_PRIVATE_KEY')
    expect(md).toContain('.env')
  })

  test('new+glue: wiring section says wired automatically, no snippet dump', () => {
    const newGlueConfig: ProjectConfig = {
      ...config,
      mode: 'new',
      glue: true
    }
    const md = renderAgentsMd(newGlueConfig, [walletConnect, walletLogin])
    // Should say wired automatically
    expect(md).toContain('wired automatically')
    // Should NOT contain the route JSX snippet in a fenced code block
    expect(md).not.toContain('<Route path="/login" element={<WalletLogin />} />')
    // Should NOT dump the server/src/index.ts wiring block
    expect(md).not.toContain('### `server/src/index.ts`')
  })
})
