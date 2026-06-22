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

  test('monorepo: client/ (vite) + server/ (skeleton) + workspace + duplicated shared', () => {
    const dir = join(base, 'full')
    const fake: RunCommand = () => {}
    scaffoldNewProject(cfg({ stack: { frontend: { framework: 'react', variant: 'react-ts' }, backend: { framework: 'express' } } }), dir, { runCommand: fake })
    expect(existsSync(join(dir, 'server/src/index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'client/src/bsv/auth.ts'))).toBe(true)
    expect(existsSync(join(dir, 'server/src/bsv/auth.ts'))).toBe(true) // shared duplicated
    expect(existsSync(join(dir, 'server/src/bsv/loginRoute.ts'))).toBe(true)
    const root = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(root.workspaces).toEqual(['client', 'server'])
  })

  test('throws on a non-empty target dir', () => {
    const dir = join(base, 'taken')
    mkdirSync(dir); writeFileSync(join(dir, 'x.txt'), 'hi')
    expect(() => scaffoldNewProject(cfg({ stack: { backend: { framework: 'express' } } }), dir, { runCommand: () => {} })).toThrow(/not empty/i)
  })
})
