// src/__tests__/config-prompt.test.ts
import { describe, expect, test } from '@jest/globals'
import { runPrompts } from '../prompts'
import type { Ask } from '../prompts'
import type { FieldOption } from '../config/schema'
import type { ProjectManifest } from '../config/project-manifest'

describe('runPrompts', () => {
  test('new mode: asks the full set, builds a ProjectConfig', async () => {
    const capabilityOptions: FieldOption[] = []
    const ask: Ask = async (field, options) => {
      if (field.key === 'capabilities') capabilityOptions.push(...options)
      const scripted: Record<string, unknown> = {
        mode: 'new',
        name: 'demo',
        frontend: 'react',
        frontendVariant: 'react-ts',
        backend: 'none',
        bsvDir: 'src/bsv',
        capabilities: ['wallet-login'],
        glue: false,
        packageManager: 'npm',
        network: 'test'
      }
      return scripted[field.key]
    }
    const c = await runPrompts({ existing: null, flags: {} }, ask)
    expect(c.mode).toBe('new')
    expect(c.stack.frontend?.framework).toBe('react')
    // wallet-connect is defaultSelected → excluded from new-mode picker options
    expect(capabilityOptions.map(o => o.value)).not.toContain('wallet-connect')
    expect(capabilityOptions.map(o => o.value)).not.toContain('tx-core')
    // wallet-login IS offered as a picker option in new mode
    expect(capabilityOptions.map(o => o.value)).toContain('wallet-login')
    // wallet-connect is still in the final config (pre-seeded by seedDraft + floored by resolveConfig)
    expect(c.capabilities).toEqual(
      expect.arrayContaining(['wallet-connect', 'tx-core', 'wallet-login'])
    )
    expect(c.capabilities).toHaveLength(3)
  })

  test('asks one field at a time, so dependent fields see earlier answers', async () => {
    const asked: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    await runPrompts(
      { existing: null, flags: { name: 'demo' } },
      async (field, _options, initial) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        asked.push(field.key)
        await new Promise(resolve => setTimeout(resolve, 0))
        inFlight--
        return field.key === 'frontend' ? 'react' : initial
      }
    )
    expect(maxInFlight).toBe(1)
    expect(asked.indexOf('frontendVariant')).toBeGreaterThan(asked.indexOf('frontend'))
  })

  test('new mode: initial values select the full project', async () => {
    const initials: Record<string, unknown> = {}
    let offered: string[] = []
    await runPrompts(
      { existing: null, flags: { name: 'demo' } },
      async (field, options, initial) => {
        initials[field.key] = initial
        if (field.key === 'capabilities') offered = options.map(o => o.value)
        return initial
      }
    )
    expect(initials.frontend).toBe('react')
    expect(initials.backend).toBe('express')
    expect(offered.length).toBeGreaterThan(0)
    expect(initials.capabilities).toEqual(offered)
  })

  test('add mode: locks fields from the manifest, only asks capabilities, unions', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-login']
    }
    const askedKeys: string[] = []
    const ask: Ask = async field => {
      askedKeys.push(field.key)
      return field.key === 'capabilities' ? [] : undefined
    }
    const c = await runPrompts({ existing, flags: {} }, ask)
    expect(askedKeys).not.toContain('frontend') // locked / hidden in add mode
    expect(c.mode).toBe('add')
    expect(c.stack.frontend?.framework).toBe('react')
    // the manifest predates the closure: wallet-login's requirement is added
    expect(c.capabilities).toEqual(['wallet-connect', 'wallet-login'])
  })

  test('flags prefill skips asking that field', async () => {
    const askedKeys: string[] = []
    const ask: Ask = async field => {
      askedKeys.push(field.key)
      return field.key === 'name'
        ? 'fromPrompt'
        : field.key === 'frontend'
          ? 'react'
          : field.key === 'capabilities'
            ? ['wallet-login']
            : undefined
    }
    const c = await runPrompts({ existing: null, flags: { mode: 'new', name: 'fromFlag' } }, ask)
    expect(askedKeys).not.toContain('mode') // set by flag
    expect(askedKeys).not.toContain('name') // set by flag
    expect(c.name).toBe('fromFlag')
  })

  test('add mode without a manifest offers every capability', async () => {
    let offeredCapabilityCount = 0
    let initialCapabilities: unknown
    const c = await runPrompts(
      // the frontend flag gives the untracked project a layout the capabilities fit
      { existing: null, flags: { mode: 'add', name: 'untracked-project', frontend: 'react' } },
      async (field, options, initial) => {
        if (field.key === 'capabilities') {
          offeredCapabilityCount = options.length
          initialCapabilities = initial
          return []
        }
        return undefined
      }
    )

    expect(offeredCapabilityCount).toBeGreaterThan(0)
    expect(initialCapabilities).toEqual([]) // never pre-tick onto an existing project
    expect(c.mode).toBe('add')
    expect(c.name).toBe('untracked-project')
  })

  test('add mode: says which required capabilities it also adds, after the multiselect', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: []
    }
    const events: string[] = []
    const ask: Ask = async field => {
      events.push(`ask:${field.key}`)
      return field.key === 'capabilities' ? ['tx-core'] : undefined
    }
    const c = await runPrompts({ existing, flags: {} }, ask, line => events.push(line))
    expect(events).toEqual([
      'ask:capabilities',
      'Also adding wallet-connect (required by tx-core).'
    ])
    expect(c.capabilities).toEqual(['wallet-connect', 'tx-core'])
    expect(c.pulled).toEqual([{ id: 'wallet-connect', requiredBy: ['tx-core'] }])
  })

  test('add mode: an installed requirement is not announced again', async () => {
    const existing: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-connect']
    }
    const lines: string[] = []
    const c = await runPrompts(
      { existing, flags: {} },
      async field => (field.key === 'capabilities' ? ['tx-core'] : undefined),
      line => lines.push(line)
    )
    expect(lines).toEqual([])
    expect(c.pulled).toEqual([])
  })

  test('capability options carry their requires from the schema, and the hint says so', async () => {
    let offered: FieldOption[] = []
    await runPrompts(
      { existing: null, flags: { mode: 'add', name: 'x', frontend: 'react' } },
      async (field, options) => {
        if (field.key === 'capabilities') offered = options
        return field.key === 'capabilities' ? [] : undefined
      }
    )
    const txCore = offered.find(o => o.value === 'tx-core')
    expect(txCore?.requires).toEqual([{ id: 'wallet-connect', role: 'client' }])
    // a role-scoped requirement names its role, so the hint holds in every layout
    expect(txCore?.hint).toMatch(/ Requires wallet-connect \(client\)\.$/)
    const walletLogin = offered.find(o => o.value === 'wallet-login')
    expect(walletLogin?.hint).toMatch(/ Requires wallet-connect\.$/)
    // the derived hint replaces the descriptions' own "Builds on wallet-connect."
    for (const option of offered) expect(option.hint).not.toMatch(/Builds on/)
    const walletConnect = offered.find(o => o.value === 'wallet-connect')
    expect(walletConnect?.requires).toBeUndefined()
    expect(walletConnect?.hint).not.toMatch(/Requires/)
  })

  test('a run that fails to resolve prints no pulled notice', async () => {
    const lines: string[] = []
    // a manifest with no stack and no capabilities: tx-core would pull wallet-connect, but
    // neither has anywhere to go, so resolution fails after the multiselect
    const existing: ProjectManifest = {
      version: 2,
      name: 'x',
      network: 'test',
      stack: {},
      bsvDir: 'src/bsv',
      capabilities: []
    }
    await expect(
      runPrompts(
        { existing, flags: {} },
        async field => (field.key === 'capabilities' ? ['tx-core'] : undefined),
        line => lines.push(line)
      )
    ).rejects.toThrow(/no frontend or backend/)
    expect(lines).toEqual([])
  })
})
