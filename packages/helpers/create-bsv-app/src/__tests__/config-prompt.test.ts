// src/__tests__/config-prompt.test.ts
import { describe, expect, test } from '@jest/globals'
import { runPrompts } from '../prompts'
import type { Ask } from '../prompts'
import type { ConfigField } from '../config/schema'
import type { ProjectManifest } from '../config/project-manifest'

// a scripted ask that answers by field key
function scriptedAsk (answers: Record<string, unknown>) {
  return async (field: ConfigField) => answers[field.key]
}

describe('runPrompts', () => {
  test('new mode: asks the full set, builds a ProjectConfig', async () => {
    const ask = scriptedAsk({ mode: 'new', name: 'demo', frontend: 'react', frontendVariant: 'react-ts', backend: 'none', bsvDir: 'src/bsv', capabilities: ['wallet-login'], glue: false, packageManager: 'npm', network: 'test' })
    const c = await runPrompts({ existing: null, flags: {} }, ask)
    expect(c.mode).toBe('new')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['wallet-login'])
  })

  test('add mode: locks fields from the manifest, only asks capabilities, unions', async () => {
    const existing: ProjectManifest = { version: 1, name: 'demo', network: 'test', stack: { frontend: { framework: 'react', variant: 'react-ts' } }, bsvDir: 'src/bsv', capabilities: ['wallet-login'] }
    const askedKeys: string[] = []
    const ask: Ask = async (field) => { askedKeys.push(field.key); return field.key === 'capabilities' ? [] : undefined }
    const c = await runPrompts({ existing, flags: {} }, ask)
    expect(askedKeys).not.toContain('frontend') // locked / hidden in add mode
    expect(c.mode).toBe('add')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['wallet-login'])
  })

  test('flags prefill skips asking that field', async () => {
    const askedKeys: string[] = []
    const ask: Ask = async (field) => { askedKeys.push(field.key); return field.key === 'name' ? 'fromPrompt' : field.key === 'frontend' ? 'react' : field.key === 'capabilities' ? ['wallet-login'] : undefined }
    const c = await runPrompts({ existing: null, flags: { mode: 'new', name: 'fromFlag' } }, ask)
    expect(askedKeys).not.toContain('mode') // set by flag
    expect(askedKeys).not.toContain('name') // set by flag
    expect(c.name).toBe('fromFlag')
  })
})
