// src/config/__tests__/schema.test.ts
import { describe, expect, test } from '@jest/globals'
import { configSchema, isFieldVisible, visibleFields, evaluateWhen } from '../schema'
import type { ConfigField } from '../schema'

function field (key: string): ConfigField {
  for (const s of configSchema) {
    const f = s.fields.find(x => x.key === key)
    if (f !== undefined) return f
  }
  throw new Error(`field not found: ${key}`)
}

describe('evaluateWhen', () => {
  test('undefined when is always visible', () => {
    expect(evaluateWhen(undefined, {})).toBe(true)
  })
  test('all entries must match (AND)', () => {
    expect(evaluateWhen({ mode: 'new', frontend: 'react' }, { mode: 'new', frontend: 'react' })).toBe(true)
    expect(evaluateWhen({ mode: 'new', frontend: 'react' }, { mode: 'new', frontend: 'none' })).toBe(false)
    expect(evaluateWhen({ mode: 'new' }, { mode: 'add' })).toBe(false)
  })
  test('missing draft key fails the condition', () => {
    expect(evaluateWhen({ mode: 'new' }, {})).toBe(false)
  })
})

describe('config schema', () => {
  test('has the expected sections', () => {
    expect(configSchema.map(s => s.id)).toEqual(['mode', 'project', 'stack', 'bsv', 'tooling'])
  })

  test('mode is the first section', () => {
    expect(configSchema[0].id).toBe('mode')
    expect(configSchema[0].fields.map(f => f.key)).toContain('mode')
  })

  test('when conditions are declarative objects', () => {
    expect(field('frontend').when).toEqual({ mode: 'new' })
    expect(field('frontendVariant').when).toEqual({ mode: 'new', frontend: 'react' })
    expect(field('capabilities').when).toBeUndefined()
  })

  test('new-only fields are hidden in add mode', () => {
    expect(isFieldVisible(field('frontend'), { mode: 'add' })).toBe(false)
    expect(isFieldVisible(field('frontend'), { mode: 'new' })).toBe(true)
    expect(isFieldVisible(field('capabilities'), { mode: 'add' })).toBe(true)
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

describe('schema ui/desc hints', () => {
  test('sections carry a desc string', () => {
    for (const s of configSchema) expect(typeof s.desc).toBe('string')
  })
  test('mode/frontend/backend/network fields are segmented; type stays select', () => {
    const f = (k: string): ConfigField => configSchema.flatMap(s => s.fields).find(x => x.key === k) ?? (() => { throw new Error(k) })()
    for (const k of ['mode', 'frontend', 'backend', 'network']) {
      expect(f(k).ui).toBe('segmented')
      expect(f(k).type).toBe('select')
    }
  })
  test('hints do not affect visibility logic', () => {
    const frontend = configSchema.flatMap(s => s.fields).find(x => x.key === 'frontend')
    if (frontend === undefined) throw new Error('no frontend field')
    expect(isFieldVisible(frontend, { mode: 'new' })).toBe(true)
    expect(isFieldVisible(frontend, { mode: 'add' })).toBe(false)
  })
})
