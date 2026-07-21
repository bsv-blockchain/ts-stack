import { describe, expect, test } from '@jest/globals'
import { capabilityStarterIds, getStarter, listStarters } from '../starters'

describe('unified starter catalogue', () => {
  test('contains the generated starters and every legacy example except Convo', () => {
    const ids = listStarters().map(starter => starter.id)
    expect(ids).toEqual([
      'custom', 'react', 'express', 'full-stack',
      'brc102-frontend', 'brc102-backend', 'pollr', 'meter', 'metamarket', 'todo',
      'marscast', 'coinflip', 'postboard', 'locksmith', 'peerpay', 'atfinder'
    ])
    expect(ids.some(id => id.toLowerCase().includes('convo'))).toBe(false)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('repository entries are reproducible and do not accept generated capabilities', () => {
    const repositoryStarters = listStarters().filter(starter => starter.kind === 'repository')
    expect(repositoryStarters).toHaveLength(12)
    for (const starter of repositoryStarters) {
      expect(starter.repository).toMatch(/^https:\/\/github\.com\/p2ppsr\/.+\.git$/)
      expect(starter.ref).toMatch(/^(main|master)$/)
      expect(starter.supportsCapabilities).toBe(false)
    }
  })

  test('capability starter ids are derived from the same registry', () => {
    expect(capabilityStarterIds()).toEqual(['custom', 'react', 'express', 'full-stack'])
    expect(getStarter('meter')?.brc102).toBe(true)
    expect(getStarter('marscast')?.brc102).toBe(false)
  })
})
