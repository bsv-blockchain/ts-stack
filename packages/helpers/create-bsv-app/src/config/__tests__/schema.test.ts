// src/config/__tests__/schema.test.ts
import { describe, expect, test } from '@jest/globals'
import { configSchema, isFieldVisible, visibleFields } from '../schema'
import type { ConfigField } from '../schema'

function field (key: string): ConfigField {
  for (const s of configSchema) {
    const f = s.fields.find(x => x.key === key)
    if (f !== undefined) return f
  }
  throw new Error(`field not found: ${key}`)
}

describe('config schema', () => {
  test('has the expected sections', () => {
    expect(configSchema.map(s => s.id)).toEqual(['mode', 'project', 'stack', 'bsv', 'tooling'])
  })

  test('mode is the first section', () => {
    expect(configSchema[0].id).toBe('mode')
    expect(configSchema[0].fields.map(f => f.key)).toContain('mode')
  })

  test('new-only fields are hidden in add mode', () => {
    const f = (k: string): ConfigField => configSchema.flatMap(s => s.fields).find(x => x.key === k) ?? (() => { throw new Error(`field not found: ${k}`) })()
    expect(isFieldVisible(f('frontend'), { mode: 'add' })).toBe(false)
    expect(isFieldVisible(f('frontend'), { mode: 'new' })).toBe(true)
    expect(isFieldVisible(f('capabilities'), { mode: 'add' })).toBe(true)
  })

  test('frontendVariant is hidden unless mode is new and frontend is react', () => {
    const f = field('frontendVariant')
    expect(isFieldVisible(f, { mode: 'new', frontend: 'none' })).toBe(false)
    expect(isFieldVisible(f, { mode: 'new', frontend: 'react' })).toBe(true)
    expect(isFieldVisible(f, { mode: 'add', frontend: 'react' })).toBe(false)
  })

  test('capabilities options come from the registry (includes wallet-login)', () => {
    expect(field('capabilities').options?.map(o => o.value)).toContain('wallet-login')
  })

  test('visibleFields filters the stack section by the draft', () => {
    const stack = configSchema.find(s => s.id === 'stack')
    if (stack === undefined) throw new Error('no stack section')
    expect(visibleFields(stack, { mode: 'new', frontend: 'none' }).map(f => f.key)).not.toContain('frontendVariant')
    expect(visibleFields(stack, { mode: 'new', frontend: 'react' }).map(f => f.key)).toContain('frontendVariant')
  })
})
