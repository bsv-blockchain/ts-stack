import { jest, describe, expect, test, beforeAll } from '@jest/globals'
import type { ConfigDraft } from '../draft'
import type { ProjectManifest } from '../project-manifest'

jest.mock('../../registry', () => ({
  listCapabilities: () => [
    {
      id: 'wallet-connect',
      defaultSelected: true,
      roles: [],
      files: () => ({}),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    },
    {
      id: 'extra',
      roles: [],
      files: () => ({}),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
  ]
}))

let seedDraft: (existing: ProjectManifest | null, flags: ConfigDraft) => ConfigDraft

beforeAll(async () => {
  const mod = await import('../draft')
  seedDraft = mod.seedDraft
})

describe('seedDraft default-selected capabilities', () => {
  test('NEW mode (no manifest) pre-selects defaultSelected ids', () => {
    expect(seedDraft(null, {}).capabilities).toEqual(['wallet-connect'])
  })
  test('NEW mode unions explicit flags with defaults', () => {
    expect(seedDraft(null, { capabilities: ['extra'] }).capabilities?.sort()).toEqual([
      'extra',
      'wallet-connect'
    ])
  })
  test('ADD mode does NOT auto-select defaults', () => {
    const m = {
      version: 1 as const,
      name: 'x',
      network: 'test' as const,
      stack: {},
      bsvDir: 'src/bsv',
      capabilities: []
    }
    expect(seedDraft(m, {}).capabilities).toEqual([])
  })
})
