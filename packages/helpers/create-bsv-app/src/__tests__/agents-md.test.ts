// src/__tests__/agents-md.test.ts
import { describe, expect, test } from '@jest/globals'
import { dirname } from 'node:path'
import ts from 'typescript'
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

// The fenced `server/src/index.ts` block of a manual-wiring AGENTS.md.
function serverSnippet(md: string): string {
  const match = /### `server\/src\/index\.ts`\n\n```ts\n([\s\S]*?)\n```/.exec(md)
  if (match == null) throw new Error('no server/src/index.ts snippet')
  return match[1]
}

// Express-shaped stand-ins for what the snippet's own comments say the user's server already has.
const SERVER_PRELUDE = [
  'interface Res { setHeader (k: string, v: string): void, json (b: unknown): void, status (c: number): Res }',
  'declare const app: { get (path: string, handler: (req: unknown, res: Res) => void): void }',
  'declare const server: unknown',
  'declare const serverWallet: unknown'
].join('\n')

// Strict typecheck of a pasted server snippet against SERVER_PRELUDE; @bsv/wallet-relay is stubbed.
function typecheckServerSnippet(snippet: string): string[] {
  const files: Record<string, string> = {
    '/virtual/index.ts': `${SERVER_PRELUDE}\n${snippet}\nexport {}\n`,
    '/virtual/wallet-relay.d.ts':
      "declare module '@bsv/wallet-relay' { export class WalletRelayService { constructor (opts: Record<string, unknown>); createSession (opts?: { origin?: string }): Promise<unknown> } }\n"
  }
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))],
    skipLibCheck: true
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  host.getSourceFile = (name, lang) =>
    name in files ? ts.createSourceFile(name, files[name], lang) : getSourceFile(name, lang)
  host.fileExists = name => name in files || fileExists(name)
  host.readFile = name => files[name] ?? readFile(name)
  const program = ts.createProgram(Object.keys(files), options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('renderAgentsMd', () => {
  test('documents a project with no installed capabilities without empty wiring blocks', () => {
    const md = renderAgentsMd(
      {
        ...config,
        capabilities: []
      },
      []
    )

    expect(md).toContain('# demo — agent guide')
    expect(md).not.toContain('## Wiring')
    expect(md).not.toContain('### `server/src/index.ts`')
  })

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

  test.each([
    ['add mode', config],
    ['--no-glue', { ...config, mode: 'new' as const, glue: false }]
  ])('%s: the wallet-connect server snippet compiles on its own', (_label, cfg) => {
    const snippet = serverSnippet(renderAgentsMd(cfg, [walletConnect]))
    // config.ts is written only for new glued projects, so the snippet must not import it.
    expect(snippet).not.toContain('config.js')
    expect(snippet).toContain('SERVER_ORIGIN is required in production')
    expect(typecheckServerSnippet(snippet)).toEqual([])
  })

  test('manual wiring env note lists SERVER_ORIGIN next to SERVER_PRIVATE_KEY', () => {
    const md = renderAgentsMd(config, [walletConnect])
    const note = md.split('\n').find(l => l.startsWith('> **`SERVER_PRIVATE_KEY`**')) ?? ''
    expect(note).toContain('`SERVER_ORIGIN`')
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
