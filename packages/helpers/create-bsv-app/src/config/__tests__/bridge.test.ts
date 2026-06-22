// src/config/__tests__/bridge.test.ts
import { describe, expect, test } from '@jest/globals'
import { selectionToConfig } from '../bridge'

describe('selectionToConfig (transitional Selection -> ProjectConfig)', () => {
  test('maps react to a frontend stack, applying resolveConfig defaults', () => {
    const c = selectionToConfig({ appName: 'demo', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
    expect(c.stack).toEqual({ frontend: { framework: 'react', variant: 'react-ts' } })
    expect(c.mode).toBe('add')
    expect(c.capabilities).toEqual(['wallet-login'])
    // defaults sourced from resolveConfig (single source of truth)
    expect(c.bsvDir).toBe('src/bsv')
    expect(c.packageManager).toBe('npm')
    expect(c.glue).toBe(false)
  })

  test('maps express to a backend stack', () => {
    const c = selectionToConfig({ appName: 'demo', network: 'main', framework: 'express', capabilityIds: [] })
    expect(c.stack).toEqual({ backend: { framework: 'express' } })
    expect(c.network).toBe('main')
  })
})
