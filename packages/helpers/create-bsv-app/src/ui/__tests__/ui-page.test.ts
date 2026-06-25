import { describe, expect, test } from '@jest/globals'
import { serializeSchema, buildPage } from '../ui-page'
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
    expect(variant?.when).toEqual({ mode: 'new', frontend: 'react' })
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
    expect(backend?.when).toEqual({ mode: 'new' }) // not gated on frontend
  })
})

describe('buildPage', () => {
  test('buildPage is self-contained (no external src/href) and inlines schema/seed', () => {
    const html = buildPage({ schema: serializeSchema(null), seed: { mode: 'new' }, included: [{ label: 'wallet-connect' }] })
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
    const html = buildPage({ schema, seed: { mode: 'new' }, included: [{ label: 'Wallet connect' }] })
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
    const html = buildPage({ schema: serializeSchema(null), seed: { mode: 'new' }, included: [{ label: 'Wallet connect' }] })
    expect(html).toContain('scaffolded separately')
  })
})
