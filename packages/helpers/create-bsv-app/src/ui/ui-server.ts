import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serializeSchema, buildPage } from './ui-page.js'
import { openBrowser as defaultOpenBrowser } from './open-browser.js'
import { applyConfig, type RunResult } from '../pipeline.js'
import { resolveDraft, seedDraft, type ConfigDraft } from '../config/draft.js'
import { ConfigError } from '../config/validate.js'
import type { ProjectManifest } from '../config/project-manifest.js'
import { MANIFEST_FILE } from '../config/project-manifest.js'
import type { RunCommand } from '../scaffold/base-scaffolder.js'
import { listCapabilities, resolveCapabilities } from '../registry.js'
import { planPlacement } from '../engine.js'
import type { Layout, ProjectConfig } from '../config/model.js'
import { layoutOf } from '../config/model.js'
import type { Capability } from '../types.js'

export interface UiServer { url: string, done: Promise<RunResult>, close: () => void }

async function readBody (req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function serveIndex (res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

async function handleGenerate (
  req: IncomingMessage,
  res: ServerResponse,
  existing: ProjectManifest | null,
  targetDir: string,
  runCommand: RunCommand | undefined,
  resolveDone: (r: RunResult) => void
): Promise<void> {
  try {
    const draft = JSON.parse(await readBody(req)) as ConfigDraft
    const config = resolveDraft(seedDraft(existing, draft))
    // force:false — preserve existing capability files, matching the CLI default (the user re-runs with intent but we never clobber their edits)
    const result = applyConfig(config, targetDir, { runCommand, force: false })
    sendJson(res, 200, { targetDir: result.targetDir, written: result.written, deps: result.deps })
    resolveDone(result)
  } catch (err) {
    const status = err instanceof ConfigError ? 400 : 500
    sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
  }
}

// Base files touched by glue-wiring in new-mode: main.tsx/App.tsx (frontend) and server/src/index.ts (backend).
function baseGluePaths (layout: Layout): string[] {
  const paths: string[] = []
  if (layout === 'frontend-only' || layout === 'monorepo') {
    const cp = layout === 'monorepo' ? 'client/' : ''
    paths.push(cp + 'src/main.tsx', cp + 'src/App.tsx')
  }
  if (layout === 'monorepo' || layout === 'backend-only') {
    const sp = layout === 'monorepo' ? 'server/' : ''
    paths.push(sp + 'src/index.ts')
  }
  return paths
}

function planPaths (config: ProjectConfig, caps: Capability[]): string[] {
  const placement = planPlacement(config, caps)
  const rawPaths: string[] = [...placement.utilFiles, ...placement.glueFiles].map(f => f.path)
  rawPaths.push('AGENTS.md', MANIFEST_FILE)
  if (config.mode === 'new' && config.glue) rawPaths.push(...baseGluePaths(layoutOf(config.stack)))
  return [...new Set(rawPaths)]
}

async function handlePlan (
  req: IncomingMessage,
  res: ServerResponse,
  existing: ProjectManifest | null,
  targetDir: string
): Promise<void> {
  try {
    const draft = JSON.parse(await readBody(req)) as ConfigDraft
    const config = resolveDraft(seedDraft(existing, draft))
    const caps = resolveCapabilities(config.capabilities, { expandRequires: config.mode === 'new' })
    const files = planPaths(config, caps).map(p => ({ path: p, status: existsSync(join(targetDir, p)) ? 'edit' as const : 'new' as const }))
    sendJson(res, 200, { files })
  } catch (err) {
    sendJson(res, 200, { files: [], error: err instanceof Error ? err.message : String(err) })
  }
}

export async function startUiServer (
  opts: { existing: ProjectManifest | null, targetDir: string, deps?: { runCommand?: RunCommand } }
): Promise<UiServer> {
  const { existing, targetDir } = opts
  const included = existing === null
    ? listCapabilities().filter(c => c.defaultSelected === true).map(c => ({ label: c.title }))
    : []
  const html = buildPage({ schema: serializeSchema(existing), seed: seedDraft(existing, {}), included })

  let resolveDone: (r: RunResult) => void = () => {}
  const done = new Promise<RunResult>((resolve) => { resolveDone = resolve })

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) return serveIndex(res, html)
      if (req.method === 'POST' && req.url === '/generate') return await handleGenerate(req, res, existing, targetDir, opts.deps?.runCommand, resolveDone)
      if (req.method === 'POST' && req.url === '/plan') return await handlePlan(req, res, existing, targetDir)
      sendJson(res, 404, { error: 'not found' })
    })()
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  return { url, done, close: () => server.close() }
}

export interface RunUiOpts {
  existing: ProjectManifest | null
  targetDir: string
  runCommand?: RunCommand
  openBrowser?: (url: string) => void
}

export async function runUi (opts: RunUiOpts): Promise<RunResult> {
  const srv = await startUiServer({ existing: opts.existing, targetDir: opts.targetDir, deps: { runCommand: opts.runCommand } })
  const open = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url))
  console.log(`\ncreate-bsv-app UI: ${srv.url}\nFill the form and press Generate (or Ctrl-C to cancel).`)
  open(srv.url)
  try {
    return await srv.done
  } finally {
    srv.close()
  }
}
