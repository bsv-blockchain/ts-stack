// src/agents-md.ts
import type { GenContext, Selection } from './types.js'
import { getCapability } from './registry.js'
import { aggregateDependencies } from './engine.js'

export function renderAgentsMd (selection: Selection): string {
  const ctx: GenContext = { appName: selection.appName, network: selection.network, framework: selection.framework }

  const header = `# ${selection.appName} — agent guide

Scaffolded by \`create-bsv-app\` for the **${selection.framework}** framework on the **${selection.network}** network. BSV capabilities live under \`src/bsv/\`. Re-run \`npx create-bsv-app\` inside this folder to add more capabilities.

`

  const deps = aggregateDependencies(selection)
  const depLines = Object.entries(deps).map(([name, range]) => `  ${name}@${range}`).join('\n')
  const depsSection = `## Install dependencies

\`\`\`
npm install \\
${Object.keys(deps).join(' ')}
\`\`\`

Required ranges:
${depLines}

`

  const sections = selection.capabilityIds.map(id => {
    const c = getCapability(id)
    if (c == null) throw new Error(`unknown capability: ${id}`)
    return c.agentsSection(ctx).trimEnd()
  })

  return header + depsSection + sections.join('\n\n') + '\n'
}
