import { expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfig } from '../pipeline'
import type { ProjectConfig } from '../config/model'
import type { RunCommand } from '../scaffold/base-scaffolder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-pipe-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const newConfig: ProjectConfig = {
  mode: 'new',
  name: 'demo',
  dir: '.',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-login'],
  glue: false,
  packageManager: 'npm',
  network: 'test'
}

test('applyConfig new-mode scaffolds via runCommand and reports skipped=[]', () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
  const res = applyConfig(newConfig, dir, { runCommand: fake })
  expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
  expect(res.written).toContain('src/bsv/auth.ts')
  expect(res.skipped).toEqual([])
  expect(existsSync(join(dir, 'bsv-scaffold.json'))).toBe(true)
})

test('applyConfig add-mode places only (no runCommand) and writes manifest', () => {
  const addConfig: ProjectConfig = { ...newConfig, mode: 'add' }
  const boom: RunCommand = () => { throw new Error('must not run a command in add mode') }
  const res = applyConfig(addConfig, dir, { runCommand: boom, force: false })
  expect(res.written).toContain('src/bsv/auth.ts')
  const manifest = JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8'))
  expect(manifest.capabilities).toEqual(['wallet-login'])
})

test('applyConfig add-mode with force:false preserves an existing util file', () => {
  const addConfig: ProjectConfig = { ...newConfig, mode: 'add' }
  const noop: RunCommand = () => {}
  // pre-create the util file with sentinel content
  mkdirSync(join(dir, 'src', 'bsv'), { recursive: true })
  writeFileSync(join(dir, 'src', 'bsv', 'auth.ts'), '// SENTINEL', 'utf8')
  const res = applyConfig(addConfig, dir, { runCommand: noop, force: false })
  expect(res.skipped).toContain('src/bsv/auth.ts')
  expect(res.written).not.toContain('src/bsv/auth.ts')
  expect(readFileSync(join(dir, 'src', 'bsv', 'auth.ts'), 'utf8')).toBe('// SENTINEL')
})
