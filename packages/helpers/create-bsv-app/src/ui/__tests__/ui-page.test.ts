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
})

describe('buildPage', () => {
  test('inlines the schema + seed and renders shell markers', () => {
    const schema = serializeSchema(null)
    const html = buildPage({ schema, seed: { mode: 'new' } })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('window.__SCHEMA__')
    expect(html).toContain('window.__SEED__')
    expect(html).toContain(JSON.stringify(schema))
    expect(html).toContain('create-bsv-app')
    expect(html).toContain('id="generate"')
    expect(html).toContain('id="command"')
  })

  test('embeds capability labels and is self-contained (no external src/href)', () => {
    const html = buildPage({ schema: serializeSchema(null), seed: { mode: 'new' } })
    expect(html).toContain('wallet-login')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })

  test('renders "Always included" banner when included list is provided', () => {
    const schema = serializeSchema(null)
    const html = buildPage({ schema, seed: { mode: 'new' }, included: [{ label: 'Wallet connect' }] })
    expect(html).toContain('Always included')
    expect(html).toContain('Wallet connect')
    expect(html).toContain('class="included"')
  })

  test('no banner when included is empty or omitted', () => {
    const schema = serializeSchema(null)
    const htmlNoArg = buildPage({ schema, seed: { mode: 'new' } })
    const htmlEmpty = buildPage({ schema, seed: { mode: 'new' }, included: [] })
    expect(htmlNoArg).not.toContain('class="included"')
    expect(htmlEmpty).not.toContain('class="included"')
  })
})
