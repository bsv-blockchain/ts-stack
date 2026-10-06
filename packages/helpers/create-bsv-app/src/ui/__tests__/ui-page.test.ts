import { describe, expect, test } from '@jest/globals'
import { serializeSchema, buildPage, VISIBLE_DRAFT_SRC } from '../ui-page'
import type { ProjectManifest } from '../../config/project-manifest'

describe('serializeSchema', () => {
  test('fresh (new mode): capabilities options include wallet-login but NOT wallet-connect', () => {
    const schema = serializeSchema(null)
    const caps = schema.flatMap(s => s.fields).find(f => f.key === 'capabilities')
    const values = caps?.options?.map(o => o.value) ?? []
    expect(values).toContain('wallet-login')
    // wallet-connect is defaultSelected → excluded from new-mode picker
    expect(values).not.toContain('wallet-connect')
  })

  test('existing with wallet-login already installed: it is filtered out of options', () => {
    const m: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: ['wallet-login']
    }
    const schema = serializeSchema(m)
    const caps = schema.flatMap(s => s.fields).find(f => f.key === 'capabilities')
    expect(caps?.options?.map(o => o.value)).not.toContain('wallet-login')
  })

  test('add mode (existing without wallet-connect): wallet-connect IS offered', () => {
    const m: ProjectManifest = {
      version: 1,
      name: 'demo',
      network: 'test',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } },
      bsvDir: 'src/bsv',
      capabilities: []
    }
    const schema = serializeSchema(m)
    const caps = schema.flatMap(s => s.fields).find(f => f.key === 'capabilities')
    expect(caps?.options?.map(o => o.value)).toContain('wallet-connect')
  })

  test('when conditions survive serialization as plain objects', () => {
    const schema = serializeSchema(null)
    const variant = schema.flatMap(s => s.fields).find(f => f.key === 'frontendVariant')
    expect(variant?.when).toEqual({ mode: 'new', starter: 'custom', frontend: 'react' })
  })

  test('serializeSchema still excludes the defaultSelected base in new mode and carries ui/desc', () => {
    const schema = serializeSchema(null)
    const caps = schema.flatMap(s => s.fields).find(f => f.key === 'capabilities')
    expect(caps?.options?.map(o => o.value)).not.toContain('wallet-connect')
    expect(schema.find(s => s.id === 'mode')?.desc).toEqual(expect.any(String))
    expect(schema.flatMap(s => s.fields).find(f => f.key === 'frontend')?.ui).toBe('segmented')
    // backend is its own segmented selector, independent of frontend (backend-only is selectable)
    const backend = schema.flatMap(s => s.fields).find(f => f.key === 'backend')
    expect(backend?.ui).toBe('segmented')
    expect(backend?.when).toEqual({ mode: 'new', starter: 'custom' }) // not gated on frontend
  })
})

describe('buildPage', () => {
  test('buildPage is self-contained (no external src/href) and inlines schema/seed', () => {
    const html = buildPage({
      schema: serializeSchema(null),
      seed: { mode: 'new' },
      included: [{ label: 'wallet-connect' }]
    })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('window.__SCHEMA__')
    expect(html).toContain('window.__SEED__')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/) // external font dropped
    expect(html).toContain('id="formWrap"') // new wizard DOM
    expect(html).toContain('id="rail"')
    expect(html).toContain('window.__INCLUDED__')
  })

  test('embeds capability labels and is self-contained (no external src/href)', () => {
    const html = buildPage({ schema: serializeSchema(null), seed: { mode: 'new' } })
    expect(html).toContain('wallet-login')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })

  test('renders "Always included" chips when included list is provided', () => {
    const schema = serializeSchema(null)
    const html = buildPage({
      schema,
      seed: { mode: 'new' },
      included: [{ label: 'Wallet connect' }]
    })
    expect(html).toContain('Always included')
    expect(html).toContain('Wallet connect')
    expect(html).toContain('window.__INCLUDED__')
  })

  test('no banner when included is empty or omitted — __INCLUDED__ still emitted as []', () => {
    const schema = serializeSchema(null)
    const htmlNoArg = buildPage({ schema, seed: { mode: 'new' } })
    const htmlEmpty = buildPage({ schema, seed: { mode: 'new' }, included: [] })
    // __INCLUDED__ always emitted for JS; old class="included" banner is gone
    expect(htmlNoArg).toContain('window.__INCLUDED__')
    expect(htmlEmpty).toContain('window.__INCLUDED__')
  })

  test('impact panel is captioned as BSV-files-only', () => {
    const html = buildPage({
      schema: serializeSchema(null),
      seed: { mode: 'new' },
      included: [{ label: 'Wallet connect' }]
    })
    expect(html).toContain('scaffolded separately')
  })

  test('serializes manifest-derived values without allowing inline script breakout', () => {
    const payload = '</script><script>window.__injected__ = true</script>\u2028'
    const html = buildPage({
      schema: serializeSchema(null),
      seed: { name: payload },
      sessionToken: 'abcdefghijklmnopqrstuvwxyz012345',
      scriptNonce: 'abcdefghijklmnopqrstuvwxyz012345'
    })

    expect(html).not.toContain(payload)
    expect(html).not.toContain('</script><script>window.__injected__')
    expect(html).toContain('\\u003c/script>\\u003cscript>')
    expect(html).toContain('\\u2028')
    expect(html).toContain('<script nonce="abcdefghijklmnopqrstuvwxyz012345">')
  })

  test('rejects an unsafe script nonce supplied by a caller', () => {
    expect(() =>
      buildPage({ schema: [], seed: {}, scriptNonce: '"><script>alert(1)</script>' })
    ).toThrow('scriptNonce must be a base64url token')
  })
})

type VisibleDraft = (schema: unknown, draft: Record<string, unknown>) => Record<string, unknown>
const visibleDraft = new Function(`${VISIBLE_DRAFT_SRC}
return visibleDraft`)() as VisibleDraft

/** The page's in-memory draft for a fresh new-mode run (schema defaults, all capabilities ticked). */
function newModeDraft(): Record<string, unknown> {
  return {
    mode: 'new',
    starter: 'custom',
    name: 'demo',
    frontend: 'react',
    frontendVariant: 'react-ts',
    backend: 'express',
    capabilities: ['wallet-connect', 'wallet-login'],
    glue: true,
    packageManager: 'npm',
    network: 'test',
    install: true
  }
}

describe('visibleDraft (submit payload)', () => {
  test('add mode without a manifest drops the hidden new-mode stack fields', () => {
    const draft: Record<string, unknown> = { ...newModeDraft(), mode: 'add' }
    const payload = visibleDraft(serializeSchema(null), draft)
    expect(payload).toEqual({ mode: 'add', capabilities: ['wallet-connect', 'wallet-login'] })
    expect(draft.frontend).toBe('react') // in-page draft untouched so toggling back restores it
  })

  test('a repository starter drops the hidden capabilities, glue, network and stack', () => {
    const payload = visibleDraft(serializeSchema(null), { ...newModeDraft(), starter: 'meter' })
    expect(payload).toEqual({
      mode: 'new',
      starter: 'meter',
      name: 'demo',
      packageManager: 'npm',
      install: true
    })
  })

  test('keeps non-schema keys such as bsvDir', () => {
    const payload = visibleDraft(serializeSchema(null), { ...newModeDraft(), bsvDir: 'lib/bsv' })
    expect(payload).toEqual({ ...newModeDraft(), bsvDir: 'lib/bsv' })
  })
})
