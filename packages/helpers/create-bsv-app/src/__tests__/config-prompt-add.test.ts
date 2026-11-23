// src/__tests__/config-prompt-add.test.ts
// Isolated test for add-mode capabilities ask + union.
// Uses a two-capability mock registry so a new cap can be added on top of an existing one.
import { describe, expect, test, jest } from '@jest/globals'
import type { Capability } from '../types'
import { runPrompts } from '../prompts'
import type { Ask } from '../prompts'
import type { ConfigField } from '../config/schema'
import type { ProjectManifest } from '../config/project-manifest'

// Capability definitions live inside the factory so they are accessible when jest hoists the call
jest.mock('../registry', () => {
  const a: Capability = {
    id: 'a',
    title: 'Cap A',
    description: 'First fake cap',
    roles: ['shared'],
    files: () => ({ shared: [{ path: 'a.ts', content: 'a' }] }),
    npmDependencies: () => ({}),
    agentsSection: () => ''
  }
  const b: Capability = {
    id: 'b',
    title: 'Cap B',
    description: 'Second fake cap',
    roles: ['shared'],
    files: () => ({ shared: [{ path: 'b.ts', content: 'b' }] }),
    npmDependencies: () => ({}),
    agentsSection: () => ''
  }
  return {
    getCapability: (id: string): Capability | undefined => [a, b].find(c => c.id === id),
    listCapabilities: (): Capability[] => [a, b],
    requiredIds: (): string[] => [] // neither fake cap requires anything
  }
})

describe('runPrompts – add mode (mocked 2-cap registry)', () => {
  test('add mode: capabilities IS asked and the result is unioned with existing', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['a']
    }
    const askedKeys: string[] = []
    let initialCapabilities: unknown
    const ask: Ask = async (field: ConfigField, _options, initial) => {
      askedKeys.push(field.key)
      if (field.key === 'capabilities') initialCapabilities = initial
      // Answer 'b' when asked about capabilities; undefined for any other field
      return field.key === 'capabilities' ? ['b'] : undefined
    }
    const c = await runPrompts({ existing, flags: {} }, ask)
    expect(askedKeys).toContain('capabilities') // must be asked in add mode
    expect(askedKeys).not.toContain('frontend') // locked / hidden in add mode
    expect(c.mode).toBe('add')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['a', 'b']) // union: existing 'a' + newly added 'b'
    expect(initialCapabilities).toEqual([]) // 'b' offered but not pre-ticked in add mode
  })

  test('asks once, as a toggle defaulting to no, before a cross-major raise of an owned package', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['a']
    }
    const asked: Array<{ field: ConfigField; initial: unknown }> = []
    const ask: Ask = async (field, _options, initial) => {
      asked.push({ field, initial })
      return field.key === 'capabilities' ? ['b'] : true
    }
    const pending = [
      {
        target: 'client' as const,
        name: '@bsv/sdk',
        from: '^1.2.0',
        to: '^4.0.1',
        action: 'left' as const,
        reason: 'majorUpgrade' as const
      }
    ]
    const seen: string[][] = []
    const c = await runPrompts(
      {
        existing,
        flags: {},
        majorUpgrades: config => {
          seen.push(config.capabilities)
          return pending
        }
      },
      ask
    )
    expect(seen).toEqual([['a', 'b']]) // checked once, against the resolved config
    const upgrade = asked.find(a => a.field.key === 'upgradeBsvDeps')
    expect(upgrade?.field.type).toBe('toggle')
    expect(upgrade?.initial).toBe(false)
    expect(upgrade?.field.label).toContain('@bsv/sdk ^1.2.0 → ^4.0.1')
    expect(c.upgradeBsvDeps).toBe(true)

    const quiet: string[] = []
    const none = await runPrompts({ existing, flags: {}, majorUpgrades: () => [] }, async field => {
      quiet.push(field.key)
      return ['b']
    })
    expect(quiet).not.toContain('upgradeBsvDeps')
    expect(none.upgradeBsvDeps).toBeUndefined()
  })
})
