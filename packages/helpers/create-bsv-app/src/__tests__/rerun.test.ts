import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'
import { readValidManifest } from '../config/project-manifest'
import type { RunCommand } from '../scaffold/base-scaffolder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-re-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('re-run add flow', () => {
  // Items 3 & 4: use wallet-login layout; strict dedup assertion + loginRoute/useWalletLogin + AGENTS.md
  test('second run reuses locked stack, unions capabilities, regenerates AGENTS.md (wallet-connect + wallet-login)', async () => {
    // First run: scaffold new project with wallet-connect + wallet-login (monorepo with backend)
    const fake: RunCommand = () => {}
    await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--backend', 'express', '--frontend', 'react', '--capabilities', 'wallet-connect,wallet-login', '--yes'],
      undefined,
      { runCommand: fake }
    )
    const first = readValidManifest(dir)
    if (first == null) throw new Error('manifest not written after first run')
    expect(first.stack.backend?.framework).toBe('express')
    // monorepo: auth.ts lands in both client/ and server/ bsvDir prefixes
    expect(existsSync(join(dir, 'client/src/bsv/auth.ts'))).toBe(true)
    // loginRoute.ts is placed under server bsvDir (monorepo)
    expect(existsSync(join(dir, 'server/src/bsv/loginRoute.ts'))).toBe(true)
    // useWalletLogin.tsx is placed under client bsvDir (monorepo)
    expect(existsSync(join(dir, 'client/src/bsv/useWalletLogin.tsx'))).toBe(true)

    // Second run: --yes add (mode auto-detected from manifest), same capabilities — union with dedup
    await run(
      ['--dir', dir, '--capabilities', 'wallet-connect,wallet-login', '--yes']
    )

    const after = readValidManifest(dir)
    if (after == null) throw new Error('manifest not written after second run')
    expect(after.stack.backend?.framework).toBe('express')
    // Item 3: STRICT dedup assertion — no duplicates after re-run
    expect(after.capabilities).toEqual(['wallet-connect', 'wallet-login'])
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    // Item 4: both wallet-connect and wallet-login sections appear
    expect(agentsMd).toContain('## wallet-connect')
    expect(agentsMd).toContain('## wallet-login')
  })

  test('second run via provider: existing manifest passed, capabilities unioned', async () => {
    const fake: RunCommand = () => {}
    await run(
      ['--dir', dir, '--mode', 'new', '--name', 'demo', '--backend', 'express', '--capabilities', 'wallet-connect,wallet-login', '--yes'],
      undefined,
      { runCommand: fake }
    )

    const provider = async (ctx: { existing: import('../config/project-manifest').ProjectManifest | null }): Promise<import('../config/model').ProjectConfig> => {
      const existing = ctx.existing
      if (existing == null) throw new Error('expected existing manifest')
      return {
        mode: 'add',
        name: existing.name,
        dir: '.',
        stack: existing.stack,
        bsvDir: existing.bsvDir,
        capabilities: [...existing.capabilities], // same caps, union handled by seedDraft when using --yes, here provider owns it
        glue: false,
        packageManager: 'npm',
        network: existing.network
      }
    }
    await run(['--dir', dir], provider)

    const after = readValidManifest(dir)
    if (after == null) throw new Error('manifest not written after second run')
    expect(after.stack.backend?.framework).toBe('express')
    expect(after.capabilities).toEqual(['wallet-connect', 'wallet-login'])
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('## wallet-connect')
    expect(agentsMd).toContain('## wallet-login')
  })
})
