// src/__tests__/plan-conflict.test.ts
import { describe, expect, jest, test } from '@jest/globals'

import { planFiles } from '../engine'

// jest.mock is hoisted; define fake capabilities inside the factory.
jest.mock('../registry', () => {
  const capA = {
    id: 'a',
    title: 'Cap A',
    description: 'fake cap a',
    requires: [],
    frameworks: ['express'],
    files: () => [{ path: 'src/bsv/auth.ts', content: 'content-from-a' }],
    npmDependencies: () => ({}),
    agentsSection: () => ''
  }
  const capB = {
    id: 'b',
    title: 'Cap B',
    description: 'fake cap b',
    requires: [],
    frameworks: ['express'],
    files: () => [{ path: 'src/bsv/auth.ts', content: 'content-from-b' }],
    npmDependencies: () => ({}),
    agentsSection: () => ''
  }
  const capC = {
    id: 'c',
    title: 'Cap C',
    description: 'fake cap c (same content as a)',
    requires: [],
    frameworks: ['express'],
    files: () => [{ path: 'src/bsv/auth.ts', content: 'content-from-a' }],
    npmDependencies: () => ({}),
    agentsSection: () => ''
  }
  const all = [capA, capB, capC]
  return {
    listCapabilities: () => all,
    getCapability: (id: string) => all.find(c => c.id === id)
  }
})

describe('planFiles – conflict detection', () => {
  test('throws "file conflict" when two capabilities emit the same path with different content', () => {
    expect(() =>
      planFiles({ appName: 'x', network: 'test', framework: 'express', capabilityIds: ['a', 'b'] })
    ).toThrow(/file conflict/i)
  })

  test('does NOT throw and deduplicates when two capabilities emit the same path with identical content', () => {
    const specs = planFiles({ appName: 'x', network: 'test', framework: 'express', capabilityIds: ['a', 'c'] })
    // both 'a' and 'c' emit 'src/bsv/auth.ts' with identical content — deduped to one entry
    const paths = specs.map(s => s.path)
    expect(paths.filter(p => p === 'src/bsv/auth.ts')).toHaveLength(1)
  })
})
