import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
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
import { getStarter } from '../starters.js'

export interface UiServer {
  url: string
  done: Promise<RunResult>
  close: () => void
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024
const SESSION_HEADER = 'x-create-bsv-app-session'

class UiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength)) {
      throw new UiRequestError(400, 'Invalid request body length.')
    }
    if (Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
      throw new UiRequestError(413, 'Request body is too large.')
    }
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new UiRequestError(413, 'Request body is too large.')
    }
    chunks.push(bytes)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
  } catch {
    throw new UiRequestError(400, 'Request body must be valid UTF-8.')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function serveIndex(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value.trim())
}

function authorizeLocalRequest(
  req: IncomingMessage,
  expectedOrigin: string,
  sessionToken: string
): UiRequestError | null {
  if (req.headers.host !== expectedOrigin.slice('http://'.length)) {
    return new UiRequestError(403, 'Forbidden request host.')
  }
  if (req.method !== 'POST') return null
  if (req.headers.origin !== expectedOrigin) {
    return new UiRequestError(403, 'Forbidden request origin.')
  }
  if (req.headers[SESSION_HEADER] !== sessionToken) {
    return new UiRequestError(403, 'Invalid UI session.')
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    return new UiRequestError(415, 'Request body must be JSON.')
  }
  return null
}

async function handleGenerate(
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
    if (err instanceof UiRequestError) throw err
    if (err instanceof ConfigError) {
      sendJson(res, 400, { error: 'Invalid project configuration.' })
      return
    }
    console.error('Project generation failed:', err)
    sendJson(res, 500, { error: 'Project generation failed.' })
  }
}

// Base files touched by glue-wiring in new-mode: main.tsx/App.tsx (frontend) and server/src/index.ts (backend).
function baseGluePaths(layout: Layout): string[] {
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

function planPaths(config: ProjectConfig, caps: Capability[]): string[] {
  if (getStarter(config.starter)?.kind === 'repository') return [MANIFEST_FILE]
  const placement = planPlacement(config, caps)
  const rawPaths: string[] = [...placement.utilFiles, ...placement.glueFiles].map(f => f.path)
  rawPaths.push('AGENTS.md', MANIFEST_FILE)
  if (config.mode === 'new' && config.glue) rawPaths.push(...baseGluePaths(layoutOf(config.stack)))
  return [...new Set(rawPaths)]
}

async function handlePlan(
  req: IncomingMessage,
  res: ServerResponse,
  existing: ProjectManifest | null,
  targetDir: string
): Promise<void> {
  try {
    const draft = JSON.parse(await readBody(req)) as ConfigDraft
    const config = resolveDraft(seedDraft(existing, draft))
    const caps = resolveCapabilities(config.capabilities, { expandRequires: config.mode === 'new' })
    const files = planPaths(config, caps).map(p => ({
      path: p,
      status: existsSync(join(targetDir, p)) ? ('edit' as const) : ('new' as const)
    }))
    sendJson(res, 200, { files })
  } catch (err) {
    if (err instanceof UiRequestError) throw err
    if (err instanceof ConfigError) {
      sendJson(res, 200, { files: [], error: 'Invalid project configuration.' })
      return
    }
    console.error('Project plan generation failed:', err)
    sendJson(res, 200, { files: [], error: 'Unable to generate project plan.' })
  }
}

export async function startUiServer(opts: {
  existing: ProjectManifest | null
  targetDir: string
  deps?: { runCommand?: RunCommand }
}): Promise<UiServer> {
  const { existing, targetDir } = opts
  const sessionToken = randomBytes(32).toString('base64url')
  const scriptNonce = randomBytes(24).toString('base64url')
  const included =
    existing === null
      ? listCapabilities()
          .filter(c => c.defaultSelected === true)
          .map(c => ({ label: c.title }))
      : []
  const html = buildPage({
    schema: serializeSchema(existing),
    seed: seedDraft(existing, {}),
    included,
    sessionToken,
    scriptNonce
  })

  let resolveDone: (r: RunResult) => void = () => {}
  const done = new Promise<RunResult>(resolve => {
    resolveDone = resolve
  })

  let expectedOrigin = ''
  const server = createServer((req, res) => {
    res.setHeader(
      'content-security-policy',
      `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    )
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'DENY')
    const authorizationError = authorizeLocalRequest(req, expectedOrigin, sessionToken)
    if (authorizationError !== null) {
      sendJson(res, authorizationError.status, { error: authorizationError.message })
      return
    }
    void (async () => {
      try {
        if (req.method === 'GET' && (req.url === '/' || req.url === ''))
          return serveIndex(res, html)
        if (req.method === 'POST' && req.url === '/generate')
          return await handleGenerate(
            req,
            res,
            existing,
            targetDir,
            opts.deps?.runCommand,
            resolveDone
          )
        if (req.method === 'POST' && req.url === '/plan')
          return await handlePlan(req, res, existing, targetDir)
        sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        if (error instanceof UiRequestError) {
          sendJson(res, error.status, { error: error.message })
          return
        }
        console.error('UI request failed:', error)
        sendJson(res, 500, { error: 'UI request failed.' })
      }
    })().catch(error => {
      console.error('UI request failed:', error)
      if (!res.headersSent) sendJson(res, 500, { error: 'UI request failed.' })
      else res.destroy()
    })
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  expectedOrigin = url
  return { url, done, close: () => server.close() }
}

export interface RunUiOpts {
  existing: ProjectManifest | null
  targetDir: string
  runCommand?: RunCommand
  openBrowser?: (url: string) => void
}

export async function runUi(opts: RunUiOpts): Promise<RunResult> {
  const srv = await startUiServer({
    existing: opts.existing,
    targetDir: opts.targetDir,
    deps: { runCommand: opts.runCommand }
  })
  const open = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url))
  console.log(
    `\ncreate-bsv-app UI: ${srv.url}\nFill the form and press Generate (or Ctrl-C to cancel).`
  )
  open(srv.url)
  try {
    return await srv.done
  } finally {
    srv.close()
  }
}
