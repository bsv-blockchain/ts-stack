import { expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfig } from '../pipeline'
import type { ProjectConfig } from '../config/model'
import type { RunCommand } from '../scaffold/base-scaffolder'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cba-pipe-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const newConfig: ProjectConfig = {
  mode: 'new',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  targets: { client: '' },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-login'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}

test('applyConfig new-mode scaffolds via runCommand and reports skipped=[]', () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => {
    calls.push([command, ...args])
  }
  const res = applyConfig(newConfig, dir, { runCommand: fake })
  expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
  // new-mode expands requires: wallet-login → wallet-connect + wallet-login, so auth.ts comes from wallet-connect
  expect(res.written).toContain('src/bsv/auth.ts')
  expect(res.skipped).toEqual([])
  expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
})

test('applyConfig add-mode places wallet-login and the wallet-connect it requires', () => {
  // add mode expands requires like new mode: wallet-connect's files, deps and manifest entry come along
  const addConfig: ProjectConfig = { ...newConfig, mode: 'add' }
  const boom: RunCommand = () => {
    throw new Error('must not run a command in add mode')
  }
  const res = applyConfig(addConfig, dir, { runCommand: boom, force: false })
  expect(res.written).toContain('src/bsv/auth.ts') // wallet-connect's shared file
  expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
  expect(res.deps.client['@bsv/sdk']).toBeDefined()
  const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
  expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
})

test('applyConfig add-mode keeps an installed wallet-connect file unless forced', () => {
  const addConfig: ProjectConfig = {
    ...newConfig,
    mode: 'add',
    capabilities: ['wallet-connect', 'tx-core']
  }
  mkdirSync(join(dir, 'src', 'bsv'), { recursive: true })
  writeFileSync(join(dir, 'src', 'bsv', 'auth.ts'), '// SENTINEL', 'utf8')
  const kept = applyConfig(addConfig, dir, { runCommand: () => {}, force: false })
  expect(kept.skipped).toContain('src/bsv/auth.ts')
  expect(readFileSync(join(dir, 'src', 'bsv', 'auth.ts'), 'utf8')).toBe('// SENTINEL')
  const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
  expect(manifest.capabilities).toEqual(['wallet-connect', 'tx-core']) // not duplicated
  const forced = applyConfig(addConfig, dir, { runCommand: () => {}, force: true })
  expect(forced.written).toContain('src/bsv/auth.ts')
  expect(readFileSync(join(dir, 'src', 'bsv', 'auth.ts'), 'utf8')).not.toBe('// SENTINEL')
})

test('applyConfig carries the resolved pulled list on the result', () => {
  const pulled = [{ id: 'wallet-connect', requiredBy: ['wallet-login'] }]
  const res = applyConfig({ ...newConfig, mode: 'add', pulled }, dir, {
    runCommand: () => {},
    force: false
  })
  expect(res.pulled).toEqual(pulled)
  expect(applyConfig({ ...newConfig, mode: 'add' }, dir, { runCommand: () => {} }).pulled).toEqual(
    []
  )
})

test('applyConfig add-mode with force:false preserves an existing util file', () => {
  const addConfig: ProjectConfig = { ...newConfig, mode: 'add' }
  const noop: RunCommand = () => {}
  // pre-create the useWalletLogin.tsx with sentinel content
  mkdirSync(join(dir, 'src', 'bsv'), { recursive: true })
  writeFileSync(join(dir, 'src', 'bsv', 'useWalletLogin.tsx'), '// SENTINEL', 'utf8')
  const res = applyConfig(addConfig, dir, { runCommand: noop, force: false })
  expect(res.skipped).toContain('src/bsv/useWalletLogin.tsx')
  expect(res.written).not.toContain('src/bsv/useWalletLogin.tsx')
  expect(readFileSync(join(dir, 'src', 'bsv', 'useWalletLogin.tsx'), 'utf8')).toBe('// SENTINEL')
})

test('applyConfig new-mode written includes AGENTS.md, manifest, and main.tsx (matches /plan)', () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => {
    calls.push([command, ...args])
  }
  const glueConfig: ProjectConfig = { ...newConfig, glue: true }
  const res = applyConfig(glueConfig, dir, { runCommand: fake })
  expect(res.written).toContain('src/bsv/auth.ts')
  expect(res.written).toContain('AGENTS.md')
  expect(res.written).toContain('bsv-scaffold.json')
  expect(res.written).toContain('src/main.tsx') // assembleAndWrite, new+glue+frontend-only
})

test('applyConfig add-mode written includes AGENTS.md and manifest', () => {
  const addConfig: ProjectConfig = { ...newConfig, mode: 'add' }
  const noop: RunCommand = () => {}
  const res = applyConfig(addConfig, dir, { runCommand: noop, force: false })
  expect(res.written).toContain('AGENTS.md')
  expect(res.written).toContain('bsv-scaffold.json')
})

test('raises an old sdk floor in add mode', () => {
  for (const t of ['client', 'server']) {
    mkdirSync(join(dir, t), { recursive: true })
    writeFileSync(
      join(dir, t, 'package.json'),
      JSON.stringify({ dependencies: { '@bsv/sdk': '^2.4.1' } }),
      'utf8'
    )
  }
  const addConfig: ProjectConfig = {
    ...newConfig,
    mode: 'add',
    stack: {
      frontend: { framework: 'react', variant: 'react-ts' },
      backend: { framework: 'express' }
    },
    targets: { client: 'client', server: 'server' },
    capabilities: ['tx-core'] // wallet-connect comes along as a requirement
  }
  const res = applyConfig(addConfig, dir, { runCommand: () => {}, force: false })
  expect(res.written).toContain('server/src/bsv/auth.ts')
  const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
  expect(manifest.capabilities).toEqual(['wallet-connect', 'tx-core'])
  for (const t of ['client', 'server']) {
    const pkg = JSON.parse(readFileSync(join(dir, t, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@bsv/sdk']).toBe('^4.0.1')
  }
  expect(res.dependencyChanges).toEqual([
    { target: 'client', name: '@bsv/sdk', from: '^2.4.1', to: '^4.0.1', action: 'raised' },
    { target: 'server', name: '@bsv/sdk', from: '^2.4.1', to: '^4.0.1', action: 'raised' }
  ])
})
