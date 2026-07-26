// src/agents-md.ts
import type { ProjectConfig } from './config/model.js'
import { layoutOf } from './config/model.js'
import type { Capability, CapabilityContext, BaseBuilder } from './types.js'
import { planPlacement } from './engine.js'
import { newBuilder, routeImports, routeJsx } from './scaffold/base-app.js'

function installBlock(label: string, deps: Record<string, string>): string {
  const names = Object.keys(deps)
  if (names.length === 0) return ''
  const ranges = Object.entries(deps)
    .map(([n, r]) => `  ${n}@${r}`)
    .join('\n')
  const head = label.length > 0 ? `### ${label}\n\n` : ''
  const cmd = label.length > 0 ? `cd ${label.replace(/\/$/, '')} && npm i` : 'npm i'
  return `${head}Dependencies are already in \`package.json\` — just install:\n\n\`\`\`\n${cmd}\n\`\`\`\n\nIncluded:\n${ranges}\n\n`
}

// main.tsx: imports + wrap
function mainBlock(builder: BaseBuilder): string | null {
  if (builder.main.imports.length === 0 && builder.main.wraps.length === 0) return null
  const lines: string[] = []
  if (builder.main.imports.length > 0) lines.push(builder.main.imports.join('\n'))
  if (builder.main.wraps.length > 0) {
    const opens = builder.main.wraps.map(w => w.open).join('\n')
    const closes = builder.main.wraps
      .map(w => w.close)
      .reverse()
      .join('\n')
    lines.push(`// Wrap <App /> in src/main.tsx:\n${opens}\n<App />\n${closes}`)
  }
  return `### \`src/main.tsx\`\n\n\`\`\`tsx\n${lines.join('\n')}\n\`\`\``
}

// App.tsx: route imports + <Route> JSX
function appBlock(builder: BaseBuilder): string | null {
  if (builder.app.routes.length === 0 && builder.app.imports.length === 0) return null
  const lines: string[] = []
  const allImports = [...builder.app.imports]
  const generatedImports = routeImports(builder.app.routes)
  if (generatedImports.length > 0) allImports.push(generatedImports)
  if (allImports.length > 0) lines.push(allImports.join('\n'))
  const jsx = routeJsx(builder.app.routes)
  if (jsx.length > 0) lines.push(`// Add inside <Routes> in src/App.tsx:\n${jsx}`)
  return `### \`src/App.tsx\`\n\n\`\`\`tsx\n${lines.join('\n')}\n\`\`\``
}

// server/src/index.ts: imports + routes + setup (raw-server hooks like the relay's WS upgrade)
function serverBlock(builder: BaseBuilder): string | null {
  if (
    builder.server.imports.length === 0 &&
    builder.server.routes.length === 0 &&
    builder.server.setup.length === 0
  )
    return null
  const lines: string[] = []
  if (builder.server.imports.length > 0) lines.push(builder.server.imports.join('\n'))
  if (builder.server.routes.length > 0)
    lines.push(
      `// Add after app setup in server/src/index.ts:\n${builder.server.routes.join('\n')}`
    )
  if (builder.server.setup.length > 0)
    lines.push(
      `// Add after \`const server = http.createServer(app)\`, before server.listen():\n${builder.server.setup.join('\n')}`
    )
  return `### \`server/src/index.ts\`\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

function wiringSection(
  config: ProjectConfig,
  capabilities: Capability[],
  ctx: CapabilityContext
): string {
  const builder = newBuilder()
  for (const cap of capabilities) cap.baseEdits?.({ builder, ctx })

  const isManual = config.mode !== 'new' || !config.glue
  if (!isManual) {
    return '## Wiring\n\nBase files (`main.tsx`, `App.tsx`, `server`) were wired automatically.\n'
  }

  const blocks = [mainBlock(builder), appBlock(builder), serverBlock(builder)].filter(
    (b): b is string => b !== null
  )
  if (blocks.length === 0) return ''

  let out = `## Wiring (manual)\n\nAdd-mode or \`--no-glue\`: paste these snippets into the relevant base files.\n\n${blocks.join('\n\n')}\n`

  if (builder.server.routes.length > 0 || builder.server.setup.length > 0) {
    out +=
      '\n> **`SERVER_PRIVATE_KEY`** — add to `.env`: the server template initialises `serverWallet` from this variable (e.g. `SERVER_PRIVATE_KEY=<your-private-key>`).\n'
  }

  return out
}

export function renderAgentsMd(config: ProjectConfig, capabilities: Capability[]): string {
  const layout = layoutOf(config.stack)
  const ctx: CapabilityContext = {
    name: config.name,
    network: config.network,
    bsvDir: config.bsvDir,
    stack: config.stack,
    layout
  }
  const { deps } = planPlacement(config, capabilities)

  const header = `# ${config.name} — agent guide\n\nScaffolded by \`create-bsv-app\` (layout: **${layout}**, network: **${config.network}**). BSV capabilities live under \`${config.bsvDir}\`. Re-run \`npx create-bsv-app\` inside this folder to add more capabilities.\n\n`
  let depsSection = '## Install dependencies\n\n'
  depsSection +=
    layout === 'monorepo'
      ? installBlock('client/', deps.client) + installBlock('server/', deps.server)
      : installBlock('', deps.root)
  const wiring = wiringSection(config, capabilities, ctx)
  const sections = capabilities.map(c => c.agentsSection(ctx).trimEnd())
  return (
    header + depsSection + (wiring.length > 0 ? wiring + '\n' : '') + sections.join('\n\n') + '\n'
  )
}
