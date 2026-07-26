import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Capability, CapabilityContext, BaseBuilder, RouteDef } from '../types.js'

export function newBuilder(): BaseBuilder {
  return {
    main: { imports: [], wraps: [] },
    app: { imports: [], routes: [] },
    server: { imports: [], routes: [], setup: [] }
  }
}

// Relative import specifier from a base file (at `<target>/src/`) to a glue file
// under `ctx.bsvDir`. Default bsvDir 'src/bsv' → './bsv/<name>'; e.g. 'lib/bsv' → '../lib/bsv/<name>'.
export function bsvImport(ctx: CapabilityContext, name: string): string {
  const rel = ctx.bsvDir.startsWith('src/')
    ? './' + ctx.bsvDir.slice('src/'.length)
    : '../' + ctx.bsvDir
  return `${rel}/${name}`
}

export const MAIN_TEMPLATE = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
/*{{main.imports}}*/

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*{{main.app}}*/}
  </StrictMode>
)
`

export const APP_TEMPLATE = `import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './bsv/Home'
/*{{app.imports}}*/

export default function App () {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        {/*{{app.routes}}*/}
      </Routes>
    </BrowserRouter>
  )
}
`

export const SERVER_TEMPLATE = `import http from 'node:http'
import express from 'express'
import cors from 'cors'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { SERVER_PRIVATE_KEY, PORT, CLIENT_ORIGIN } from './bsv/config.js'
/*{{server.imports}}*/

const app = express()
app.use(cors({ origin: CLIENT_ORIGIN })) // allow the browser client (different dev origin) to call the API
app.use(express.json())

// Verify-only server wallet. All config (incl. SERVER_PRIVATE_KEY) lives in bsv/config.ts.
const serverWallet = new ProtoWallet(PrivateKey.fromString(SERVER_PRIVATE_KEY))

app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })

// The server's identity public key. Clients fetch this and use it as the proof
// \`counterparty\` (login / signed requests) — no need to hard-code a key anywhere.
app.get('/api/identity', async (_req, res) => {
  const { publicKey } = await serverWallet.getPublicKey({ identityKey: true })
  res.json({ identityKey: publicKey })
})
/*{{server.routes}}*/

// Raw HTTP server so capabilities can attach WebSocket upgrades (e.g. the wallet relay).
const server = http.createServer(app)
/*{{server.setup}}*/
server.listen(PORT, () => { console.log(\`server on http://localhost:\${PORT}\`) })
`

// Baseline server config — every env the server reads, in one place.
export function serverConfig(ctx: CapabilityContext): string {
  return `// Centralized server configuration, read from the environment.
import { PrivateKey } from '@bsv/sdk'

// Server wallet key. Set SERVER_PRIVATE_KEY for a stable identity; a random key is
// used as a dev fallback (the server's identity then changes on every restart).
export const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY ?? PrivateKey.fromRandom().toString()

export const PORT = Number(process.env.PORT ?? 3000)

// Browser origin allowed by CORS — your client's dev URL by default.
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173'

export const BSV_NETWORK = process.env.BSV_NETWORK ?? '${ctx.network}'
`
}

// Default home: connect a wallet, then link out to each installed capability's demo page.
export const HOME_TEMPLATE = `import { ConnectWallet } from './ConnectWallet.js'
import { useWallet } from './WalletContext.js'
/*{{home.imports}}*/

export function Home () {
  const { connected } = useWallet()
  return (
    <main className="bsv-page">
      <h1>BSV app</h1>
      <p>Connect a wallet to get started, then try the installed demos.</p>
      <ConnectWallet />
      {connected && (
        <nav className="bsv-nav">
          <h2 className="bsv-label">Demos</h2>
          {/*{{home.links}}*/}
        </nav>
      )}
    </main>
  )
}
`

// Build the wrapped-app JSX: opens in push order, <App />, closes reversed — each
// nesting level indented +2 (the marker's own column is added on top by assembleBaseFile).
function wrappedApp(wraps: Array<{ open: string; close: string }>): string {
  if (wraps.length === 0) return '<App />'
  const lines: string[] = []
  wraps.forEach((w, i) => lines.push('  '.repeat(i) + w.open))
  lines.push('  '.repeat(wraps.length) + '<App />')
  for (let i = wraps.length - 1; i >= 0; i--) lines.push('  '.repeat(i) + wraps[i].close)
  return lines.join('\n')
}

// Render route descriptors → named imports + <Route> JSX (scaffolder owns the JSX).
export function routeImports(routes: RouteDef[]): string {
  return routes.map(r => `import { ${r.component} } from '${r.importPath}'`).join('\n')
}

export function routeJsx(routes: RouteDef[]): string {
  return routes.map(r => `<Route path="${r.path}" element={<${r.component} />} />`).join('\n')
}

// Home demo-hub links, one per capability route (label falls back to the path).
function homeLinks(routes: RouteDef[]): string {
  if (routes.length === 0) return '<p>No capability demos installed.</p>'
  return routes.map(r => `<Link to="${r.path}">${r.label ?? r.path} →</Link>`).join('\n')
}

export function assembleBaseFile(template: string, b: BaseBuilder, ctx: CapabilityContext): string {
  let out = template
  // Replace each marker, indenting every line after the first to the marker's own
  // column so multi-line insertions (wraps, routes, links) stay aligned.
  const sub = (marker: string, value: string): void => {
    let idx = out.indexOf(marker)
    while (idx !== -1) {
      const lineStart = out.lastIndexOf('\n', idx) + 1
      const indent = out.slice(lineStart, idx)
      const indented = /^[ \t]*$/.test(indent) ? value.split('\n').join('\n' + indent) : value
      out = out.slice(0, idx) + indented + out.slice(idx + marker.length)
      idx = out.indexOf(marker, idx + indented.length)
    }
  }
  // app imports = explicit imports + one generated import per route descriptor
  const appImports = [...b.app.imports, routeImports(b.app.routes)]
    .filter(s => s.length > 0)
    .join('\n')
  // Generated base files (Home, server entry) live at <target>/src/ but import glue from bsvDir.
  sub("'./bsv/Home'", `'${bsvImport(ctx, 'Home')}'`)
  sub("'./bsv/config.js'", `'${bsvImport(ctx, 'config.js')}'`)
  sub('/*{{main.imports}}*/', b.main.imports.join('\n'))
  sub('{/*{{main.app}}*/}', wrappedApp(b.main.wraps))
  sub('/*{{app.imports}}*/', appImports)
  sub('{/*{{app.routes}}*/}', routeJsx(b.app.routes))
  sub('/*{{server.imports}}*/', b.server.imports.join('\n'))
  sub('/*{{server.routes}}*/', b.server.routes.join('\n'))
  sub('/*{{server.setup}}*/', b.server.setup.join('\n'))
  sub(
    '/*{{home.imports}}*/',
    b.app.routes.length > 0 ? "import { Link } from 'react-router-dom'" : ''
  )
  sub('{/*{{home.links}}*/}', homeLinks(b.app.routes))
  return out
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n') // drop trailing whitespace left by removed markers
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
}

export function assembleAndWrite(
  caps: Capability[],
  ctx: CapabilityContext,
  dirs: { clientDir?: string; serverDir?: string }
): { client: string[]; server: string[] } {
  const builder = newBuilder()
  for (const cap of caps) cap.baseEdits?.({ builder, ctx })
  const result: { client: string[]; server: string[] } = { client: [], server: [] }
  const write = (dir: string, rel: string, content: string, bucket: string[]): void => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    bucket.push(rel)
  }
  if (dirs.clientDir != null) {
    write(
      dirs.clientDir,
      'src/main.tsx',
      assembleBaseFile(MAIN_TEMPLATE, builder, ctx),
      result.client
    )
    write(
      dirs.clientDir,
      'src/App.tsx',
      assembleBaseFile(APP_TEMPLATE, builder, ctx),
      result.client
    )
    write(
      dirs.clientDir,
      `${ctx.bsvDir}/Home.tsx`,
      assembleBaseFile(HOME_TEMPLATE, builder, ctx),
      result.client
    )
  }
  if (dirs.serverDir != null) {
    write(
      dirs.serverDir,
      'src/index.ts',
      assembleBaseFile(SERVER_TEMPLATE, builder, ctx),
      result.server
    )
    write(dirs.serverDir, `${ctx.bsvDir}/config.ts`, serverConfig(ctx), result.server)
  }
  return result
}
