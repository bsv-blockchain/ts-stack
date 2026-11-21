import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CLI_HELP, parseArgs, run, summaryNotice } from '../cli'
import type { RunCommand } from '../scaffold/base-scaffolder'
import type { RunResult } from '../pipeline'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cba-cli-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseArgs', () => {
  test('documents the executable usage and all supported flag groups', () => {
    expect(CLI_HELP).toContain('Usage: create-bsv-app')
    expect(CLI_HELP).toContain('--starter <name>')
    expect(CLI_HELP).toContain('--capabilities <names>')
    expect(CLI_HELP).toContain('-h, --help')
  })

  test('collects config flags into draft + control flags', () => {
    const a = parseArgs([
      '--dir',
      'x',
      '--mode',
      'new',
      '--frontend',
      'react',
      '--variant',
      'react-ts',
      '--bsv-dir',
      'src/bsv',
      '--capabilities',
      'wallet-login',
      '--glue',
      '--install',
      '--yes'
    ])
    expect(a).toMatchObject({ dir: 'x', yes: true, force: false })
    expect(a.draft).toMatchObject({
      mode: 'new',
      frontend: 'react',
      frontendVariant: 'react-ts',
      bsvDir: 'src/bsv',
      capabilities: ['wallet-login'],
      glue: true,
      install: true
    })
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

  test('validates mode, backend, and package-manager values', () => {
    expect(parseArgs(['--package-manager', 'pnpm']).draft.packageManager).toBe('pnpm')
    expect(() => parseArgs(['--package-manager', 'maven'])).toThrow(/npm, pnpm, yarn, or bun/i)
    expect(() => parseArgs(['--mode', 'replace'])).toThrow(/new or add/i)
    expect(() => parseArgs(['--backend', 'fastify'])).toThrow(/express or none/i)
  })

  test('new/add subcommands set the mode and allow one positional target', () => {
    expect(parseArgs(['new', 'my-app']).draft.mode).toBe('new')
    expect(parseArgs(['new', 'my-app']).dir).toBe('my-app')
    expect(parseArgs(['add']).draft.mode).toBe('add')
  })

  test('rejects conflicting mode flags and subcommands', () => {
    expect(() => parseArgs(['--mode', 'new', 'add'])).toThrow(/conflicting mode/i)
  })

  test('rejects unknown options, invalid enum values, and extra positionals', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown option/i)
    expect(() => parseArgs(['--network', 'regtest'])).toThrow(/main, test, or ttn/i)
    expect(() => parseArgs(['one', 'two'])).toThrow(/unexpected argument/i)
  })

  test('--starter selects a registry entry and rejects missing ids', () => {
    expect(parseArgs(['--starter', 'meter']).draft.starter).toBe('meter')
    expect(() => parseArgs(['--starter', 'convo'])).toThrow(/unknown starter/i)
  })

  test('trailing --dir flag with no value is rejected', () => {
    expect(() => parseArgs(['--dir'])).toThrow(/requires a value/i)
  })

  test('--capabilities splits comma-separated values into array', () => {
    const a = parseArgs(['--capabilities', 'wallet-login,another-cap'])
    expect(a.draft.capabilities).toEqual(['wallet-login', 'another-cap'])
  })

  test('--network main sets draft.network=main', () => {
    const a = parseArgs(['--network', 'main'])
    expect(a.draft.network).toBe('main')
  })

  test('--network ttn sets draft.network=ttn', () => {
    const a = parseArgs(['--network', 'ttn'])
    expect(a.draft.network).toBe('ttn')
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
  test('modern new <dir> form derives the project name from the target', async () => {
    const target = join(dir, 'friendly-name')
    await run(['new', target, '--starter', 'express', '--skip-install', '--yes'], undefined, {
      runCommand: () => {}
    })
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.name).toBe('friendly-name')
    expect(manifest.starter.id).toBe('express')
  })

  test('scaffolds new react project with wallet-connect via fake runCommand', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => {
      calls.push([command, ...args])
    }
    const res = await run(
      [
        '--dir',
        dir,
        '--mode',
        'new',
        '--name',
        'demo',
        '--frontend',
        'react',
        '--capabilities',
        'wallet-connect',
        '--yes'
      ],
      undefined,
      { runCommand: fake }
    )
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/walletAcquisition.ts')
    expect(res.deps.client).toHaveProperty('@bsv/sdk')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.version).toBe(2)
    expect(manifest.stack.frontend.framework).toBe('react')
    expect(manifest.capabilities).toContain('wallet-connect')
  })

  // Item 1: new-mode with --capabilities wallet-login expands requires → wallet-connect + wallet-login
  test('new-mode --capabilities wallet-login pre-seeds wallet-connect (requires expansion)', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => {
      calls.push([command, ...args])
    }
    const res = await run(
      [
        '--dir',
        dir,
        '--mode',
        'new',
        '--name',
        'demo',
        '--frontend',
        'react',
        '--capabilities',
        'wallet-login',
        '--yes'
      ],
      undefined,
      { runCommand: fake }
    )
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    // auth.ts comes from wallet-connect (expanded from wallet-login requires)
    expect(res.written).toContain('src/bsv/auth.ts')
    // wallet-login client file
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    // seedDraft pre-selects defaultSelected caps (wallet-connect, tx-core), so all three end up in manifest, in registry order
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
  })
})

describe('run --yes new --no-glue with a variant', () => {
  test('emits the contexts (so the hook compiles) but skips the main.tsx wiring', async () => {
    const fake: RunCommand = () => {}
    const res = await run(
      [
        '--dir',
        dir,
        '--mode',
        'new',
        '--name',
        'demo',
        '--frontend',
        'react',
        '--capabilities',
        'wallet-login',
        '--no-glue',
        '--yes'
      ],
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
    const fake: RunCommand = () => {
      newCalls.push([])
    }
    await run(
      [
        '--dir',
        dir,
        '--mode',
        'new',
        '--name',
        'myapp',
        '--backend',
        'express',
        '--capabilities',
        'wallet-connect',
        '--yes'
      ],
      undefined,
      { runCommand: fake }
    )
    const firstManifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(firstManifest.stack.backend.framework).toBe('express')

    // Second: add-mode run — existing manifest detected, no runCommand needed
    const addCalls: string[][] = []
    const fakeAdd: RunCommand = () => {
      addCalls.push([])
      throw new Error('runCommand should not be called in add mode')
    }
    await run(
      ['--dir', dir, '--capabilities', 'wallet-connect', '--skip-install', '--yes'],
      undefined,
      { runCommand: fakeAdd }
    )
    expect(addCalls).toHaveLength(0)
    // written may be 0 (files already exist, skipped) but AGENTS.md always written
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
  })

  // add mode pulls what a requested capability requires, records it, and reports it
  test('add-mode wallet-login also installs the wallet-connect it requires', async () => {
    // Use a subdirectory within dir so beforeEach/afterEach handles cleanup
    const addDir = join(dir, 'add-only')
    const fake: RunCommand = () => {}
    // Use --file add-mode with only wallet-login (no wallet-connect in the config)
    const cfgPath = join(dir, 'config.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'add',
        name: 'addtest',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: ['wallet-login']
      }),
      'utf8'
    )
    const res = await run(['--dir', addDir, '--file', cfgPath], undefined, { runCommand: fake })
    // wallet-login is placed (its own client file)
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    const manifest = JSON.parse(readFileSync(join(addDir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
    // wallet-connect's files are placed too
    expect(res.written).toContain('src/bsv/walletAcquisition.ts')
    expect(res.written).toContain('src/bsv/WalletContext.tsx')
    expect(res.pulled).toEqual([{ id: 'wallet-connect', requiredBy: ['wallet-login'] }])
  })

  test('--yes add of tx-core onto a wallet-login project pulls nothing it already has', async () => {
    writeFileSync(
      join(dir, 'bsv-scaffold.json'),
      JSON.stringify({
        version: 2,
        name: 'demo',
        network: 'test',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        targets: { client: '' },
        bsvDir: 'src/bsv',
        capabilities: ['wallet-connect', 'wallet-login']
      }),
      'utf8'
    )
    const res = await run(['--dir', dir, '--capabilities', 'tx-core', '--skip-install', '--yes'])
    expect(res.pulled).toEqual([])
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
  })
})

describe('run --file (direct manifest door)', () => {
  test('new-mode config file scaffolds via fake runCommand', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => {
      calls.push([command, ...args])
    }
    const cfgPath = join(dir, 'config.json')
    const target = join(dir, 'app') // keep target empty (config.json lives in parent)
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'new',
        name: 'from-file',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: ['wallet-login']
      }),
      'utf8'
    )
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    // new-mode expands requires: wallet-login → wallet-connect + wallet-login, auth.ts from wallet-connect
    expect(res.written).toContain('src/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
  })

  test('new-mode config with zero capabilities still scaffolds the wallet-connect baseline', async () => {
    const fake: RunCommand = () => {}
    const cfgPath = join(dir, 'cfg.json')
    const target = join(dir, 'app0')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'new',
        name: 'zero',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: []
      }),
      'utf8'
    )
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: fake })
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/WalletContext.tsx')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'tx-core'])
  })

  test('new-mode scaffolds normally when the dir holds only a manifest (reproduce-from-manifest)', async () => {
    // Drop just a bsv-scaffold.json into the target and scaffold a NEW project from it.
    const target = join(dir, 'reproduce')
    mkdirSync(target, { recursive: true })
    const manifestPath = join(target, 'bsv-scaffold.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        name: 'reproduced',
        network: 'test',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        bsvDir: 'src/bsv',
        capabilities: ['wallet-connect', 'wallet-login']
      }),
      'utf8'
    )
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => {
      calls.push([command, ...args])
    }
    // A lone manifest must NOT trip the empty-dir guard; new mode runs the base generator.
    const res = await run(['--dir', target, '--file', manifestPath], undefined, {
      runCommand: fake
    })
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    expect(res.written).toContain('src/bsv/auth.ts')
    // the existing manifest is rewritten (regenerated from the config)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
  })

  test('new-mode still errors when the dir holds non-manifest files', async () => {
    const target = join(dir, 'dirty')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'README.md'), '# pre-existing', 'utf8')
    const cfgPath = join(dir, 'c.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'new',
        name: 'x',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } }
      }),
      'utf8'
    )
    await expect(
      run(['--dir', target, '--file', cfgPath], undefined, { runCommand: () => {} })
    ).rejects.toThrow(/not empty/i)
  })

  test('new-mode scaffolds into a freshly git-init-ed dir (a lone .git does not count as non-empty)', async () => {
    const target = join(dir, 'gitfirst')
    mkdirSync(join(target, '.git'), { recursive: true }) // simulate `git init`
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    const cfgPath = join(dir, 'g.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({ mode: 'new', name: 'g', stack: { backend: { framework: 'express' } } }),
      'utf8'
    )
    const res = await run(['--dir', target, '--file', cfgPath], undefined, { runCommand: () => {} })
    expect(res.written).toContain('bsv-scaffold.json') // scaffolded, no "not empty" error
    expect(existsSync(join(target, '.git', 'HEAD'))).toBe(true) // .git left untouched
  })

  test('--mode add overrides a file whose mode is new (runs add, no base generator)', async () => {
    const fakeAdd: RunCommand = () => {
      throw new Error('runCommand should not run in add mode')
    }
    const cfgPath = join(dir, 'newish.json')
    // file declares mode:new + a frontend, but --mode add must override → add path
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'new',
        name: 'ov',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: ['wallet-login'],
        install: false
      }),
      'utf8'
    )
    const res = await run(['--dir', dir, '--file', cfgPath, '--mode', 'add'], undefined, {
      runCommand: fakeAdd
    })
    // add mode: no new-mode floor (tx-core), but wallet-login's requirement comes along
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(res.written).toContain('src/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login'])
  })

  test('add-mode config file places wallet-login and the wallet-connect it requires', async () => {
    const fakeAdd: RunCommand = () => {
      throw new Error('runCommand should not be called in add mode')
    }
    const cfgPath = join(dir, 'config.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'add',
        name: 'add-from-file',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: ['wallet-login'],
        install: false
      }),
      'utf8'
    )
    const res = await run(['--dir', dir, '--file', cfgPath], undefined, { runCommand: fakeAdd })
    // wallet-login requires wallet-connect, whose auth.ts is placed too
    expect(res.written).toContain('src/bsv/auth.ts')
    // wallet-login's own client file is placed
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
  })
})

describe('run --file add mode with an existing manifest', () => {
  test('keeps the capabilities the manifest records', async () => {
    writeFileSync(
      join(dir, 'bsv-scaffold.json'),
      JSON.stringify({
        version: 2,
        name: 'demo',
        network: 'test',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        targets: { client: '' },
        bsvDir: 'src/bsv',
        capabilities: ['wallet-connect', 'wallet-login']
      }),
      'utf8'
    )
    const cfgPath = join(dir, 'add.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        mode: 'add',
        name: 'demo',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: ['tx-core'],
        install: false
      }),
      'utf8'
    )
    const res = await run(['--dir', dir, '--file', cfgPath])
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
    expect(res.pulled).toEqual([])
  })

  const recorded = {
    version: 2,
    name: 'chain-app',
    network: 'main',
    stack: { frontend: { framework: 'react', variant: 'react-ts' } },
    targets: { client: 'web' },
    bsvDir: 'src/chain',
    capabilities: ['wallet-connect'],
    starter: { id: 'react', kind: 'generated' }
  }
  let result: RunResult
  const addWith = async (cfg: Record<string, unknown>): Promise<Record<string, unknown>> => {
    writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify(recorded), 'utf8')
    const cfgPath = join(dir, 'add.json')
    writeFileSync(cfgPath, JSON.stringify({ install: false, ...cfg }), 'utf8')
    result = await run(['--dir', dir, '--file', cfgPath, '--mode', 'add'])
    return JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
  }

  test.each([
    ['name', 'chain-app'],
    ['network', 'main'],
    ['bsvDir', 'src/chain'],
    ['stack', recorded.stack],
    ['targets', recorded.targets]
  ])('seeds %s from the manifest when the file leaves it unset', async (key, value) => {
    // every other key is set, so only `key` can come from the manifest
    const full: Record<string, unknown> = {
      name: 'chain-app',
      network: 'main',
      bsvDir: 'src/chain',
      stack: recorded.stack,
      targets: recorded.targets
    }
    delete full[key]
    const manifest = await addWith({ ...full, capabilities: ['tx-core'] })
    expect(manifest[key]).toEqual(value)
  })

  test('seeds the starter from the manifest when the file leaves it unset', async () => {
    await addWith({ name: 'chain-app', stack: recorded.stack, capabilities: [] })
    expect(result.starter).toBe('react')
  })

  test('keys the file sets win over the manifest', async () => {
    const manifest = await addWith({
      name: 'renamed',
      network: 'ttn',
      stack: recorded.stack,
      capabilities: []
    })
    expect(manifest.name).toBe('renamed')
    expect(manifest.network).toBe('ttn')
    expect(manifest.bsvDir).toBe('src/chain')
  })

  test('a custom network and bsvDir survive, and new files go under the recorded bsvDir', async () => {
    const manifest = await addWith({
      name: 'chain-app',
      stack: recorded.stack,
      capabilities: ['tx-core']
    })
    expect(manifest.network).toBe('main')
    expect(manifest.bsvDir).toBe('src/chain')
    expect(existsSync(join(dir, 'web', 'src', 'chain', 'transactions.ts'))).toBe(true)
    expect(existsSync(join(dir, 'web', 'src', 'bsv'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'bsv'))).toBe(false)
  })

  test('a stackless file adds to a project whose manifest records a stack', async () => {
    const manifest = await addWith({ capabilities: ['tx-core'] })
    expect(manifest.capabilities).toEqual(['wallet-connect', 'tx-core'])
  })
})

describe('run interactive (no --yes)', () => {
  test('throws if no provider given', async () => {
    await expect(run(['--dir', dir])).rejects.toThrow(/interactive run requires a config provider/)
  })

  test('calls provider with existing=null for fresh dir, uses returned config', async () => {
    const calls: string[][] = []
    const fake: RunCommand = (command, args) => {
      calls.push([command, ...args])
    }
    const provider = async (): Promise<import('../config/model').ProjectConfig> => ({
      mode: 'new',
      name: 'interactive-test',
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
    })
    const res = await run(['--dir', dir], provider, { runCommand: fake })
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    // new-mode expands requires: wallet-login → wallet-connect + wallet-login, so auth.ts is placed
    expect(res.written).toContain('src/bsv/auth.ts')
  })
})

describe('run --ui', () => {
  test('delegates to the injected startUi with existing + targetDir and returns its result', async () => {
    const seen: Array<{ targetDir: string }> = []
    const stub = async (o: {
      existing: unknown
      targetDir: string
      runCommand?: unknown
    }): Promise<RunResult> => {
      seen.push({ targetDir: o.targetDir })
      return {
        targetDir: o.targetDir,
        deps: { root: {}, client: {}, server: {} },
        written: ['src/bsv/auth.ts'],
        skipped: [],
        dependencyChanges: [],
        pulled: []
      }
    }
    const res = await run(['--dir', dir, '--ui'], undefined, { startUi: stub })
    expect(seen).toEqual([{ targetDir: dir }])
    expect(res.written).toContain('src/bsv/auth.ts')
  })

  test('passes the parsed CLI flags through to startUi', async () => {
    const seen: unknown[] = []
    const stub = async (o: { targetDir: string; flags?: unknown }): Promise<RunResult> => {
      seen.push(o.flags)
      return {
        targetDir: o.targetDir,
        deps: { root: {}, client: {}, server: {} },
        written: [],
        skipped: [],
        dependencyChanges: [],
        pulled: []
      }
    }
    await run(['--dir', dir, '--ui', '--bsv-dir', 'lib/bsv', '--network', 'main'], undefined, {
      startUi: stub
    })
    // the name is defaulted from the target directory, as for --yes
    expect(seen).toEqual([{ bsvDir: 'lib/bsv', network: 'main', name: basename(dir) }])
  })

  test('rejects flags the form cannot correct before starting the UI, as --yes does', async () => {
    let started = false
    const stub = async (o: { targetDir: string }): Promise<RunResult> => {
      started = true
      return {
        targetDir: o.targetDir,
        deps: { root: {}, client: {}, server: {} },
        written: [],
        skipped: [],
        dependencyChanges: [],
        pulled: []
      }
    }
    const yes = ['--dir', dir, '--frontend', 'react', '--yes']
    for (const flags of [
      ['--capabilities', 'wallet-login,nope'],
      ['--bsv-dir', '../outside']
    ]) {
      const expected = await run([...yes, ...flags]).catch((e: Error) => e)
      expect(expected).toHaveProperty('name', 'ConfigError')
      await expect(
        run(['--dir', dir, '--ui', ...flags], undefined, { startUi: stub })
      ).rejects.toThrow((expected as Error).message)
    }
    expect(started).toBe(false)
  })
})

describe('summaryNotice', () => {
  const result: RunResult = {
    targetDir: '.',
    deps: { root: {}, client: {}, server: {} },
    written: [],
    skipped: [],
    dependencyChanges: [],
    pulled: [{ id: 'wallet-connect', requiredBy: ['tx-core'] }]
  }

  test('runs that never prompted print the pulled notice in the summary', () => {
    const line = 'Also adding wallet-connect (required by tx-core).'
    expect(summaryNotice(['--capabilities', 'tx-core', '--yes'], result)).toEqual([line])
    expect(summaryNotice(['--file', 'cfg.json'], result)).toEqual([line])
  })

  test('prompts and --ui already showed it, so the summary does not repeat it', () => {
    expect(summaryNotice(['--capabilities', 'tx-core'], result)).toEqual([])
    expect(summaryNotice(['--ui', '--yes'], result)).toEqual([])
    expect(summaryNotice(['--yes'], { ...result, pulled: [] })).toEqual([])
  })
})

describe('tx-core in a backend-only project', () => {
  test('add pulls nothing and writes no relay deps, files or wiring', async () => {
    writeFileSync(
      join(dir, 'bsv-scaffold.json'),
      JSON.stringify({
        version: 2,
        name: 'api',
        network: 'test',
        stack: { backend: { framework: 'express' } },
        targets: { server: '' },
        bsvDir: 'src/bsv',
        capabilities: []
      }),
      'utf8'
    )
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api' }), 'utf8')
    const res = await run(['--dir', dir, '--capabilities', 'tx-core', '--skip-install', '--yes'])
    expect(res.pulled).toEqual([])
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.capabilities).toEqual(['tx-core'])
    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies
    expect(Object.keys(deps).sort()).toEqual(['@bsv/sdk', '@bsv/wallet-helper'])
    expect(res.written).toContain('src/bsv/transactions.ts')
    expect(existsSync(join(dir, 'src', 'bsv', 'auth.ts'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'bsv', 'nonceStore.ts'))).toBe(false)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(agents).not.toContain('## wallet-connect')
    expect(agents).not.toContain('WalletRelayService')
  })

  test('new pulls nothing: wallet-connect comes only from the default baseline', async () => {
    const target = join(dir, 'api')
    const res = await run(
      ['--dir', target, '--backend', 'express', '--frontend', 'none', '--skip-install', '--yes'],
      undefined,
      { runCommand: () => {} }
    )
    expect(res.pulled).toEqual([])
  })
})
