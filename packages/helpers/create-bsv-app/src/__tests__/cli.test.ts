import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, run } from '../cli'
import type { RunCommand } from '../scaffold/base-scaffolder'
import type { RunResult } from '../pipeline'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-cli-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('parseArgs', () => {
  test('collects config flags into draft + control flags', () => {
    const a = parseArgs(['--dir', 'x', '--mode', 'new', '--frontend', 'react', '--capabilities', 'wallet-login', '--yes'])
    expect(a).toMatchObject({ dir: 'x', yes: true, force: false })
    expect(a.draft).toMatchObject({ mode: 'new', frontend: 'react', capabilities: ['wallet-login'] })
  })

  test('defaults: yes=false, force=false, draft={}', () => {
    const a = parseArgs([])
    expect(a.yes).toBe(false)
    expect(a.force).toBe(false)
    expect(a.draft).toEqual({})
  })

  test('--force sets force:true', () => {
    const a = parseArgs(['--force'])
    expect(a.force).toBe(true)
  })

  test('--file captures file path', () => {
    const a = parseArgs(['--file', '/some/config.json'])
    expect(a.file).toBe('/some/config.json')
  })

  test('--mode add sets draft.mode=add', () => {
    const a = parseArgs(['--mode', 'add'])
    expect(a.draft.mode).toBe('add')
  })

  test('trailing --dir flag with no value does not blow up', () => {
    expect(() => parseArgs(['--dir'])).not.toThrow()
  })

  test('--capabilities splits comma-separated values into array', () => {
    const a = parseArgs(['--capabilities', 'wallet-login,another-cap'])
    expect(a.draft.capabilities).toEqual(['wallet-login', 'another-cap'])
  })

  test('--network main sets draft.network=main', () => {
    const a = parseArgs(['--network', 'main'])
    expect(a.draft.network).toBe('main')
  })

  test('positional arg sets dir', () => {
    const a = parseArgs(['myproject'])
    expect(a.dir).toBe('myproject')
  })

  test('--ui sets ui:true', () => {
    expect(parseArgs(['--ui']).ui).toBe(true)
  })
  test('ui defaults to false', () => {
    expect(parseArgs([]).ui).toBe(false)
  })
  test('--no-glue sets draft.glue=false', () => {
    expect(parseArgs(['--no-glue']).draft.glue).toBe(false)
  })
})

describe('run --yes new (flags)', () => {
  test('scaffolds new react project with wallet-connect via fake runCommand', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    const res = await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--frontend', 'react', '--capabilities', 'wallet-connect', '--yes'],
      undefined,
      { runCommand: fake }
    )
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/walletAcquisition.ts')
    expect(res.deps.root).toHaveProperty('@bsv/sdk')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.stack.frontend.framework).toBe('react')
    expect(manifest.capabilities).toContain('wallet-connect')
  })

  // Item 1: new-mode with --capabilities wallet-login expands requires → wallet-connect + wallet-login
  test('new-mode --capabilities wallet-login pre-seeds wallet-connect (requires expansion)', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    const res = await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--frontend', 'react', '--capabilities', 'wallet-login', '--yes'],
      undefined,
      { runCommand: fake }
    )
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    // auth.ts comes from wallet-connect (expanded from wallet-login requires)
    expect(res.written).toContain('src/bsv/auth.ts')
    // wallet-login client file
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    // seedDraft pre-selects defaultSelected caps (wallet-connect), so both end up in manifest
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
  })
})

describe('run --yes new --no-glue with a variant', () => {
  test('emits the contexts (so the hook compiles) but skips the main.tsx wiring', async () => {
    const fake: RunCommand = () => {}
    const res = await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--frontend', 'react', '--capabilities', 'wallet-login', '--no-glue', '--yes'],
      undefined,
      { runCommand: fake }
    )
    // contexts are core files now → present even with --no-glue, so useWalletLogin's import resolves
    expect(res.written).toContain('src/bsv/WalletContext.tsx')
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(res.written).toContain('src/bsv/auth.ts')
    // main.tsx assembly is suppressed by --no-glue; vite is faked so it isn't created at all
    expect(existsSync(join(dir, 'src/main.tsx'))).toBe(false)
  })
})

describe('run --yes add (existing manifest)', () => {
  test('adds wallet-connect to existing express project (no runCommand called)', async () => {
    // First: scaffold new express project with wallet-connect
    const newCalls: string[][] = []
    const fake: RunCommand = () => { newCalls.push([]) }
    await run(
      ['--dir', dir, '--mode', 'new', '--name', 'myapp', '--backend', 'express', '--capabilities', 'wallet-connect', '--yes'],
      undefined,
      { runCommand: fake }
    )
    const firstManifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(firstManifest.stack.backend.framework).toBe('express')

    // Second: add-mode run — existing manifest detected, no runCommand needed
    const addCalls: string[][] = []
    const fakeAdd: RunCommand = () => { addCalls.push([]); throw new Error('runCommand should not be called in add mode') }
    await run(
      ['--dir', dir, '--capabilities', 'wallet-connect', '--yes'],
      undefined,
      { runCommand: fakeAdd }
    )
    expect(addCalls).toHaveLength(0)
    // written may be 0 (files already exist, skipped) but AGENTS.md always written
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
  })

  // Item 2: add-mode with wallet-login — expandRequires:false — must NOT pull wallet-connect
  test('add-mode wallet-login installs exactly wallet-login files; does NOT auto-pull wallet-connect', async () => {
    // Use a subdirectory within dir so beforeEach/afterEach handles cleanup
    const addDir = join(dir, 'add-only')
    const fake: RunCommand = () => {}
    // Use --file add-mode with only wallet-login (no wallet-connect in the config)
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'add',
      name: 'addtest',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: ['wallet-login']
    }), 'utf8')
    const res = await run(['--dir', addDir, '--file', cfgPath], undefined, { runCommand: fake })
    // wallet-login is placed (its own client file)
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    const manifest = JSON.parse(readFileSync(join(addDir, 'bsv-scaffold.json'), 'utf8'))
    // ONLY wallet-login in manifest (add-mode does not expand requires)
    expect(manifest.capabilities).toEqual(['wallet-login'])
    // wallet-connect's files must NOT be placed (expandRequires:false in add-mode)
    expect(res.written).not.toContain('src/bsv/walletAcquisition.ts')
    expect(res.written).not.toContain('src/bsv/WalletContext.tsx')
  })
})

describe('run --file (direct manifest door)', () => {
  test('new-mode config file scaffolds via fake runCommand', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    const cfgPath = join(dir, 'config.json')
    const target = join(dir, 'app') // keep target empty (config.json lives in parent)
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'new',
      name: 'from-file',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: ['wallet-login']
    }), 'utf8')
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    // new-mode expands requires: wallet-login → wallet-connect + wallet-login, auth.ts from wallet-connect
    expect(res.written).toContain('src/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
  })

  test('new-mode config with zero capabilities still scaffolds the wallet-connect baseline', async () => {
    const fake: RunCommand = () => {}
    const cfgPath = join(dir, 'cfg.json')
    const target = join(dir, 'app0')
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'new',
      name: 'zero',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: []
    }), 'utf8')
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: fake })
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/WalletContext.tsx')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect'])
  })

  test('new-mode scaffolds normally when the dir holds only a manifest (reproduce-from-manifest)', async () => {
    // Drop just a bsv-scaffold.json into the target and scaffold a NEW project from it.
    const target = join(dir, 'reproduce')
    mkdirSync(target, { recursive: true })
    const manifestPath = join(target, 'bsv-scaffold.json')
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      name: 'reproduced',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-connect', 'wallet-login']
    }), 'utf8')
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    // A lone manifest must NOT trip the empty-dir guard; new mode runs the base generator.
    const res = await run(['--dir', target, '--file', manifestPath], undefined, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    expect(res.written).toContain('src/bsv/auth.ts')
    // the existing manifest is rewritten (regenerated from the config)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
  })

  test('new-mode still errors when the dir holds non-manifest files', async () => {
    const target = join(dir, 'dirty')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'README.md'), '# pre-existing', 'utf8')
    const cfgPath = join(dir, 'c.json')
    writeFileSync(cfgPath, JSON.stringify({ mode: 'new', name: 'x', stack: { frontend: { framework: 'react', variant: 'react-ts' } } }), 'utf8')
    await expect(run(['--dir', target, '--file', cfgPath], undefined, { runCommand: () => {} })).rejects.toThrow(/not empty/i)
  })

  test('new-mode scaffolds into a freshly git-init-ed dir (a lone .git does not count as non-empty)', async () => {
    const target = join(dir, 'gitfirst')
    mkdirSync(join(target, '.git'), { recursive: true }) // simulate `git init`
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    const cfgPath = join(dir, 'g.json')
    writeFileSync(cfgPath, JSON.stringify({ mode: 'new', name: 'g', stack: { backend: { framework: 'express' } } }), 'utf8')
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: () => {} })
    expect(res.written).toContain('bsv-scaffold.json') // scaffolded, no "not empty" error
    expect(existsSync(join(target, '.git', 'HEAD'))).toBe(true) // .git left untouched
  })

  test('--mode add overrides a file whose mode is new (runs add, no base generator)', async () => {
    const fakeAdd: RunCommand = () => { throw new Error('runCommand should not run in add mode') }
    const cfgPath = join(dir, 'newish.json')
    // file declares mode:new + a frontend, but --mode add must override → add path
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'new', name: 'ov', stack: { frontend: { framework: 'react', variant: 'react-ts' } }, capabilities: ['wallet-login']
    }), 'utf8')
    const res = await run(['--dir', dir, '--file', cfgPath, '--mode', 'add'], undefined, { runCommand: fakeAdd })
    // add mode: only wallet-login's own files, no wallet-connect floor pulled in
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(res.written).not.toContain('src/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-login'])
  })

  test('add-mode config file places wallet-login files only (no auth.ts, expandRequires:false)', async () => {
    const fakeAdd: RunCommand = () => { throw new Error('runCommand should not be called in add mode') }
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'add',
      name: 'add-from-file',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: ['wallet-login']
    }), 'utf8')
    const res = await run(['--dir', dir, '--file', cfgPath], undefined, { runCommand: fakeAdd })
    // wallet-login in add-mode: no auth.ts (that's wallet-connect's file)
    expect(res.written).not.toContain('src/bsv/auth.ts')
    // wallet-login's own client file is placed
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
  })
})

describe('run interactive (no --yes)', () => {
  test('throws if no provider given', async () => {
    await expect(run(['--dir', dir])).rejects.toThrow(/interactive run requires a config provider/)
  })

  test('calls provider with existing=null for fresh dir, uses returned config', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    const provider = async (): Promise<import('../config/model').ProjectConfig> => ({
      mode: 'new',
      name: 'interactive-test',
      dir: '.',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-login'],
      glue: false,
      packageManager: 'npm',
      network: 'test'
    })
    const res = await run(['--dir', dir], provider, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    // new-mode expands requires: wallet-login → wallet-connect + wallet-login, so auth.ts is placed
    expect(res.written).toContain('src/bsv/auth.ts')
  })
})

describe('run --ui', () => {
  test('delegates to the injected startUi with existing + targetDir and returns its result', async () => {
    const seen: Array<{ targetDir: string }> = []
    const stub = async (o: { existing: unknown, targetDir: string, runCommand?: unknown }): Promise<RunResult> => {
      seen.push({ targetDir: o.targetDir })
      return { targetDir: o.targetDir, deps: { root: {}, client: {}, server: {} }, written: ['src/bsv/auth.ts'], skipped: [] }
    }
    const res = await run(['--dir', dir, '--ui'], undefined, { startUi: stub })
    expect(seen).toEqual([{ targetDir: dir }])
    expect(res.written).toContain('src/bsv/auth.ts')
  })
})
