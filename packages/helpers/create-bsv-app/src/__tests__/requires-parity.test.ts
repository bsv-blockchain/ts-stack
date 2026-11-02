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

const manifest: ProjectManifest = {
  version: 2,
  name: 'demo',
  network: 'test',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  targets: { client: '' },
  bsvDir: 'src/bsv',
  capabilities: []
}
const requested = ['tx-core', 'wallet-login'] // deliberately not in registry order
const closed = ['wallet-connect', 'wallet-login', 'tx-core']
const pulled = [{ id: 'wallet-connect', requiredBy: ['wallet-login', 'tx-core'] }]

function project(name: string): string {
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

test('--file, --yes, prompts, /plan and /generate agree on the closed list and the pulled notice', async () => {
  const fileDir = project('file')
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

  const yesDir = project('yes')
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

  const uiDir = project('ui')
  const srv = await startUiServer({
    existing: manifest,
    targetDir: uiDir,
    flags: { install: false }
  })
  try {
    const plan = await (await uiPost(srv.url, '/plan', { capabilities: requested })).json()
    expect(plan.pulled).toEqual(pulled)
    const paths = (plan.files as Array<{ path: string }>).map(f => f.path)
    expect(paths).toEqual(expect.arrayContaining(['src/bsv/auth.ts', 'src/bsv/useWalletLogin.tsx']))
    expect((await uiPost(srv.url, '/generate', { capabilities: requested })).status).toBe(200)
    expect((await srv.done).pulled).toEqual(pulled)
    expect(recorded(uiDir)).toEqual(closed)
  } finally {
    srv.close()
  }
})
