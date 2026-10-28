import { expect, jest, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startUiServer, runUi } from '../ui-server'
import { run } from '../../cli'
import { serializeSchema, PAGE_DRAFT_SRC } from '../ui-page'
import * as pipeline from '../../pipeline'
import type { UiServer } from '../ui-server'
import type { RunCommand } from '../../scaffold/base-scaffolder'
import type { ProjectManifest } from '../../config/project-manifest'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cba-uisrv-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const noopRun: RunCommand = () => {}

async function uiHeaders(url: string): Promise<Record<string, string>> {
  const html = await (await fetch(url)).text()
  const serializedToken = /window\.__SESSION_TOKEN__ = ("[A-Za-z0-9_-]+");/u.exec(html)?.[1]
  if (serializedToken === undefined) throw new Error('UI session token missing from page')
  return {
    'content-type': 'application/json',
    'x-create-bsv-app-session': JSON.parse(serializedToken) as string,
    origin: url
  }
}

test('GET / serves the self-contained page', async () => {
  const srv: UiServer = await startUiServer({
    existing: null,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  try {
    const res = await fetch(srv.url)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('create-bsv-app')
    expect(html).toContain('window.__SCHEMA__')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/u)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  } finally {
    srv.close()
  }
})

test('mutating endpoints reject cross-origin and tokenless requests before running commands', async () => {
  const runCommand = jest.fn<RunCommand>()
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand } })
  try {
    const hostile = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://attacker.example' },
      body: JSON.stringify({ mode: 'new', name: 'owned', frontend: 'react' })
    })
    expect(hostile.status).toBe(403)

    const sameOriginWithoutToken = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.url },
      body: JSON.stringify({ mode: 'new', name: 'owned', frontend: 'react' })
    })
    expect(sameOriginWithoutToken.status).toBe(403)
    expect(runCommand).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'owned'))).toBe(false)
  } finally {
    srv.close()
  }
})

test('UI session tokens do not authorize another server instance', async () => {
  const first = await startUiServer({
    existing: null,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  const second = await startUiServer({
    existing: null,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  try {
    const firstHeaders = await uiHeaders(first.url)
    const response = await fetch(`${second.url}/plan`, {
      method: 'POST',
      headers: { ...firstHeaders, origin: second.url },
      body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'react' })
    })
    expect(response.status).toBe(403)
  } finally {
    first.close()
    second.close()
  }
})

test('POST bodies are JSON-only and bounded before parsing', async () => {
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const headers = await uiHeaders(srv.url)
    const wrongType = await fetch(`${srv.url}/plan`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain' },
      body: '{}'
    })
    expect(wrongType.status).toBe(415)

    const oversized = await fetch(`${srv.url}/plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) })
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Request body is too large.' })
  } finally {
    srv.close()
  }
})

test('GET / in new mode includes "Always included" banner', async () => {
  const srv: UiServer = await startUiServer({
    existing: null,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  try {
    const res = await fetch(srv.url)
    const html = await res.text()
    expect(html).toContain('Always included')
  } finally {
    srv.close()
  }
})

type Draft = Record<string, unknown>

function pageGlobal(html: string, name: string): Draft {
  const json = new RegExp(`window\\.${name} = (.*);`, 'u').exec(html)?.[1]
  if (json === undefined) throw new Error(`${name} missing from page`)
  return JSON.parse(json) as Draft
}

function pageSeed(html: string): Draft {
  return pageGlobal(html, '__SEED__')
}

const { modeDrafts, payloadOf } = new Function(`${PAGE_DRAFT_SRC}
return { modeDrafts, payloadOf }`)() as {
  modeDrafts: (
    schema: unknown,
    seed: Draft,
    modeSeeds: Record<string, Draft>
  ) => Record<string, Draft>
  payloadOf: (schema: unknown, draft: Draft, modeSeeds: Record<string, Draft>, seed: Draft) => Draft
}

/** What the shipped page posts after the user picks `edit.mode` (if any) and applies `edit`. */
function pagePayload(html: string, edit: Draft = {}): Draft {
  const schema = pageGlobal(html, '__SCHEMA__')
  const seed = pageSeed(html)
  const seeds = pageGlobal(html, '__MODE_SEEDS__') as Record<string, Draft>
  const draft = { ...modeDrafts(schema, seed, seeds)[String(edit.mode ?? seed.mode)], ...edit }
  return payloadOf(schema, draft, seeds, seed)
}

test('GET / in new mode seeds every offerable capability as selected', async () => {
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const seed = pageSeed(await (await fetch(srv.url)).text())
    const offerable =
      serializeSchema(null)
        .flatMap(s => s.fields)
        .find(f => f.key === 'capabilities')
        ?.options?.map(o => o.value) ?? []
    expect(offerable.length).toBeGreaterThan(0)
    expect(seed.capabilities).toEqual(expect.arrayContaining([...offerable, 'wallet-connect']))
  } finally {
    srv.close()
  }
})

test('GET / in add mode seeds only the manifest capabilities', async () => {
  const existing: ProjectManifest = {
    version: 1,
    name: 'demo',
    network: 'test',
    stack: { frontend: { framework: 'react', variant: 'react-ts' } },
    bsvDir: 'src/bsv',
    capabilities: ['wallet-login']
  }
  const srv = await startUiServer({ existing, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const seed = pageSeed(await (await fetch(srv.url)).text())
    expect(seed.capabilities).toEqual(['wallet-login'])
  } finally {
    srv.close()
  }
})

test('--ui flags seed the page and flag-only values (bsvDir) reach the generated config', async () => {
  const target = join(dir, 'app')
  const srv = await startUiServer({
    existing: null,
    targetDir: target,
    flags: { name: 'flagged', network: 'main', bsvDir: 'lib/bsv' },
    deps: { runCommand: noopRun }
  })
  try {
    const seed = pageSeed(await (await fetch(srv.url)).text())
    expect(seed).toMatchObject({ name: 'flagged', network: 'main', bsvDir: 'lib/bsv' })
    expect(seed.capabilities).toEqual(expect.arrayContaining(['wallet-connect', 'wallet-login']))
    // the page submits only visible schema fields; the server re-applies --bsv-dir
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'flagged',
        frontend: 'react',
        capabilities: ['wallet-connect']
      })
    })
    expect(res.status).toBe(200)
    expect((await res.json()).written).toContain('lib/bsv/auth.ts')
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest.bsvDir).toBe('lib/bsv')
  } finally {
    srv.close()
  }
})

test('POST /generate (valid new draft) scaffolds, resolves done, and 200s', async () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => {
    calls.push([command, ...args])
  }
  const target = join(dir, 'app')
  const srv: UiServer = await startUiServer({
    existing: null,
    targetDir: target,
    deps: { runCommand: fake }
  })
  try {
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        capabilities: ['wallet-connect']
      })
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.written).toContain('src/bsv/auth.ts')
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    expect(existsSync(join(target, 'bsv-scaffold.json'))).toBe(true)
    const result = await srv.done
    expect(result.targetDir).toBe(target)
  } finally {
    srv.close()
  }
})

// Item 5: new-mode POST /generate with wallet-login — confirms wallet-login file is written
test('POST /generate (new, wallet-login) scaffolds and includes useWalletLogin.tsx', async () => {
  const calls: string[][] = []
  const fake: RunCommand = (command, args) => {
    calls.push([command, ...args])
  }
  const target = join(dir, 'app2')
  const srv: UiServer = await startUiServer({
    existing: null,
    targetDir: target,
    deps: { runCommand: fake }
  })
  try {
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        capabilities: ['wallet-login']
      })
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    // wallet-login requires wallet-connect; new-mode expands, so auth.ts (wallet-connect) is placed
    expect(data.written).toContain('src/bsv/auth.ts')
    // wallet-login's own client file
    expect(data.written).toContain('src/bsv/useWalletLogin.tsx')
    expect(calls.some(c => c.includes('vite@9.1.1'))).toBe(true)
    expect(existsSync(join(target, 'bsv-scaffold.json'))).toBe(true)
    const result = await srv.done
    expect(result.targetDir).toBe(target)
  } finally {
    srv.close()
  }
})

test('POST /generate (invalid: new with no targets) returns 400 and stays up', async () => {
  const srv: UiServer = await startUiServer({
    existing: null,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  const srvUrl: string = srv.url
  try {
    const res = await fetch(`${srvUrl}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'none', backend: 'none' })
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data).toEqual({
      error: 'Invalid config: a new project needs at least a frontend or a backend'
    })
    expect((await fetch(srvUrl)).status).toBe(200)
  } finally {
    srv.close()
  }
})

test('POST /generate does not expose unexpected command failures', async () => {
  const internalMessage = 'secret filesystem detail from an internal stack'
  const failingRun: RunCommand = () => {
    throw new Error(internalMessage)
  }
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const srv = await startUiServer({
    existing: null,
    targetDir: join(dir, 'failed-app'),
    deps: { runCommand: failingRun }
  })
  try {
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        capabilities: ['wallet-connect']
      })
    })
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data).toEqual({ error: 'Project generation failed.' })
    expect(JSON.stringify(data)).not.toContain(internalMessage)
    expect(errorSpy).toHaveBeenCalledWith(
      'Project generation failed:',
      expect.objectContaining({ message: internalMessage })
    )
  } finally {
    srv.close()
    errorSpy.mockRestore()
  }
})

test('runUi opens the browser then resolves after the simulated submit', async () => {
  const target = join(dir, 'app2')
  const result = await runUi({
    existing: null,
    targetDir: target,
    runCommand: noopRun,
    openBrowser: (url: string) => {
      void (async () => {
        await fetch(`${url}/generate`, {
          method: 'POST',
          headers: await uiHeaders(url),
          body: JSON.stringify({
            mode: 'new',
            name: 'demo',
            frontend: 'react',
            capabilities: ['wallet-connect']
          })
        })
      })()
    }
  })
  expect(result.targetDir).toBe(target)
  expect(result.written).toContain('src/bsv/auth.ts')
})

test('POST /plan returns the real BSV files create-bsv-app would write (new mode)', async () => {
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const srvUrl: string = srv.url
    const res = await fetch(srvUrl + '/plan', {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        capabilities: ['wallet-login']
      })
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    const paths = data.files.map((f: { path: string }) => f.path)
    expect(paths).toContain('src/bsv/auth.ts')
    expect(paths).toContain('src/bsv/WalletContext.tsx')
    expect(paths).toContain('AGENTS.md')
    expect(data.files.every((f: { status: string }) => f.status === 'new')).toBe(true)
  } finally {
    srv.close()
  }
})

test('POST /plan marks an existing file as edit', async () => {
  mkdirSync(join(dir, 'src', 'bsv'), { recursive: true })
  writeFileSync(join(dir, 'src', 'bsv', 'auth.ts'), '// existing', 'utf8')
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const srvUrl: string = srv.url
    const res = await fetch(srvUrl + '/plan', {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        capabilities: ['wallet-login']
      })
    })
    const data = await res.json()
    const auth = data.files.find((f: { path: string }) => f.path === 'src/bsv/auth.ts')
    expect(auth.status).toBe('edit')
  } finally {
    srv.close()
  }
})

test('POST /plan returns { files: [], error } for an invalid draft', async () => {
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const srvUrl: string = srv.url
    const res = await fetch(srvUrl + '/plan', {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({ mode: 'new', name: 'demo', frontend: 'none', backend: 'none' })
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.files).toEqual([])
    expect(typeof data.error).toBe('string')
  } finally {
    srv.close()
  }
})

test('POST /plan does not expose unexpected parser details', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  const srv = await startUiServer({ existing: null, targetDir: dir, deps: { runCommand: noopRun } })
  try {
    const res = await fetch(`${srv.url}/plan`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: '{'
    })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toEqual({ files: [], error: 'Unable to generate project plan.' })
    expect(JSON.stringify(data)).not.toMatch(/JSON|position|stack/i)
    expect(errorSpy).toHaveBeenCalledWith(
      'Project plan generation failed:',
      expect.any(SyntaxError)
    )
  } finally {
    srv.close()
    errorSpy.mockRestore()
  }
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
      headers: await uiHeaders(srv.url),
      body: JSON.stringify({ capabilities: ['wallet-login'] })
    })
    expect(res.status).toBe(200)
    expect(readFileSync(join(dir, 'src', 'bsv', 'auth.ts'), 'utf8')).toBe('// SENTINEL')
  } finally {
    srv.close()
  }
})

const reactManifest: ProjectManifest = {
  version: 1,
  name: 'demo',
  network: 'test',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: [],
  targets: { client: '' }
}

test('add mode honours --skip-install, --no-glue and --package-manager although the page hides them', async () => {
  const runCommand = jest.fn<RunCommand>()
  const applySpy = jest.spyOn(pipeline, 'applyConfig')
  const srv = await startUiServer({
    existing: reactManifest,
    targetDir: dir,
    flags: { install: false, glue: false, packageManager: 'pnpm' },
    deps: { runCommand }
  })
  try {
    const body = pagePayload(await (await fetch(srv.url)).text(), {
      capabilities: ['wallet-login']
    })
    expect(body).toEqual({ mode: 'add', capabilities: ['wallet-login'] })
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify(body)
    })
    expect(res.status).toBe(200)
    expect(runCommand).not.toHaveBeenCalled()
    expect(applySpy.mock.calls[0]?.[0]).toMatchObject({
      mode: 'add',
      install: false,
      glue: false,
      packageManager: 'pnpm'
    })
  } finally {
    srv.close()
    applySpy.mockRestore()
  }
})

test('a visible field the user changed in the UI wins over its CLI flag', async () => {
  const target = join(dir, 'app')
  const srv = await startUiServer({
    existing: null,
    targetDir: target,
    flags: { name: 'flagged', network: 'main', install: false },
    deps: { runCommand: noopRun }
  })
  try {
    const body = pagePayload(await (await fetch(srv.url)).text(), {
      name: 'edited',
      network: 'ttn',
      install: true
    })
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify(body)
    })
    expect(res.status).toBe(200)
    const result = await srv.done
    expect(result.installed).toBe(true)
    const manifest = JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'edited', network: 'ttn' })
  } finally {
    srv.close()
  }
})

test('flipping an existing project to new mode does not carry its targets or bsvDir', async () => {
  const srv = await startUiServer({
    existing: reactManifest,
    targetDir: dir,
    deps: { runCommand: noopRun }
  })
  try {
    const html = await (await fetch(srv.url)).text()
    // as with --mode new in the terminal, the name starts empty rather than from the manifest
    expect(pagePayload(html, { mode: 'new' }).name).toBeUndefined()
    const body = pagePayload(html, {
      mode: 'new',
      name: 'fresh',
      backend: 'express',
      capabilities: ['wallet-connect']
    })
    expect(body).not.toHaveProperty('targets')
    expect(body).not.toHaveProperty('bsvDir')
    const res = await fetch(`${srv.url}/plan`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify(body)
    })
    const paths = ((await res.json()).files as Array<{ path: string }>).map(f => f.path)
    expect(paths).toContain('client/src/bsv/auth.ts')
    expect(paths.filter(p => p.startsWith('src/'))).toEqual([])
  } finally {
    srv.close()
  }
})

test('add mode without a detectable project reports the actual config error', async () => {
  const runCommand = jest.fn<RunCommand>()
  const srv = await startUiServer({
    existing: null,
    targetDir: dir,
    flags: { mode: 'add' },
    deps: { runCommand }
  })
  try {
    const html = await (await fetch(srv.url)).text()
    expect(html).toContain('{"value":"add","label":"Add to existing"}')
    const body = JSON.stringify(pagePayload(html))
    const headers = await uiHeaders(srv.url)
    const plan = await fetch(`${srv.url}/plan`, { method: 'POST', headers, body })
    expect(await plan.json()).toEqual({ files: [], error: 'Invalid config: name is required' })
    const gen = await fetch(`${srv.url}/generate`, { method: 'POST', headers, body })
    expect(gen.status).toBe(400)
    expect(await gen.json()).toEqual({ error: 'Invalid config: name is required' })
    expect(runCommand).not.toHaveBeenCalled()
  } finally {
    srv.close()
  }
})

test('flipping a project to New applies new-only CLI flags, as --mode new does', async () => {
  const srv = await startUiServer({
    existing: reactManifest,
    targetDir: dir,
    flags: { network: 'main' },
    deps: { runCommand: noopRun }
  })
  try {
    const body = pagePayload(await (await fetch(srv.url)).text(), { mode: 'new' })
    expect(body).toMatchObject({ mode: 'new', network: 'main' })
  } finally {
    srv.close()
  }
})

test('new mode pre-ticks every offered capability even when a project exists', async () => {
  const srv = await startUiServer({
    existing: reactManifest,
    targetDir: dir,
    flags: { mode: 'new' },
    deps: { runCommand: noopRun }
  })
  try {
    const html = await (await fetch(srv.url)).text()
    const offered =
      serializeSchema(null)
        .flatMap(s => s.fields)
        .find(f => f.key === 'capabilities')
        ?.options?.map(o => o.value) ?? []
    expect(offered.length).toBeGreaterThan(0)
    const seeds = pageGlobal(html, '__MODE_SEEDS__') as Record<string, Draft>
    expect(pageSeed(html).capabilities).toEqual(expect.arrayContaining(offered))
    expect(seeds.new.capabilities).toEqual(expect.arrayContaining(offered))
    expect(seeds.add.capabilities).toEqual([]) // add mode never pre-ticks
  } finally {
    srv.close()
  }
})

test('the page gets the target directory for the copied command', async () => {
  const srv = await startUiServer({
    existing: null,
    targetDir: '../proj',
    deps: { runCommand: noopRun }
  })
  try {
    const html = await (await fetch(srv.url)).text()
    expect(html).toContain('window.__TARGET_DIR__ = "../proj";')
  } finally {
    srv.close()
  }
})

/** Starts the UI server the way `run` wires `--ui`, without opening a browser. */
async function uiFromCli(argv: string[]): Promise<UiServer> {
  let srv: UiServer | undefined
  await run(argv, undefined, {
    startUi: async o => {
      srv = await startUiServer({ ...o, deps: { runCommand: noopRun } })
      return {
        targetDir: o.targetDir,
        deps: { root: {}, client: {}, server: {} },
        written: [],
        skipped: []
      }
    }
  })
  if (srv === undefined) throw new Error('UI server not started')
  return srv
}

test('--ui defaults the name to the target directory, as --yes does, so add mode works without a project', async () => {
  const target = join(dir, 'my-app')
  mkdirSync(target)
  const srv = await uiFromCli(['--ui', '--dir', target])
  try {
    const html = await (await fetch(srv.url)).text()
    expect(pagePayload(html).name).toBe('my-app')
    const headers = await uiHeaders(srv.url)
    const body = JSON.stringify(pagePayload(html, { mode: 'add', capabilities: ['wallet-login'] }))
    const plan = await (await fetch(`${srv.url}/plan`, { method: 'POST', headers, body })).json()
    expect(plan.error).toBeUndefined()
    const gen = await fetch(`${srv.url}/generate`, { method: 'POST', headers, body })
    expect(gen.status).toBe(200)
    expect(JSON.parse(readFileSync(join(target, 'bsv-scaffold.json'), 'utf8')).name).toBe('my-app')
  } finally {
    srv.close()
  }
})

test('--ui --name wins over the directory default', async () => {
  const srv = await uiFromCli(['--ui', '--dir', dir, '--name', 'flagged'])
  try {
    const html = await (await fetch(srv.url)).text()
    expect(pagePayload(html).name).toBe('flagged')
    expect(pagePayload(html, { mode: 'add' })).not.toHaveProperty('name')
  } finally {
    srv.close()
  }
})

test('--ui on a manifest project keeps its name in add mode and uses the directory name in new mode', async () => {
  const target = join(dir, 'fresh-dir')
  mkdirSync(target)
  writeFileSync(join(target, 'bsv-scaffold.json'), JSON.stringify(reactManifest), 'utf8')
  const applySpy = jest.spyOn(pipeline, 'applyConfig')
  const srv = await uiFromCli(['--ui', '--dir', target])
  try {
    const html = await (await fetch(srv.url)).text()
    // matches --yes --mode new in this directory
    expect(pagePayload(html, { mode: 'new' }).name).toBe('fresh-dir')
    const res = await fetch(`${srv.url}/generate`, {
      method: 'POST',
      headers: await uiHeaders(srv.url),
      body: JSON.stringify(pagePayload(html, { capabilities: ['wallet-login'] }))
    })
    expect(res.status).toBe(200)
    expect(applySpy.mock.calls[0]?.[0]).toMatchObject({ mode: 'add', name: 'demo' })
  } finally {
    srv.close()
    applySpy.mockRestore()
  }
})
