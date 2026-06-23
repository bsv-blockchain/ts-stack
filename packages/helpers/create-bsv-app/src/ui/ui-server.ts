import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serializeSchema, buildPage } from './ui-page.js'
import { openBrowser as defaultOpenBrowser } from './open-browser.js'
import { applyConfig, type RunResult } from '../pipeline.js'
import { resolveDraft, seedDraft, type ConfigDraft } from '../config/draft.js'
import { ConfigError } from '../config/validate.js'
import type { ProjectManifest } from '../config/project-manifest.js'
import type { RunCommand } from '../scaffold/base-scaffolder.js'

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

export async function startUiServer (
  opts: { existing: ProjectManifest | null, targetDir: string, deps?: { runCommand?: RunCommand } }
): Promise<UiServer> {
  const { existing, targetDir } = opts
  const html = buildPage({ schema: serializeSchema(existing), seed: seedDraft(existing, {}) })

  let resolveDone: (r: RunResult) => void = () => {}
  const done = new Promise<RunResult>((resolve) => { resolveDone = resolve })

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      if (req.method === 'POST' && req.url === '/generate') {
        try {
          const draft = JSON.parse(await readBody(req)) as ConfigDraft
          const config = resolveDraft(seedDraft(existing, draft))
          // force:false — preserve existing capability files, matching the CLI default (the user re-runs with intent but we never clobber their edits)
          const result = applyConfig(config, targetDir, {
            runCommand: opts.deps?.runCommand,
            force: false
          })
          sendJson(res, 200, { targetDir: result.targetDir, written: result.written, deps: result.deps })
          resolveDone(result)
          return
        } catch (err) {
          const status = err instanceof ConfigError ? 400 : 500
          sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
          return
        }
      }
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
