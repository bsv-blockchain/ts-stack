import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, run } from '../cli'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-cli-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('parseArgs', () => {
  test('parses flags with sensible defaults', () => {
    const a = parseArgs(['--dir', 'x', '--framework', 'react', '--capabilities', 'wallet-login', '--yes'])
    expect(a).toMatchObject({ dir: 'x', framework: 'react', capabilities: ['wallet-login'], yes: true, network: 'test', force: false })
  })

  test('--ui flag sets ui:true', () => {
    const a = parseArgs(['--ui'])
    expect(a.ui).toBe(true)
  })

  test('ui defaults to false', () => {
    const a = parseArgs([])
    expect(a.ui).toBe(false)
  })
})

describe('run (non-interactive)', () => {
  test('installs wallet-login for react with manifest + AGENTS.md', async () => {
    const res = await run(['--dir', dir, '--name', 'demo', '--framework', 'react', '--capabilities', 'wallet-login', '--yes'])
    expect(res.written).toContain('src/bsv/auth.ts')
    expect(res.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(res.dependencies).toHaveProperty('@bsv/wallet-relay')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.framework).toBe('react')
    expect(manifest.capabilities).toEqual(['wallet-login'])
  })
})
