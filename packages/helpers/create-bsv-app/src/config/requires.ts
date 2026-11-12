// src/config/requires.ts
import type { Layout, PulledCapability } from './model.js'
import { getCapability, listCapabilities, requiredIds } from '../registry.js'

const requiredIn = (id: string, layout: Layout): string[] => {
  const capability = getCapability(id)
  return capability === undefined ? [] : requiredIds(capability, layout)
}

/** `ids` plus everything they require in `layout`, transitively, in registry order. */
export function capabilityClosure(ids: string[], layout: Layout): string[] {
  const closed = new Set<string>()
  const visit = (id: string): void => {
    if (closed.has(id)) return
    closed.add(id)
    for (const dep of requiredIn(id, layout)) visit(dep)
  }
  for (const id of ids) visit(id)
  return listCapabilities()
    .map(c => c.id)
    .filter(id => closed.has(id))
}

/** What closing `requested` adds that was neither requested nor already installed. */
export function pulledCapabilities(
  requested: string[],
  layout: Layout,
  installed: string[] = []
): PulledCapability[] {
  const closure = capabilityClosure(requested, layout)
  return closure
    .filter(id => !requested.includes(id) && !installed.includes(id))
    .map(id => ({
      id,
      requiredBy: closure.filter(member => requiredIn(member, layout).includes(id))
    }))
}

/** One line per pulled capability; every entry point shows this text. */
export function formatPulledNotice(pulled: PulledCapability[]): string[] {
  return pulled.map(p => `Also adding ${p.id} (required by ${p.requiredBy.join(', ')}).`)
}
