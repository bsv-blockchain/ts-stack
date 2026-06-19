import { describe, expect, test } from '@jest/globals'
import { VERSION } from '../version'

describe('package smoke', () => {
  test('exposes a semver-ish version string', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
