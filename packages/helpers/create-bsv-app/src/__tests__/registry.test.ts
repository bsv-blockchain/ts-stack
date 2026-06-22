// src/__tests__/registry.test.ts
import { describe, expect, test } from '@jest/globals'
import { getCapability, listCapabilities } from '../registry'

describe('capability registry', () => {
  test('lists the wallet-login capability', () => {
    expect(listCapabilities().map(c => c.id)).toContain('wallet-login')
  })

  test('getCapability returns a capability with required fields', () => {
    const c = getCapability('wallet-login')
    expect(c).toBeDefined()
    expect(c?.title.length).toBeGreaterThan(0)
    expect(Array.isArray(c?.roles)).toBe(true)
    expect(typeof c?.files).toBe('function')
    expect(typeof c?.npmDependencies).toBe('function')
    expect(typeof c?.agentsSection).toBe('function')
  })

  test('getCapability returns undefined for unknown id', () => {
    expect(getCapability('nope')).toBeUndefined()
  })
})
