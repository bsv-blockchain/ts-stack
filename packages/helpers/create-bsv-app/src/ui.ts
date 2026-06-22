import type { Manifest, Selection } from './types.js'
import type { ProjectManifest } from './config/project-manifest.js'
import { listCapabilities, getCapability } from './registry.js'
import { mergeCapabilityIds } from './config/project-manifest.js'
import type { PromptProvider } from './cli.js'

function escHtml (s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function remainingUiCapabilityIds (existing: Manifest): string[] {
  return listCapabilities().map(c => c.id).filter(id => !existing.capabilities.includes(id))
}

export function buildUiHtml (opts: { existing: Manifest | null }): string {
  const { existing } = opts
  const allCaps = listCapabilities()
  const caps = existing != null
    ? allCaps.filter(c => remainingUiCapabilityIds(existing).includes(c.id))
    : allCaps

  const capCheckboxes = caps.map(c => `
    <label class="cap-label">
      <input type="checkbox" name="capabilityIds" value="${escHtml(c.id)}" />
      <span class="cap-info">
        <span class="cap-title">${escHtml(c.title)}</span>
        <span class="cap-desc">${escHtml(c.description)}</span>
      </span>
    </label>`).join('\n')

  const nameField = existing != null
    ? `<input type="text" name="appName" value="${escHtml(existing.name)}" readonly />`
    : '<input type="text" name="appName" placeholder="my-app" required />'

  const expressDisabled = existing != null ? 'disabled' : ''
  const reactDisabled = existing != null ? 'disabled' : ''
  const expressSelected = existing != null && existing.framework === 'express' ? 'selected' : ''
  const reactSelected = existing != null && existing.framework === 'react' ? 'selected' : ''
  const hiddenFramework = existing != null
    ? `<input type="hidden" name="framework" value="${escHtml(existing.framework)}" />`
    : ''

  const frameworkField = `<select name="framework">
    <option value="express" ${expressSelected} ${expressDisabled}>Express (server)</option>
    <option value="react" ${reactSelected} ${reactDisabled}>React (browser)</option>
  </select>
  ${hiddenFramework}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>create-bsv-app</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.5rem; margin-bottom: 1rem; }
.cap-label { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 0.5rem; cursor: pointer; }
.cap-info { display: flex; flex-direction: column; }
.cap-title { font-weight: bold; }
.cap-desc { color: #666; font-size: 0.875rem; }
input[type=text], select { width: 100%; padding: 0.4rem; margin-bottom: 1rem; box-sizing: border-box; }
label { display: block; margin-bottom: 0.25rem; font-weight: bold; }
button { padding: 0.6rem 1.4rem; background: #0070f3; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
button:hover { background: #0060d3; }
#status { margin-top: 1rem; padding: 0.75rem; border-radius: 4px; display: none; }
.ok { background: #d4edda; color: #155724; display: block; }
.err { background: #f8d7da; color: #721c24; display: block; }
fieldset { border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; margin: 0 0 1rem 0; }
legend { font-weight: bold; padding: 0 0.25rem; }
</style>
</head>
<body>
<h1>create-bsv-app</h1>
<form id="form">
  <label for="appName">Project name</label>
  ${nameField}
  <label for="framework">Framework</label>
  ${frameworkField}
  <fieldset>
    <legend>Capabilities</legend>
    ${capCheckboxes.length > 0 ? capCheckboxes : '<p>All capabilities already installed.</p>'}
  </fieldset>
  <button type="submit">Generate</button>
</form>
<div id="status"></div>
<script>
(function () {
  var form = document.getElementById('form');
  var status = document.getElementById('status');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var capabilityIds = data.getAll('capabilityIds');
    var payload = {
      appName: (data.get('appName') || '').toString().trim(),
      network: 'test',
      framework: (data.get('framework') || '').toString(),
      capabilityIds: capabilityIds
    };
    fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (t) { return { ok: r.ok, text: t }; });
    }).then(function (res) {
      status.textContent = res.text;
      status.className = res.ok ? 'ok' : 'err';
    }).catch(function (err) {
      status.textContent = 'Network error: ' + String(err);
      status.className = 'err';
    });
  });
}());
</script>
</body>
</html>`
}

export function parseUiSubmission (body: unknown, existing: Manifest | null): Selection {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body')
  const b = body as Record<string, unknown>

  const appName: string = existing != null
    ? existing.name
    : (() => {
        if (typeof b.appName === 'string' && b.appName.trim().length > 0) return b.appName.trim()
        throw new Error('appName required')
      })()

  const network: 'main' | 'test' = existing != null
    ? existing.network
    : (b.network === 'main' ? 'main' : 'test')

  const framework = existing != null
    ? existing.framework
    : (() => {
        if (b.framework === 'express' || b.framework === 'react') return b.framework
        throw new Error('invalid framework')
      })()

  const rawIds: string[] = Array.isArray(b.capabilityIds)
    ? b.capabilityIds.filter((x): x is string => typeof x === 'string')
    : []

  for (const id of rawIds) {
    if (getCapability(id) == null) throw new Error(`unknown capability: ${id}`)
  }

  const capabilityIds = mergeCapabilityIds(existing?.capabilities ?? [], rawIds)
  if (capabilityIds.length === 0) throw new Error('select at least one capability')

  return { appName, network, framework, capabilityIds }
}

function manifestToLegacy (m: ProjectManifest): Manifest {
  let framework: 'react' | 'express' = 'express'
  if (m.stack.frontend != null) {
    framework = 'react'
  }
  return { version: 1, name: m.name, network: m.network, framework, capabilities: [...m.capabilities] }
}

export async function startUiServer (opts: { existing: ProjectManifest | null }): Promise<{ url: string, selection: Promise<Selection>, close: () => void }> {
  const legacyExisting: Manifest | null = opts.existing != null ? manifestToLegacy(opts.existing) : null
  const http = await import('node:http')
  let resolveSelection: (s: Selection) => void = () => {}
  const selection = new Promise<Selection>((resolve) => { resolveSelection = resolve })
  let resolved = false

  const server = http.default.createServer((req, res) => {
    const urlPath = req.url ?? '/'
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      const html = buildUiHtml({ existing: legacyExisting })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.method === 'POST' && urlPath === '/generate') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('invalid JSON')
          return
        }
        let sel: Selection
        try {
          sel = parseUiSubmission(body, legacyExisting)
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end(err instanceof Error ? err.message : 'parse error')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('Scaffold selection received — you can close this tab.')
        if (!resolved) {
          resolved = true
          resolveSelection(sel)
        }
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  })

  return await new Promise<{ url: string, selection: Promise<Selection>, close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr !== null && typeof addr === 'object' ? addr.port : 0
      const url = `http://127.0.0.1:${port}`
      resolve({ url, selection, close: () => { server.close() } })
    })
  })
}

export const uiPrompt: PromptProvider = async ({ existing }) => {
  const { url, selection, close } = await startUiServer({ existing })
  try {
    const cp = await import('node:child_process')
    const opener: [string, string[]] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
    cp.default.spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // ignore opener errors
  }
  console.log(`Open in browser: ${url}`)
  const sel = await selection
  close()
  return sel
}
