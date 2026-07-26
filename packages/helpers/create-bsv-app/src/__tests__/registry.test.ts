// src/__tests__/registry.test.ts
import { describe, expect, test } from '@jest/globals'
import { getCapability, listCapabilities, resolveCapabilities } from '../registry'

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

describe('resolveCapabilities expandRequires', () => {
  // Item 8: expandRequires:false — no auto-pull of wallet-connect
  test('expandRequires:false returns only the named id (wallet-login, no wallet-connect pulled)', () => {
    expect(resolveCapabilities(['wallet-login'], { expandRequires: false }).map(c => c.id)).toEqual(
      ['wallet-login']
    )
  })

  // Item 8: default (expand) pulls wallet-connect first, then wallet-login
  test('default expand: resolveCapabilities wallet-login includes wallet-connect (base before variant)', () => {
    const ids = resolveCapabilities(['wallet-login']).map(c => c.id)
    expect(ids).toContain('wallet-connect')
    expect(ids).toContain('wallet-login')
    // wallet-connect (base) must appear before wallet-login (variant)
    expect(ids.indexOf('wallet-connect')).toBeLessThan(ids.indexOf('wallet-login'))
  })
})
