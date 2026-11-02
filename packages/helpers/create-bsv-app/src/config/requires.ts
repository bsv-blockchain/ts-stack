// src/config/requires.ts
import type { PulledCapability } from './model.js'
import { getCapability, listCapabilities } from '../registry.js'

/** `ids` plus everything they require, transitively, in registry order. */
export function capabilityClosure(ids: string[]): string[] {
  const closed = new Set<string>()
  const visit = (id: string): void => {
    if (closed.has(id)) return
    closed.add(id)
    for (const dep of getCapability(id)?.requires ?? []) visit(dep)
  }
  for (const id of ids) visit(id)
  return listCapabilities()
    .map(c => c.id)
    .filter(id => closed.has(id))
}

/** What closing `requested` adds that was neither requested nor already installed. */
export function pulledCapabilities(
  requested: string[],
  installed: string[] = []
): PulledCapability[] {
  const closure = capabilityClosure(requested)
  return closure
    .filter(id => !requested.includes(id) && !installed.includes(id))
    .map(id => ({
      id,
      requiredBy: closure.filter(member => getCapability(member)?.requires?.includes(id) === true)
    }))
}

/** One line per pulled capability; every entry point shows this text. */
export function formatPulledNotice(pulled: PulledCapability[]): string[] {
  return pulled.map(p => `Also adding ${p.id} (required by ${p.requiredBy.join(', ')}).`)
}
