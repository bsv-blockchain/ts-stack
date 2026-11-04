// src/agents-md.ts
import type { ProjectConfig } from './config/model.js'
import { layoutOf } from './config/model.js'
import type { Capability, CapabilityContext, BaseBuilder, Role } from './types.js'
import { planPlacement, roleTargetsFor, targetPath, type TargetKey } from './engine.js'
import { BASE_FILES, newBuilder, routeImports, routeJsx } from './scaffold/base-app.js'

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

// One install block per target the layout has deps for, labelled by its folder ('' at the root).
function installBlocks(
  config: ProjectConfig,
  deps: Record<TargetKey, Record<string, string>>
): string {
  const roleTargets = roleTargetsFor(layoutOf(config.stack))
  const targets = new Set([...roleTargets.shared, ...roleTargets.client, ...roleTargets.server])
  return [...targets]
    .map(t => {
      const root = targetPath(config, t, '')
      return installBlock(root === '' ? '' : `${root}/`, deps[t])
    })
    .join('')
}

// Project-relative paths of the base files this layout has; null where it has no such target.
interface BasePaths {
  main: string | null
  app: string | null
  server: string | null
}

function basePaths(config: ProjectConfig): BasePaths {
  const roleTargets = roleTargetsFor(layoutOf(config.stack))
  const at = (role: Role, file: string): string | null => {
    const target = roleTargets[role][0]
    return target == null ? null : targetPath(config, target, file)
  }
  return {
    main: at('client', BASE_FILES.main),
    app: at('client', BASE_FILES.app),
    server: at('server', BASE_FILES.server)
  }
}

// main.tsx: imports + wrap
function mainBlock(builder: BaseBuilder, path: string | null): string | null {
  if (path == null) return null
  if (builder.main.imports.length === 0 && builder.main.wraps.length === 0) return null
  const lines: string[] = []
  if (builder.main.imports.length > 0) lines.push(builder.main.imports.join('\n'))
  if (builder.main.wraps.length > 0) {
    const opens = builder.main.wraps.map(w => w.open).join('\n')
    const closes = builder.main.wraps
      .map(w => w.close)
      .reverse()
      .join('\n')
    lines.push(`// Wrap <App /> in ${path}:\n${opens}\n<App />\n${closes}`)
  }
  return `### \`${path}\`\n\n\`\`\`tsx\n${lines.join('\n')}\n\`\`\``
}

// App.tsx: route imports + <Route> JSX
function appBlock(builder: BaseBuilder, path: string | null): string | null {
  if (path == null) return null
  if (builder.app.routes.length === 0 && builder.app.imports.length === 0) return null
  const lines: string[] = []
  const allImports = [...builder.app.imports]
  const generatedImports = routeImports(builder.app.routes)
  if (generatedImports.length > 0) allImports.push(generatedImports)
  if (allImports.length > 0) lines.push(allImports.join('\n'))
  const jsx = routeJsx(builder.app.routes)
  if (jsx.length > 0) lines.push(`// Add inside <Routes> in ${path}:\n${jsx}`)
  return `### \`${path}\`\n\n\`\`\`tsx\n${lines.join('\n')}\n\`\`\``
}

// Server entry: imports + routes + setup (raw-server hooks like the relay's WS upgrade)
function serverBlock(builder: BaseBuilder, path: string | null): string | null {
  if (path == null) return null
  if (
    builder.server.imports.length === 0 &&
    builder.server.config.length === 0 &&
    builder.server.routes.length === 0 &&
    builder.server.setup.length === 0
  )
    return null
  const lines: string[] = []
  if (builder.server.imports.length > 0) lines.push(builder.server.imports.join('\n'))
  // The generated bsv/config.ts exists only in new glued projects, so inline its definitions.
  if (builder.server.config.length > 0)
    lines.push(
      `// Add after the imports in ${path} (new glued projects keep this in bsv/config.ts):\n${builder.server.config.map(c => c.inline.trimEnd()).join('\n')}`
    )
  if (builder.server.routes.length > 0)
    lines.push(`// Add after app setup in ${path}:\n${builder.server.routes.join('\n')}`)
  if (builder.server.setup.length > 0)
    lines.push(
      `// Add after \`const server = http.createServer(app)\`, before server.listen():\n${builder.server.setup.join('\n')}`
    )
  return `### \`${path}\`\n\n\`\`\`ts\n${lines.join('\n')}\n\`\`\``
}

function wiringSection(
  config: ProjectConfig,
  capabilities: Capability[],
  ctx: CapabilityContext
): string {
  const builder = newBuilder()
  for (const cap of capabilities) cap.baseEdits?.({ builder, ctx })

  const paths = basePaths(config)
  const isManual = config.mode !== 'new' || !config.glue
  if (!isManual) {
    const names = [paths.main, paths.app, paths.server]
      .filter((p): p is string => p !== null)
      .map(p => `\`${p}\``)
      .join(', ')
    return `## Wiring\n\nBase files (${names}) were wired automatically.\n`
  }

  const blocks = [
    mainBlock(builder, paths.main),
    appBlock(builder, paths.app),
    serverBlock(builder, paths.server)
  ].filter((b): b is string => b !== null)
  if (blocks.length === 0) return ''

  let out = `## Wiring (manual)\n\nAdd-mode or \`--no-glue\`: paste these snippets into the relevant base files.\n\n${blocks.join('\n\n')}\n`

  const serverWiring = builder.server.routes.length > 0 || builder.server.setup.length > 0
  if (paths.server != null && serverWiring) {
    out +=
      '\n> **`SERVER_PRIVATE_KEY`** — add to `.env`: the server template initialises `serverWallet` from this variable (e.g. `SERVER_PRIVATE_KEY=<your-private-key>`).' +
      (builder.server.config.length > 0
        ? ' **`SERVER_ORIGIN`** — the address a phone uses to reach the server for wallet pairing, and the origin the wallet shows the user; required and HTTPS in production (in development, e.g. `SERVER_ORIGIN=http://<your LAN IP>:<your server port>`).'
        : '') +
      '\n'
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
  const depsSection = '## Install dependencies\n\n' + installBlocks(config, deps)
  const wiring = wiringSection(config, capabilities, ctx)
  const sections = capabilities.map(c => c.agentsSection(ctx).trimEnd())
  return (
    header + depsSection + (wiring.length > 0 ? wiring + '\n' : '') + sections.join('\n\n') + '\n'
  )
}
