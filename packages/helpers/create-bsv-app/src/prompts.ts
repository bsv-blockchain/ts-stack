import type { PromptProvider } from './cli.js'
import type { Framework, Selection } from './types.js'
import { listCapabilities, getCapability } from './registry.js'
import { remainingCapabilityIds } from './manifest.js'
import { basename } from 'node:path'

export const interactivePrompt: PromptProvider = async ({ existing }) => {
  const p = await import('@clack/prompts') // lazy: keeps Jest (CJS) from loading ESM-only clack

  p.intro('create-bsv-app')

  const appName: string = existing != null
    ? existing.name
    : await (async () => {
      const res = await p.text({ message: 'Project name', placeholder: basename(process.cwd()) })
      if (p.isCancel(res)) { p.cancel('Cancelled'); process.exit(1) }
      return (typeof res === 'string' && res.length > 0) ? res : basename(process.cwd())
    })()

  let framework: Framework
  if (existing != null) {
    framework = existing.framework // locked for an existing project
  } else {
    const res = await p.select({
      message: 'Framework',
      options: [
        { value: 'express', label: 'Express (server)' },
        { value: 'react', label: 'React (browser)' }
      ]
    })
    if (p.isCancel(res)) { p.cancel('Cancelled'); process.exit(1) }
    framework = res as Framework
  }

  const offerable = existing != null
    ? remainingCapabilityIds(existing)
    : listCapabilities().map(c => c.id)
  const options = offerable.map(id => {
    const c = getCapability(id)
    if (c == null) throw new Error(`Unknown capability: ${id}`)
    return { value: id, label: c.title, hint: c.description }
  })

  const picked = await p.multiselect({
    message: existing != null ? 'Add capabilities' : 'Select capabilities',
    options,
    required: existing == null
  })
  if (p.isCancel(picked)) { p.cancel('Cancelled'); process.exit(1) }

  p.outro('Generating…')

  const selection: Selection = {
    appName,
    network: existing?.network ?? 'test',
    framework,
    capabilityIds: [...(existing?.capabilities ?? []), ...(picked as string[])]
  }
  return selection
}
