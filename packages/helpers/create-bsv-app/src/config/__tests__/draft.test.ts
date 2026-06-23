// src/config/__tests__/draft.test.ts
import { describe, expect, test } from '@jest/globals'
import { draftToConfigInput, resolveDraft, seedDraft } from '../draft'
import type { ProjectManifest } from '../project-manifest'

describe('draftToConfigInput', () => {
  test('maps react frontend + express backend to a nested stack', () => {
    const input = draftToConfigInput({ mode: 'new', name: 'demo', frontend: 'react', frontendVariant: 'react-ts', backend: 'express', capabilities: ['wallet-login'] }) as any
    expect(input.stack).toEqual({ frontend: { framework: 'react', variant: 'react-ts' }, backend: { framework: 'express' } })
  })
  test("omits 'none' targets", () => {
    const input = draftToConfigInput({ mode: 'new', name: 'demo', frontend: 'none', backend: 'express' }) as any
    expect(input.stack).toEqual({ backend: { framework: 'express' } })
  })
})

describe('resolveDraft', () => {
  test('produces a validated ProjectConfig with resolveConfig defaults', () => {
    const c = resolveDraft({ mode: 'new', name: 'demo', frontend: 'react' })
    expect(c.stack.frontend).toEqual({ framework: 'react', variant: 'react-ts' })
    expect(c.bsvDir).toBe('src/bsv')
    expect(c.packageManager).toBe('npm')
  })

  test('a new project with no targets is rejected by resolveConfig', () => {
    expect(() => resolveDraft({ mode: 'new', name: 'demo', frontend: 'none', backend: 'none' })).toThrow(/frontend or a backend/i)
  })
})

describe('seedDraft', () => {
  test('no manifest, no mode flag → new', () => {
    expect(seedDraft(null, {}).mode).toBe('new')
  })
  test('existing manifest, no mode flag → add, locked from manifest', () => {
    const m: ProjectManifest = { version: 1, name: 'demo', network: 'test', stack: { backend: { framework: 'express' } }, bsvDir: 'src/bsv', capabilities: ['wallet-login'] }
    const d = seedDraft(m, {})
    expect(d.mode).toBe('add')
    expect(d.backend).toBe('express')
    expect(d.frontend).toBe('none')
    expect(d.name).toBe('demo')
    expect(d.capabilities).toEqual(['wallet-login'])
  })
  test('mode flag overrides the manifest default', () => {
    const m: ProjectManifest = { version: 1, name: 'x', network: 'test', stack: {}, bsvDir: 'src/bsv', capabilities: [] }
    expect(seedDraft(m, { mode: 'new' }).mode).toBe('new')
  })
})
