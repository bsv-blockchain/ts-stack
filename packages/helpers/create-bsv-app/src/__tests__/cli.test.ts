import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
})

describe('run --yes new (flags)', () => {
  test('scaffolds new react project with wallet-login via fake runCommand', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
    const res = await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--frontend', 'react', '--capabilities', 'wallet-login', '--yes'],
      undefined,
      { runCommand: fake }
    )
    expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(res.deps.root).toHaveProperty('@bsv/wallet-relay')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.stack.frontend.framework).toBe('react')
    expect(manifest.capabilities).toEqual(['wallet-login'])
  })
})

describe('run --yes add (existing manifest)', () => {
  test('adds wallet-login to existing express project (no runCommand called)', async () => {
    // First: scaffold new express project
    const newCalls: string[][] = []
    const fake: RunCommand = () => { newCalls.push([]) }
    await run(
      ['--dir', dir, '--mode', 'new', '--name', 'myapp', '--backend', 'express', '--capabilities', 'wallet-login', '--yes'],
      undefined,
      { runCommand: fake }
    )
    const firstManifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(firstManifest.stack.backend.framework).toBe('express')

    // Second: add-mode run — existing manifest detected, no runCommand needed
    const addCalls: string[][] = []
    const fakeAdd: RunCommand = () => { addCalls.push([]); throw new Error('runCommand should not be called in add mode') }
    await run(
      ['--dir', dir, '--capabilities', 'wallet-login', '--yes'],
      undefined,
      { runCommand: fakeAdd }
    )
    expect(addCalls).toHaveLength(0)
    // written may be 0 (files already exist, skipped) but AGENTS.md always written
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
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
    expect(res.written).toContain('src/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-login'])
  })

  test('add-mode config file places only (no runCommand called)', async () => {
    const fakeAdd: RunCommand = () => { throw new Error('runCommand should not be called in add mode') }
    const cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'add',
      name: 'add-from-file',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: ['wallet-login']
    }), 'utf8')
    const res = await run(['--dir', dir, '--file', cfgPath], undefined, { runCommand: fakeAdd })
    expect(res.written).toContain('src/bsv/auth.ts')
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
