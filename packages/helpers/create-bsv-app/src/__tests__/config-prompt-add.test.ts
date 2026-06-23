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
    listCapabilities: (): Capability[] => [a, b]
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
    const ask: Ask = async (field: ConfigField) => {
      askedKeys.push(field.key)
      // Answer 'b' when asked about capabilities; undefined for any other field
      return field.key === 'capabilities' ? ['b'] : undefined
    }
    const c = await runPrompts({ existing, flags: {} }, ask)
    expect(askedKeys).toContain('capabilities') // must be asked in add mode
    expect(askedKeys).not.toContain('frontend') // locked / hidden in add mode
    expect(c.mode).toBe('add')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['a', 'b']) // union: existing 'a' + newly added 'b'
  })
})
