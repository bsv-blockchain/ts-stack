// src/__tests__/requires-parity.test.ts
// The same add-mode request through every entry point closes to the same list and pulls the same notice.
import { expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'
import { runPrompts } from '../prompts'
import { startUiServer } from '../ui/ui-server'
import type { ProjectManifest } from '../config/project-manifest'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cba-parity-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const base: ProjectManifest = {
  version: 2,
  name: 'demo',
  network: 'test',
  stack: {},
  bsvDir: 'src/bsv',
  capabilities: []
}
const react = { frontend: { framework: 'react' as const, variant: 'react-ts' } }
const express = { backend: { framework: 'express' as const } }

interface ParityCase {
  layout: string
  manifest: ProjectManifest
  requested: string[]
  closed: string[]
  pulled: Array<{ id: string; requiredBy: string[] }>
  /** Paths /plan must list, and paths it must not. */
  planned: string[]
  absent: string[]
}

const cases: ParityCase[] = [
  {
    layout: 'frontend-only',
    manifest: { ...base, stack: react, targets: { client: '' } },
    requested: ['tx-core', 'wallet-login'], // deliberately not in registry order
    closed: ['wallet-connect', 'wallet-login', 'tx-core'],
    pulled: [{ id: 'wallet-connect', requiredBy: ['wallet-login', 'tx-core'] }],
    planned: ['src/bsv/auth.ts', 'src/bsv/useWalletLogin.tsx'],
    absent: []
  },
  {
    // tx-core needs wallet-connect only for its client page, so it is not named here
    layout: 'backend-only',
    manifest: { ...base, stack: express, targets: { server: '' } },
    requested: ['tx-core', 'wallet-login'],
    closed: ['wallet-connect', 'wallet-login', 'tx-core'],
    pulled: [{ id: 'wallet-connect', requiredBy: ['wallet-login'] }],
    planned: ['src/bsv/auth.ts', 'src/bsv/loginRoute.ts', 'src/bsv/transactions.ts'],
    absent: []
  },
  {
    layout: 'backend-only, tx-core alone',
    manifest: { ...base, stack: express, targets: { server: '' } },
    requested: ['tx-core'],
    closed: ['tx-core'],
    pulled: [],
    planned: ['src/bsv/transactions.ts', 'src/bsv/txUtils.ts'],
    absent: ['src/bsv/auth.ts', 'src/bsv/nonceStore.ts']
  },
  {
    layout: 'monorepo',
    manifest: {
      ...base,
      stack: { ...react, ...express },
      targets: { client: 'client', server: 'server' }
    },
    requested: ['tx-core'],
    closed: ['wallet-connect', 'tx-core'],
    pulled: [{ id: 'wallet-connect', requiredBy: ['tx-core'] }],
    planned: ['client/src/bsv/TransactionsDemo.tsx', 'client/src/bsv/auth.ts'],
    absent: []
  }
]

function project(name: string, manifest: ProjectManifest): string {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify(manifest), 'utf8')
  return dir
}

function recorded(dir: string): string[] {
  return (JSON.parse(readFileSync(join(dir, 'bsv-scaffold.json'), 'utf8')) as ProjectManifest)
    .capabilities
}

async function uiPost(url: string, path: string, body: unknown): Promise<Response> {
  const html = await (await fetch(url)).text()
  const token = /window\.__SESSION_TOKEN__ = ("[A-Za-z0-9_-]+");/u.exec(html)?.[1] ?? '""'
  return await fetch(url + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-create-bsv-app-session': JSON.parse(token) as string,
      origin: url
    },
    body: JSON.stringify(body)
  })
}

test.each(cases)(
  '$layout: --file, --yes, prompts, /plan and /generate agree on the closed list and the pulled notice',
  async ({ manifest, requested, closed, pulled, planned, absent }) => {
    const fileDir = project('file', manifest)
    const cfg = join(root, 'cfg.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        mode: 'add',
        name: 'demo',
        stack: manifest.stack,
        capabilities: requested,
        install: false
      }),
      'utf8'
    )
    const fromFile = await run(['--dir', fileDir, '--file', cfg])
    expect(recorded(fileDir)).toEqual(closed)
    expect(fromFile.pulled).toEqual(pulled)

    const yesDir = project('yes', manifest)
    const fromYes = await run([
      '--dir',
      yesDir,
      '--capabilities',
      requested.join(','),
      '--skip-install',
      '--yes'
    ])
    expect(recorded(yesDir)).toEqual(closed)
    expect(fromYes.pulled).toEqual(pulled)

    const fromPrompts = await runPrompts({ existing: manifest, flags: {} }, async field =>
      field.key === 'capabilities' ? requested : undefined
    )
    expect(fromPrompts.capabilities).toEqual(closed)
    expect(fromPrompts.pulled).toEqual(pulled)

    const uiDir = project('ui', manifest)
    const srv = await startUiServer({
      existing: manifest,
      targetDir: uiDir,
      flags: { install: false }
    })
    try {
      const plan = await (await uiPost(srv.url, '/plan', { capabilities: requested })).json()
      expect(plan.pulled).toEqual(pulled)
      const paths = (plan.files as Array<{ path: string }>).map(f => f.path)
      expect(paths).toEqual(expect.arrayContaining(planned))
      for (const path of absent) expect(paths).not.toContain(path)
      expect((await uiPost(srv.url, '/generate', { capabilities: requested })).status).toBe(200)
      expect((await srv.done).pulled).toEqual(pulled)
      expect(recorded(uiDir)).toEqual(closed)
    } finally {
      srv.close()
    }
  }
)
