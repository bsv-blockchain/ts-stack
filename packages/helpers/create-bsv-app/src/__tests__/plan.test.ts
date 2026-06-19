// src/__tests__/plan.test.ts
import { describe, expect, test } from '@jest/globals'
import { planFiles, aggregateDependencies } from '../engine'

describe('planFiles', () => {
  test('returns react files for a react selection', () => {
    const specs = planFiles({ appName: 'demo', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
    const paths = specs.map(s => s.path)
    expect(paths).toContain('src/bsv/auth.ts')
    expect(paths).toContain('src/bsv/useWalletLogin.tsx')
    expect(paths).not.toContain('src/bsv/loginRoute.ts')
  })

  test('throws on an unknown capability id', () => {
    expect(() => planFiles({ appName: 'demo', network: 'test', framework: 'express', capabilityIds: ['nope'] }))
      .toThrow(/unknown capability/i)
  })
})

describe('aggregateDependencies', () => {
  test('merges deps for the selected framework', () => {
    const deps = aggregateDependencies({ appName: 'demo', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
    expect(deps).toHaveProperty('@bsv/auth')
    expect(deps).toHaveProperty('@bsv/wallet-relay')
  })
})
