import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Capability, CapabilityContext, BaseBuilder, RouteDef } from '../types.js'

export function newBuilder (): BaseBuilder {
  return { main: { imports: [], wraps: [] }, app: { imports: [], routes: [] }, server: { imports: [], routes: [] } }
}

// Relative import specifier from a base file (at `<target>/src/`) to a glue file
// under `ctx.bsvDir`. Default bsvDir 'src/bsv' → './bsv/<name>'; e.g. 'lib/bsv' → '../lib/bsv/<name>'.
export function bsvImport (ctx: CapabilityContext, name: string): string {
  const rel = ctx.bsvDir.startsWith('src/') ? './' + ctx.bsvDir.slice('src/'.length) : '../' + ctx.bsvDir
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

export const SERVER_TEMPLATE = `import express from 'express'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
/*{{server.imports}}*/

const app = express()
app.use(express.json())

// Verify-only server wallet (set SERVER_PRIVATE_KEY in .env). Used by capability routes.
const serverWallet = new ProtoWallet(PrivateKey.fromString(process.env.SERVER_PRIVATE_KEY ?? PrivateKey.fromRandom().toString()))

app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })
/*{{server.routes}}*/

const PORT = Number(process.env.PORT ?? 3000)
app.listen(PORT, () => { console.log(\`server on http://localhost:\${PORT}\`) })
`

// Build the wrapped-app JSX: opens in push order, <App />, closes reversed.
function wrappedApp (wraps: Array<{ open: string, close: string }>): string {
  const opens = wraps.map(w => w.open).join('\n')
  const closes = wraps.map(w => w.close).reverse().join('\n')
  return [opens, '<App />', closes].filter(s => s.length > 0).join('\n')
}

// Render route descriptors → named imports + <Route> JSX (scaffolder owns the JSX).
export function routeImports (routes: RouteDef[]): string {
  return routes.map(r => `import { ${r.component} } from '${r.importPath}'`).join('\n')
}

export function routeJsx (routes: RouteDef[]): string {
  return routes.map(r => `<Route path="${r.path}" element={<${r.component} />} />`).join('\n')
}

export function assembleBaseFile (template: string, b: BaseBuilder, ctx: CapabilityContext): string {
  let out = template
  const sub = (marker: string, value: string): void => { out = out.split(marker).join(value) }
  // app imports = explicit imports + one generated import per route descriptor
  const appImports = [...b.app.imports, routeImports(b.app.routes)].filter(s => s.length > 0).join('\n')
  // The default Home page (baked into APP_TEMPLATE) lives under bsvDir like every other glue file.
  sub("'./bsv/Home'", `'${bsvImport(ctx, 'Home')}'`)
  sub('/*{{main.imports}}*/', b.main.imports.join('\n'))
  sub('{/*{{main.app}}*/}', wrappedApp(b.main.wraps))
  sub('/*{{app.imports}}*/', appImports)
  sub('{/*{{app.routes}}*/}', routeJsx(b.app.routes))
  sub('/*{{server.imports}}*/', b.server.imports.join('\n'))
  sub('/*{{server.routes}}*/', b.server.routes.join('\n'))
  return out.replace(/\n{3,}/g, '\n\n') // tidy blank lines from removed markers
}

export function assembleAndWrite (
  caps: Capability[],
  ctx: CapabilityContext,
  dirs: { clientDir?: string, serverDir?: string }
): { client: string[], server: string[] } {
  const builder = newBuilder()
  for (const cap of caps) cap.baseEdits?.({ builder, ctx })
  const result: { client: string[], server: string[] } = { client: [], server: [] }
  const write = (dir: string, rel: string, content: string, bucket: string[]): void => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    bucket.push(rel)
  }
  if (dirs.clientDir != null) {
    write(dirs.clientDir, 'src/main.tsx', assembleBaseFile(MAIN_TEMPLATE, builder, ctx), result.client)
    write(dirs.clientDir, 'src/App.tsx', assembleBaseFile(APP_TEMPLATE, builder, ctx), result.client)
  }
  if (dirs.serverDir != null) {
    write(dirs.serverDir, 'src/index.ts', assembleBaseFile(SERVER_TEMPLATE, builder, ctx), result.server)
  }
  return result
}
