import { expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startUiServer, runUi } from '../ui-server'
import type { UiServer } from '../ui-server'
import type { RunCommand } from '../../scaffold/base-scaffolder'
import type { ProjectManifest } from '../../config/project-manifest'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-uisrv-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const noopRun: RunCommand = () => {}

test('GET / serves the self-contained page', async () => {
  const srv: UiServer = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const res = await fetch(srv.url)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('create-bsv-app')
    expect(html).toContain('window.__SCHEMA__')
  } finally { srv.close() }
})

test('GET / in new mode includes "Always included" banner', async () => {
  const srv: UiServer = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const res = await fetch(srv.url)
    const html = await res.text()
    expect(html).toContain('Always included')
  } finally { srv.close() }
})

test('POST /generate (valid new draft) scaffolds, resolves done, and 200s', async () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
  const target = join(dir, 'app')
  const srv: UiServer = await startUiServer({ existing: null, targetDir: target, deps: { runCommand: fake } })
  const srvUrl: string = srv.url
  const res = await fetch(`${srvUrl}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'react', capabilities: ['wallet-connect'] })
  })
  const data = await res.json()
  expect(res.status).toBe(200)
  expect(data.written).toContain('src/bsv/auth.ts')
  expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
  expect(existsSync(join(target, 'bsv-scaffold.json'))).toBe(true)
  const result = await srv.done
  expect(result.targetDir).toBe(target)
})

// Item 5: new-mode POST /generate with wallet-login — confirms wallet-login file is written
test('POST /generate (new, wallet-login) scaffolds and includes useWalletLogin.tsx', async () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => { calls.push([command, ...args]) }
  const target = join(dir, 'app2')
  const srv: UiServer = await startUiServer({ existing: null, targetDir: target, deps: { runCommand: fake } })
  const srvUrl: string = srv.url
  const res = await fetch(`${srvUrl}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'react', capabilities: ['wallet-login'] })
  })
  const data = await res.json()
  expect(res.status).toBe(200)
  // wallet-login requires wallet-connect; new-mode expands, so auth.ts (wallet-connect) is placed
  expect(data.written).toContain('src/bsv/auth.ts')
  // wallet-login's own client file
  expect(data.written).toContain('src/bsv/useWalletLogin.tsx')
  expect(calls.some(c => c.includes('vite@latest'))).toBe(true)
  expect(existsSync(join(target, 'bsv-scaffold.json'))).toBe(true)
  const result = await srv.done
  expect(result.targetDir).toBe(target)
})

test('POST /generate (invalid: new with no targets) returns 400 and stays up', async () => {
  const srv: UiServer = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  const srvUrl: string = srv.url
  try {
    const res = await fetch(`${srvUrl}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'none', backend: 'none' })
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(String(data.error)).toMatch(/frontend or a backend/i)
    expect((await fetch(srvUrl)).status).toBe(200)
  } finally { srv.close() }
})

test('runUi opens the browser then resolves after the simulated submit', async () => {
  const target = join(dir, 'app2')
  const result = await runUi({
    existing: null,
    targetDir: target,
    runCommand: noopRun,
    openBrowser: (url: string) => {
      void fetch(`${url}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'react', capabilities: ['wallet-connect'] })
      })
    }
  })
  expect(result.targetDir).toBe(target)
  expect(result.written).toContain('src/bsv/auth.ts')
})

test('POST /generate add-mode does NOT overwrite existing capability files (force=false)', async () => {
  const existing: ProjectManifest = {
    version: 1,
    name: 'demo',
    network: 'test',
    stack: { frontend: { framework: 'react', variant: 'react-ts' } },
    bsvDir: 'src/bsv',
    capabilities: []
  }
  mkdirSync(join(dir, 'src', 'bsv'), { recursive: true })
  writeFileSync(join(dir, 'src', 'bsv', 'auth.ts'), '// SENTINEL', 'utf8')
  const srv = await startUiServer({ existing, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const srvUrl: string = srv.url
    const res = await fetch(srvUrl + '/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: ['wallet-login'] })
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(dir, 'src', 'bsv', 'auth.ts'), 'utf8')).toBe('// SENTINEL')
  } finally { srv.close() }
})
