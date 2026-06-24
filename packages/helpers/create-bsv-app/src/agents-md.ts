// src/agents-md.ts
import type { ProjectConfig } from './config/model.js'
import { layoutOf } from './config/model.js'
import type { Capability, CapabilityContext } from './types.js'
import { planPlacement } from './engine.js'

function installBlock (label: string, deps: Record<string, string>): string {
  const names = Object.keys(deps)
  if (names.length === 0) return ''
  const ranges = Object.entries(deps).map(([n, r]) => `  ${n}@${r}`).join('\n')
  const head = label.length > 0 ? `### ${label}\n\n` : ''
  const cmd = label.length > 0 ? `cd ${label.replace(/\/$/, '')} && npm i` : 'npm i'
  return `${head}Dependencies are already in \`package.json\` — just install:\n\n\`\`\`\n${cmd}\n\`\`\`\n\nIncluded:\n${ranges}\n\n`
}

export function renderAgentsMd (config: ProjectConfig, capabilities: Capability[]): string {
  const layout = layoutOf(config.stack)
  const ctx: CapabilityContext = { name: config.name, network: config.network, bsvDir: config.bsvDir, stack: config.stack, layout }
  const { deps } = planPlacement(config, capabilities)

  const header = `# ${config.name} — agent guide\n\nScaffolded by \`create-bsv-app\` (layout: **${layout}**, network: **${config.network}**). BSV capabilities live under \`${config.bsvDir}\`. Re-run \`npx create-bsv-app\` inside this folder to add more capabilities.\n\n`
  let depsSection = '## Install dependencies\n\n'
  depsSection += layout === 'monorepo' ? installBlock('client/', deps.client) + installBlock('server/', deps.server) : installBlock('', deps.root)
  const sections = capabilities.map(c => c.agentsSection(ctx).trimEnd())
  return header + depsSection + sections.join('\n\n') + '\n'
}
