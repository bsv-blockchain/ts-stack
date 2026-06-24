import { describe, expect, test } from '@jest/globals'
import { registry, resolveCapabilities } from '../registry'
import type { Role } from '../types'

const ctx = { name: 'd', network: 'test' as const, bsvDir: 'src/bsv', stack: { frontend: { framework: 'react' as const, variant: 'react-ts' }, backend: { framework: 'express' as const } }, layout: 'monorepo' as const }

describe('registry consistency', () => {
  test('ids are unique', () => {
    const ids = registry.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  test('every requires resolves', () => {
    for (const c of registry) {
      for (const r of c.requires ?? []) {
        expect(registry.some(x => x.id === r)).toBe(true)
      }
    }
    expect(() => resolveCapabilities(registry.map(c => c.id))).not.toThrow()
  })
  test('roles cover the keys each capability emits', () => {
    for (const c of registry) {
      const keys = new Set<string>([
        ...Object.keys(c.files(ctx)),
        ...Object.keys(c.glue?.(ctx) ?? {}),
        ...Object.keys(c.npmDependencies(ctx))
      ])
      for (const k of keys) {
        expect(c.roles).toContain(k as Role)
      }
    }
  })
})
