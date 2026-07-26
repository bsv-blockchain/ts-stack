// src/__tests__/config-prompt.test.ts
import { describe, expect, test } from '@jest/globals'
import { runPrompts } from '../prompts'
import type { Ask } from '../prompts'
import type { FieldOption } from '../config/schema'
import type { ProjectManifest } from '../config/project-manifest'

describe('runPrompts', () => {
  test('new mode: asks the full set, builds a ProjectConfig', async () => {
    const capabilityOptions: FieldOption[] = []
    const ask: Ask = async (field, options) => {
      if (field.key === 'capabilities') capabilityOptions.push(...options)
      const scripted: Record<string, unknown> = {
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        frontendVariant: 'react-ts',
        backend: 'none',
        bsvDir: 'src/bsv',
        capabilities: ['wallet-login'],
        glue: false,
        packageManager: 'npm',
        network: 'test'
      }
      return scripted[field.key]
    }
    const c = await runPrompts({ existing: null, flags: {} }, ask)
    expect(c.mode).toBe('new')
    expect(c.stack.frontend?.framework).toBe('react')
    // wallet-connect is defaultSelected → excluded from new-mode picker options
    expect(capabilityOptions.map(o => o.value)).not.toContain('wallet-connect')
    // wallet-login IS offered as a picker option in new mode
    expect(capabilityOptions.map(o => o.value)).toContain('wallet-login')
    // wallet-connect is still in the final config (pre-seeded by seedDraft + floored by resolveConfig)
    expect(c.capabilities).toEqual(expect.arrayContaining(['wallet-connect', 'wallet-login']))
    expect(c.capabilities).toHaveLength(2)
  })

  test('add mode: locks fields from the manifest, only asks capabilities, unions', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-login']
    }
    const askedKeys: string[] = []
    const ask: Ask = async field => {
      askedKeys.push(field.key)
      return field.key === 'capabilities' ? [] : undefined
    }
    const c = await runPrompts({ existing, flags: {} }, ask)
    expect(askedKeys).not.toContain('frontend') // locked / hidden in add mode
    expect(c.mode).toBe('add')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['wallet-login'])
  })

  test('flags prefill skips asking that field', async () => {
    const askedKeys: string[] = []
    const ask: Ask = async field => {
      askedKeys.push(field.key)
      return field.key === 'name'
        ? 'fromPrompt'
        : field.key === 'frontend'
          ? 'react'
          : field.key === 'capabilities'
            ? ['wallet-login']
            : undefined
    }
    const c = await runPrompts({ existing: null, flags: { mode: 'new', name: 'fromFlag' } }, ask)
    expect(askedKeys).not.toContain('mode') // set by flag
    expect(askedKeys).not.toContain('name') // set by flag
    expect(c.name).toBe('fromFlag')
  })

  test('add mode without a manifest offers every capability', async () => {
    let offeredCapabilityCount = 0
    const c = await runPrompts(
      { existing: null, flags: { mode: 'add', name: 'untracked-project' } },
      async (field, options) => {
        if (field.key === 'capabilities') {
          offeredCapabilityCount = options.length
          return []
        }
        return undefined
      }
    )

    expect(offeredCapabilityCount).toBeGreaterThan(0)
    expect(c.mode).toBe('add')
    expect(c.name).toBe('untracked-project')
  })
})
