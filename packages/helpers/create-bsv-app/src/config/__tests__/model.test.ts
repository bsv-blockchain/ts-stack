// src/config/__tests__/model.test.ts
import { describe, expect, test } from '@jest/globals'
import { isMonorepo, layoutOf } from '../model'
import type { Stack } from '../model'

describe('layout helpers', () => {
  const fe: Stack = { frontend: { framework: 'react', variant: 'react-ts' } }
  const be: Stack = { backend: { framework: 'express' } }
  const both: Stack = { ...fe, ...be }

  test('isMonorepo is true only when both targets present', () => {
    expect(isMonorepo(both)).toBe(true)
    expect(isMonorepo(fe)).toBe(false)
    expect(isMonorepo(be)).toBe(false)
    expect(isMonorepo({})).toBe(false)
  })

  test('layoutOf classifies each shape', () => {
    expect(layoutOf(both)).toBe('monorepo')
    expect(layoutOf(fe)).toBe('frontend-only')
    expect(layoutOf(be)).toBe('backend-only')
    expect(layoutOf({})).toBe('none')
  })
})
