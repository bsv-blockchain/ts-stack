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
      starter: 'custom',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      targets: { client: '' },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-connect'],
      glue: true,
      install: true,
      packageManager: 'npm',
      network: 'test'
    })
  })

  test('throws when name missing', () => {
    expect(() => resolveConfig({ stack: { backend: { framework: 'express' } } })).toThrow(
      ConfigError
    )
  })

  test('throws when new project has no targets', () => {
    expect(() => resolveConfig({ name: 'x' })).toThrow(/frontend or a backend/i)
  })

  test('throws on an invalid frontend framework', () => {
    expect(() =>
      resolveConfig({ name: 'x', stack: { frontend: { framework: 'svelte' } } })
    ).toThrow(ConfigError)
  })

  test('throws on an unknown capability', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        stack: { backend: { framework: 'express' } },
        capabilities: ['nope']
      })
    ).toThrow(/unknown capability: nope/i)
  })

  test('dedupes capabilities and accepts known ones (new mode floor adds wallet-connect)', () => {
    const c = resolveConfig({
      name: 'x',
      stack: { backend: { framework: 'express' } },
      capabilities: ['wallet-login', 'wallet-login']
    })
    // new-mode floor appends wallet-connect after dedup; wallet-login itself is deduped to one entry
    expect(c.capabilities).toEqual(['wallet-login', 'wallet-connect'])
  })

  test('rejects an unsafe bsvDir', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        stack: { backend: { framework: 'express' } },
        bsvDir: '../escape'
      })
    ).toThrow(ConfigError)
  })

  test('normalizes packageManager and network with defaults', () => {
    const c = resolveConfig({
      name: 'x',
      stack: { backend: { framework: 'express' } },
      packageManager: 'maven',
      network: 'main'
    })
    expect(c.packageManager).toBe('npm')
    expect(c.network).toBe('main')
  })

  test('formatConfigError prefixes ConfigError messages', () => {
    expect(formatConfigError(new ConfigError('bad'))).toBe('Invalid config: bad')
  })
})

describe('resolveConfig - more branches', () => {
  test('invalid BACKEND framework throws ConfigError', () => {
    expect(() => resolveConfig({ name: 'x', stack: { backend: { framework: 'django' } } })).toThrow(
      ConfigError
    )
  })

  test('absolute bsvDir with leading slash throws ConfigError', () => {
    expect(() =>
      resolveConfig({ name: 'x', stack: { backend: { framework: 'express' } }, bsvDir: '/etc' })
    ).toThrow(ConfigError)
  })

  test('absolute bsvDir with drive letter throws ConfigError', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        stack: { backend: { framework: 'express' } },
        bsvDir: 'C:\\windows'
      })
    ).toThrow(ConfigError)
  })

  test('non-array capabilities throws', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        stack: { backend: { framework: 'express' } },
        capabilities: 'wallet-login'
      })
    ).toThrow(/capabilities must be an array/i)
  })

  test('mode add is accepted without a stack', () => {
    const c = resolveConfig({ mode: 'add', name: 'x' })
    expect(c.mode).toBe('add')
  })

  test("overrideMode wins over the config's own mode field", () => {
    // file says add, caller forces add→new: floor applies, so wallet-connect is added
    const c = resolveConfig(
      {
        mode: 'add',
        name: 'x',
        stack: { frontend: { framework: 'react', variant: 'react-ts' } },
        capabilities: []
      },
      { overrideMode: 'new' }
    )
    expect(c.mode).toBe('new')
    expect(c.capabilities).toContain('wallet-connect') // new-mode floor ran for the effective mode
  })

  test('overrideMode new still enforces new-mode validation (needs a target)', () => {
    expect(() => resolveConfig({ mode: 'add', name: 'x' }, { overrideMode: 'new' })).toThrow(
      /frontend or a backend/i
    )
  })

  test('overrideMode add skips the floor even when the file said new', () => {
    const c = resolveConfig(
      {
        mode: 'new',
        name: 'x',
        stack: { backend: { framework: 'express' } },
        capabilities: ['wallet-login']
      },
      { overrideMode: 'add' }
    )
    expect(c.mode).toBe('add')
    expect(c.capabilities).toEqual(['wallet-login']) // no floor in add mode
  })

  test('formatConfigError returns message for plain Error', () => {
    expect(formatConfigError(new Error('boom'))).toBe('boom')
  })

  test('formatConfigError returns string for non-Error', () => {
    expect(formatConfigError('plain')).toBe('plain')
  })
})

const base = {
  mode: 'new',
  name: 'demo',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } }
}

describe('resolveConfig glue default', () => {
  test('glue defaults to true when unspecified', () => {
    expect(resolveConfig({ ...base }).glue).toBe(true)
  })
  test('glue is false only when explicitly false', () => {
    expect(resolveConfig({ ...base, glue: false }).glue).toBe(false)
  })
  test('glue true stays true', () => {
    expect(resolveConfig({ ...base, glue: true }).glue).toBe(true)
  })
})

describe('resolveConfig new-mode capability floor', () => {
  test('new mode with no capabilities still includes the defaultSelected baseline', () => {
    const c = resolveConfig({
      mode: 'new',
      name: 'demo',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } }
    })
    expect(c.capabilities).toContain('wallet-connect')
  })
  test('new mode with explicitly empty capabilities still gets the baseline', () => {
    const c = resolveConfig({
      mode: 'new',
      name: 'demo',
      stack: { backend: { framework: 'express' } },
      capabilities: []
    })
    expect(c.capabilities).toContain('wallet-connect')
  })
  test('add mode does NOT apply the floor (no auto-add)', () => {
    const c = resolveConfig({
      mode: 'add',
      name: 'demo',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: []
    })
    expect(c.capabilities).toEqual([])
  })
  test('new mode does not duplicate an already-listed baseline', () => {
    const c = resolveConfig({
      mode: 'new',
      name: 'demo',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      capabilities: ['wallet-connect']
    })
    expect(c.capabilities.filter(id => id === 'wallet-connect')).toHaveLength(1)
  })
})
