// src/config/schema.ts
import { listCapabilities } from '../registry.js'

export type FieldType = 'text' | 'select' | 'multiselect' | 'toggle'
export interface FieldOption { value: string, label: string, hint?: string }
export interface ConfigField {
  key: string
  label: string
  type: FieldType
  options?: FieldOption[]
  default?: string | boolean
  when?: (draft: Record<string, unknown>) => boolean
}
export interface ConfigSection { id: string, title: string, fields: ConfigField[] }
export type ConfigSchema = ConfigSection[]

function capabilityOptions (): FieldOption[] {
  return listCapabilities().map(c => ({ value: c.id, label: c.title, hint: c.description }))
}

export const configSchema: ConfigSchema = [
  {
    id: 'mode',
    title: 'Mode',
    fields: [
      { key: 'mode', label: 'Create a new project or add to an existing one?', type: 'select', options: [{ value: 'new', label: 'New project' }, { value: 'add', label: 'Add to existing' }] }
    ]
  },
  {
    id: 'project',
    title: 'Project',
    fields: [
      { key: 'name', label: 'Project name', type: 'text', when: (d) => d.mode === 'new' }
    ]
  },
  {
    id: 'stack',
    title: 'Stack',
    fields: [
      { key: 'frontend', label: 'Frontend', type: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'react', label: 'React (Vite)' }], when: (d) => d.mode === 'new' },
      { key: 'frontendVariant', label: 'React variant', type: 'select', default: 'react-ts', options: [{ value: 'react-ts', label: 'React + TypeScript' }], when: (d) => d.mode === 'new' && d.frontend === 'react' },
      { key: 'backend', label: 'Backend', type: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'express', label: 'Express (TypeScript)' }], when: (d) => d.mode === 'new' }
    ]
  },
  {
    id: 'bsv',
    title: 'BSV',
    fields: [
      { key: 'bsvDir', label: 'BSV helpers directory', type: 'text', default: 'src/bsv', when: (d) => d.mode === 'new' },
      { key: 'capabilities', label: 'Capabilities', type: 'multiselect', options: capabilityOptions() },
      { key: 'glue', label: 'Generate integration (glue) files', type: 'toggle', default: false, when: (d) => d.mode === 'new' }
    ]
  },
  {
    id: 'tooling',
    title: 'Tooling',
    fields: [
      { key: 'packageManager', label: 'Package manager', type: 'select', default: 'npm', options: [{ value: 'npm', label: 'npm' }, { value: 'pnpm', label: 'pnpm' }, { value: 'yarn', label: 'yarn' }, { value: 'bun', label: 'bun' }], when: (d) => d.mode === 'new' },
      { key: 'network', label: 'Network', type: 'select', default: 'test', options: [{ value: 'test', label: 'Testnet' }, { value: 'main', label: 'Mainnet' }], when: (d) => d.mode === 'new' }
    ]
  }
]

export function isFieldVisible (field: ConfigField, draft: Record<string, unknown>): boolean {
  return field.when === undefined ? true : field.when(draft)
}

export function visibleFields (section: ConfigSection, draft: Record<string, unknown>): ConfigField[] {
  return section.fields.filter(f => isFieldVisible(f, draft))
}
