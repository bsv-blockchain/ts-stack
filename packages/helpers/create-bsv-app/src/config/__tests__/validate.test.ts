// src/config/__tests__/validate.test.ts
import { describe, expect, test } from '@jest/globals'
import { resolveConfig, ConfigError, formatConfigError } from '../validate'

const minimal = { name: 'demo', stack: { frontend: { framework: 'react' } } }

describe('resolveConfig', () => {
  test('applies defaults to a minimal valid config', () => {
    const c = resolveConfig(minimal)
    expect(c).toEqual({
      mode: 'new',
      name: 'demo',
      dir: '.',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: [],
      glue: false,
      packageManager: 'npm',
      network: 'test'
    })
  })

  test('throws when name missing', () => {
    expect(() => resolveConfig({ stack: { backend: { framework: 'express' } } })).toThrow(ConfigError)
  })

  test('throws when new project has no targets', () => {
    expect(() => resolveConfig({ name: 'x' })).toThrow(/frontend or a backend/i)
  })

  test('throws on an invalid frontend framework', () => {
    expect(() => resolveConfig({ name: 'x', stack: { frontend: { framework: 'svelte' } } })).toThrow(ConfigError)
  })

  test('throws on an unknown capability', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, capabilities: ['nope'] }))
      .toThrow(/unknown capability: nope/i)
  })

  test('dedupes capabilities and accepts known ones', () => {
    const c = resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, capabilities: ['wallet-login', 'wallet-login'] })
    expect(c.capabilities).toEqual(['wallet-login'])
  })

  test('rejects an unsafe bsvDir', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, bsvDir: '../escape' })).toThrow(ConfigError)
  })

  test('normalizes packageManager and network with defaults', () => {
    const c = resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, packageManager: 'maven', network: 'main' })
    expect(c.packageManager).toBe('npm')
    expect(c.network).toBe('main')
  })

  test('formatConfigError prefixes ConfigError messages', () => {
    expect(formatConfigError(new ConfigError('bad'))).toBe('Invalid config: bad')
  })
})

describe('resolveConfig - more branches', () => {
  test('invalid BACKEND framework throws ConfigError', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'django' } } })).toThrow(ConfigError)
  })

  test('absolute bsvDir with leading slash throws ConfigError', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, bsvDir: '/etc' })).toThrow(ConfigError)
  })

  test('absolute bsvDir with drive letter throws ConfigError', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, bsvDir: 'C:\\windows' })).toThrow(ConfigError)
  })

  test('non-array capabilities throws', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, capabilities: 'wallet-login' })).toThrow(/capabilities must be an array/i)
  })

  test('mode add is accepted without a stack', () => {
    const c = resolveConfig({ mode: 'add', name: 'x' })
    expect(c.mode).toBe('add')
  })

  test('formatConfigError returns message for plain Error', () => {
    expect(formatConfigError(new Error('boom'))).toBe('boom')
  })

  test('formatConfigError returns string for non-Error', () => {
    expect(formatConfigError('plain')).toBe('plain')
  })
})
