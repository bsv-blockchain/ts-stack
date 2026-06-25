// src/scaffold/__tests__/new-project.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldNewProject } from '../new-project'
import type { RunCommand } from '../base-scaffolder'
import type { ProjectConfig } from '../../config/model'

let base: string
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'cba-np-')) })
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

function cfg (over: Partial<ProjectConfig>): ProjectConfig {
  return { mode: 'new', name: 'demo', dir: '.', stack: {}, bsvDir: 'src/bsv', capabilities: ['wallet-login'], glue: false, packageManager: 'npm', network: 'test', ...over }
}

describe('scaffoldNewProject', () => {
  test('frontend-only: runs vite (recorded), places react capability files', () => {
    const dir = join(base, 'app')
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    scaffoldNewProject(cfg({ stack: { frontend: { framework: 'react', variant: 'react-ts' } } }), dir, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    expect(existsSync(join(dir, 'src/bsv/auth.ts'))).toBe(true)
    expect(existsSync(join(dir, 'src/bsv/useWalletLogin.tsx'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8')).stack.frontend.framework).toBe('react')
  })

  test('backend-only: writes express skeleton + server capability files (no command)', () => {
    const dir = join(base, 'api')
    const fake: RunCommand = () => { throw new Error('no command expected') }
    scaffoldNewProject(cfg({ stack: { backend: { framework: 'express' } } }), dir, { runCommand: fake })
    expect(existsSync(join(dir, 'src/index.ts'))).toBe(true) // express skeleton
    expect(existsSync(join(dir, 'src/bsv/auth.ts'))).toBe(true)
    expect(existsSync(join(dir, 'src/bsv/loginRoute.ts'))).toBe(true)
  })

  test('monorepo: client/ (vite) + server/ (skeleton) + duplicated shared, independent packages (no root workspace)', () => {
    const dir = join(base, 'full')
    const fake: RunCommand = () => {}
    scaffoldNewProject(cfg({ stack: { frontend: { framework: 'react', variant: 'react-ts' }, backend: { framework: 'express' } } }), dir, { runCommand: fake })
    expect(existsSync(join(dir, 'server/src/index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'client/src/bsv/auth.ts'))).toBe(true)
    expect(existsSync(join(dir, 'server/src/bsv/auth.ts'))).toBe(true) // shared duplicated
    expect(existsSync(join(dir, 'server/src/bsv/loginRoute.ts'))).toBe(true)
    // Independent packages: no root package.json / workspace stitching them together.
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  test('throws on a non-empty target dir', () => {
    const dir = join(base, 'taken')
    mkdirSync(dir); writeFileSync(join(dir, 'x.txt'), 'hi')
    expect(() => scaffoldNewProject(cfg({ stack: { backend: { framework: 'express' } } }), dir, { runCommand: () => {} })).toThrow(/not empty/i)
  })

  test('new-mode monorepo with wallet-connect assembles main.tsx, App.tsx, index.ts via assembleAndWrite', () => {
    const dir = join(base, 'wallet')
    const fake: RunCommand = () => {}
    const result = scaffoldNewProject(cfg({
      stack: { frontend: { framework: 'react', variant: 'react-ts' }, backend: { framework: 'express' } },
      capabilities: ['wallet-connect'],
      glue: true
    }), dir, { runCommand: fake })

    // main.tsx wraps <App /> in <WalletProviders>
    const mainTsx = readFileSync(join(dir, 'client/src/main.tsx'), 'utf8')
    expect(mainTsx).toContain('<WalletProviders>')

    // App.tsx contains the Home route
    const appTsx = readFileSync(join(dir, 'client/src/App.tsx'), 'utf8')
    expect(appTsx).toContain('<Home')

    // server index.ts contains serverWallet and /health
    const indexTs = readFileSync(join(dir, 'server/src/index.ts'), 'utf8')
    expect(indexTs).toContain('serverWallet')
    expect(indexTs).toContain('/health')

    // written list includes the assembled files
    expect(result.written).toContain('client/src/main.tsx')
    expect(result.written).toContain('client/src/App.tsx')
    expect(result.written).toContain('server/src/index.ts')
  })
})
