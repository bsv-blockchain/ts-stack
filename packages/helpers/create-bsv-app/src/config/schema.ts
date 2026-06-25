// src/config/schema.ts
import { listCapabilities } from '../registry.js'

export type FieldType = 'text' | 'select' | 'multiselect' | 'toggle'
export interface FieldOption { value: string, label: string, hint?: string }
/** Object map of field → required value; all entries are AND'd. */
export type When = Record<string, string>
export interface ConfigField {
  key: string
  label: string
  type: FieldType
  ui?: 'segmented'
  options?: FieldOption[]
  default?: string | boolean
  when?: When
}
export interface ConfigSection { id: string, title: string, desc?: string, fields: ConfigField[] }
export type ConfigSchema = ConfigSection[]

function capabilityOptions (): FieldOption[] {
  return listCapabilities().map(c => ({ value: c.id, label: c.title, hint: c.description }))
}

export const configSchema: ConfigSchema = [
  {
    id: 'mode',
    title: 'Mode',
    desc: 'Create a new project or add BSV helpers to an existing one.',
    fields: [
      { key: 'mode', label: 'Create a new project or add to an existing one?', type: 'select', ui: 'segmented', options: [{ value: 'new', label: 'New project' }, { value: 'add', label: 'Add to existing' }] }
    ]
  },
  {
    id: 'project',
    title: 'Project',
    desc: 'Name your project.',
    fields: [
      { key: 'name', label: 'Project name', type: 'text', when: { mode: 'new' } }
    ]
  },
  {
    id: 'stack',
    title: 'Stack',
    desc: 'Frameworks scaffolded alongside your BSV helpers.',
    fields: [
      { key: 'frontend', label: 'Frontend', type: 'select', ui: 'segmented', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'react', label: 'React (Vite)' }], when: { mode: 'new' } },
      { key: 'frontendVariant', label: 'React variant', type: 'select', default: 'react-ts', options: [{ value: 'react-ts', label: 'React + TypeScript' }], when: { mode: 'new', frontend: 'react' } },
      { key: 'backend', label: 'Backend', type: 'select', ui: 'segmented', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'express', label: 'Express (TypeScript)' }], when: { mode: 'new' } }
    ]
  },
  {
    id: 'bsv',
    title: 'BSV',
    desc: 'Capabilities and integration helpers.',
    fields: [
      { key: 'bsvDir', label: 'BSV helpers directory', type: 'text', default: 'src/bsv', when: { mode: 'new' } },
      { key: 'capabilities', label: 'Capabilities', type: 'multiselect', options: capabilityOptions() },
      { key: 'glue', label: 'Auto-wire wallet providers into the app entry (main.tsx)', type: 'toggle', default: true, when: { mode: 'new' } }
    ]
  },
  {
    id: 'tooling',
    title: 'Tooling',
    desc: 'Package manager and target network.',
    fields: [
      { key: 'packageManager', label: 'Package manager', type: 'select', default: 'npm', options: [{ value: 'npm', label: 'npm' }, { value: 'pnpm', label: 'pnpm' }, { value: 'yarn', label: 'yarn' }, { value: 'bun', label: 'bun' }], when: { mode: 'new' } },
      { key: 'network', label: 'Network', type: 'select', ui: 'segmented', default: 'test', options: [{ value: 'test', label: 'Testnet' }, { value: 'main', label: 'Mainnet' }], when: { mode: 'new' } }
    ]
  }
]

export function evaluateWhen (when: When | undefined, draft: Record<string, unknown>): boolean {
  if (when === undefined) return true
  return Object.keys(when).every(k => draft[k] === when[k])
}

export function isFieldVisible (field: ConfigField, draft: Record<string, unknown>): boolean {
  return evaluateWhen(field.when, draft)
}

export function visibleFields (section: ConfigSection, draft: Record<string, unknown>): ConfigField[] {
  return section.fields.filter(f => isFieldVisible(f, draft))
}
