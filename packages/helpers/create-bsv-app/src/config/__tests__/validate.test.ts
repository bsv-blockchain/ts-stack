// src/config/__tests__/validate.test.ts
import { describe, expect, test } from '@jest/globals'
import { resolveConfig, ConfigError, formatConfigError } from '../validate'
import { registry } from '../../registry'
import type { Capability } from '../../types'

const minimal = { name: 'demo', stack: { frontend: { framework: 'react' } } }

describe('resolveConfig', () => {
  test('rejects non-object configuration input', () => {
    expect(() => resolveConfig(null)).toThrow(/config must be an object/i)
  })

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
      capabilities: ['wallet-connect', 'tx-core'],
      pulled: [],
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

  test('dedupes capabilities and accepts known ones (new mode floor adds wallet-connect and tx-core)', () => {
    const c = resolveConfig({
      name: 'x',
      stack: { backend: { framework: 'express' } },
      capabilities: ['wallet-login', 'wallet-login']
    })
    // new-mode floor adds wallet-connect and tx-core; wallet-login is deduped; the list is in registry order
    expect(c.capabilities).toEqual(['wallet-connect', 'wallet-login', 'tx-core'])
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

  test('rejects unsafe target paths', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        stack: { frontend: { framework: 'react' } },
        targets: { client: '../escape' }
      })
    ).toThrow(/targets.client must be a safe relative path/i)
  })

  test('repository starters reject generated capability selection', () => {
    expect(() =>
      resolveConfig({
        name: 'x',
        starter: 'brc102-frontend',
        capabilities: ['wallet-login']
      })
    ).toThrow(/does not accept generated capabilities/i)
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

  test('preserves TerraTestNet as an explicit network', () => {
    const c = resolveConfig({
      name: 'x',
      stack: { backend: { framework: 'express' } },
      network: 'ttn'
    })
    expect(c.network).toBe('ttn')
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
    // no floor (tx-core) in add mode; wallet-login's requirement still comes along
    expect(c.capabilities).toEqual(['wallet-connect', 'wallet-login'])
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

describe('resolveConfig requires closure', () => {
  const frontend = { frontend: { framework: 'react' } }

  test('add mode adds what a requested capability requires and reports it as pulled', () => {
    const c = resolveConfig({ mode: 'add', name: 'x', stack: frontend, capabilities: ['tx-core'] })
    expect(c.capabilities).toEqual(['wallet-connect', 'tx-core'])
    expect(c.pulled).toEqual([{ id: 'wallet-connect', requiredBy: ['tx-core'] }])
  })

  test('new mode closes the list too; the floor is requested, not pulled', () => {
    const c = resolveConfig({ name: 'x', stack: frontend, capabilities: ['signed-requests'] })
    expect(c.capabilities).toEqual(['wallet-connect', 'signed-requests', 'tx-core'])
    expect(c.pulled).toEqual([])
  })

  test('requesting an installed or already-closed set pulls nothing and changes nothing', () => {
    const input = {
      mode: 'add',
      name: 'x',
      stack: frontend,
      capabilities: ['tx-core', 'wallet-connect']
    }
    const c = resolveConfig(input)
    expect(c.capabilities).toEqual(['wallet-connect', 'tx-core'])
    expect(c.pulled).toEqual([])
    expect(resolveConfig({ ...input, capabilities: c.capabilities }).capabilities).toEqual(
      c.capabilities
    )
  })
})

describe('resolveConfig layout fit', () => {
  const stacks = {
    'frontend-only': { frontend: { framework: 'react' } },
    'backend-only': { backend: { framework: 'express' } },
    monorepo: { frontend: { framework: 'react' }, backend: { framework: 'express' } }
  }

  test.each(Object.entries(stacks))(
    'every registry capability can be placed in a %s project, in both modes',
    (_layout, stack) => {
      for (const capability of registry) {
        for (const mode of ['new', 'add']) {
          const c = resolveConfig({ mode, name: 'x', stack, capabilities: [capability.id] })
          expect(c.capabilities).toContain(capability.id)
        }
      }
    }
  )

  test('rejects capabilities in a project with no frontend or backend, saying how to fix it', () => {
    const none = new ConfigError(
      'add mode found no frontend or backend in this directory; pass --frontend react or --backend express, or set a stack in the --file config'
    )
    for (const capabilities of [['wallet-connect'], ['wallet-login']])
      expect(() => resolveConfig({ mode: 'add', name: 'x', capabilities })).toThrow(none)
    // nothing to place, nothing to reject
    expect(resolveConfig({ mode: 'add', name: 'x' }).capabilities).toEqual([])
  })

  test('rejects a client-only capability in a backend-only project', () => {
    const clientOnly: Capability = {
      id: 'client-only',
      title: 'Client only',
      description: 'fake',
      roles: ['client'],
      files: () => ({ client: [{ path: 'c.ts', content: 'c' }] }),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    }
    registry.push(clientOnly)
    try {
      expect(() =>
        resolveConfig({
          mode: 'add',
          name: 'x',
          stack: stacks['backend-only'],
          capabilities: ['client-only']
        })
      ).toThrow(
        new ConfigError(
          "capability client-only cannot be placed in this project's layout (backend-only)"
        )
      )
      expect(
        resolveConfig({
          mode: 'add',
          name: 'x',
          stack: stacks.monorepo,
          capabilities: ['client-only']
        }).capabilities
      ).toEqual(['client-only'])
    } finally {
      registry.pop()
    }
  })

  test('names a requested misfit before a pulled one, and says what pulled it', () => {
    const fake = (id: string, roles: Capability['roles'], requires?: string[]): Capability => ({
      id,
      title: id,
      description: 'fake',
      roles,
      ...(requires === undefined ? {} : { requires }),
      files: () => ({}),
      npmDependencies: () => ({}),
      agentsSection: () => ''
    })
    // registry order: client-only, needs-client, client-only-b
    registry.push(
      fake('client-only', ['client']),
      fake('needs-client', ['server'], ['client-only']),
      fake('client-only-b', ['client'])
    )
    const backendOnly = (capabilities: string[]) => () =>
      resolveConfig({ mode: 'add', name: 'x', stack: stacks['backend-only'], capabilities })
    try {
      expect(backendOnly(['needs-client'])).toThrow(
        new ConfigError(
          "capability client-only (required by needs-client) cannot be placed in this project's layout (backend-only)"
        )
      )
      expect(backendOnly(['needs-client', 'client-only-b'])).toThrow(
        new ConfigError(
          "capability client-only-b cannot be placed in this project's layout (backend-only)"
        )
      )
    } finally {
      registry.splice(-3, 3)
    }
  })
})
