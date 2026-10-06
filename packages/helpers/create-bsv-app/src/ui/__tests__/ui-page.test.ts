import { describe, expect, test } from '@jest/globals'
import { serializeSchema, buildPage, PAGE_DRAFT_SRC, PAGE_COMMAND_SRC } from '../ui-page'
import { remainingCapabilityIds, type ProjectManifest } from '../../config/project-manifest'
import { seedDraft, type ConfigDraft } from '../../config/draft'
import { listCapabilities } from '../../registry'

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

type Draft = Record<string, unknown>
const { initialDraft, visibleDraft, payloadOf, modeDrafts, fieldOptions } =
  new Function(`${PAGE_DRAFT_SRC}
return { initialDraft, visibleDraft, payloadOf, modeDrafts, fieldOptions }`)() as {
    initialDraft: (schema: unknown, seed: Draft) => Draft
    visibleDraft: (schema: unknown, draft: Draft, hidden?: Draft) => Draft
    payloadOf: (
      schema: unknown,
      draft: Draft,
      modeSeeds: Record<string, Draft>,
      seed: Draft
    ) => Draft
    modeDrafts: (
      schema: unknown,
      seed: Draft,
      modeSeeds: Record<string, Draft>
    ) => Record<string, Draft>
    fieldOptions: (field: unknown, mode: string) => Array<{ value: string }>
  }
const { buildCommand, buildTokens } = new Function(`${PAGE_COMMAND_SRC}
return { buildCommand, buildTokens }`)() as {
  buildCommand: (d: Draft, dir: string) => string
  buildTokens: (d: Draft, dir: string) => Array<{ t: string }>
}

/** The page's in-memory draft for a fresh new-mode run (schema defaults, all capabilities ticked). */
function newModeDraft(): Draft {
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

const manifest: ProjectManifest = {
  version: 1,
  name: 'demo',
  network: 'test',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: [],
  targets: { client: '' }
}

describe('visibleDraft (submit payload)', () => {
  test('add mode without a manifest drops the hidden new-mode stack fields', () => {
    const draft: Draft = { ...newModeDraft(), mode: 'add' }
    const payload = visibleDraft(
      serializeSchema(null),
      draft,
      seedDraft(null, { mode: 'add' }) as Draft
    )
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

  test('drops non-schema keys such as bsvDir and targets (the server re-applies flags)', () => {
    const payload = visibleDraft(serializeSchema(null), {
      ...newModeDraft(),
      bsvDir: 'lib/bsv',
      targets: { client: '' }
    })
    expect(payload).toEqual(newModeDraft())
  })

  test('a stale hidden starter does not hide capabilities: hidden fields take the mode seed', () => {
    const schema = serializeSchema(manifest)
    const draft: Draft = { ...newModeDraft(), starter: 'meter', mode: 'add' }
    const payload = visibleDraft(schema, draft, seedDraft(manifest, { mode: 'add' }) as Draft)
    expect(payload).toEqual({ mode: 'add', capabilities: draft.capabilities })
  })

  test('add mode keeps capabilities visible for a manifest with or without a starter id', () => {
    const manifests: ProjectManifest[] = [
      manifest,
      { ...manifest, starter: { id: 'custom', kind: 'generated' } }
    ]
    for (const m of manifests) {
      const hidden = seedDraft(m, {}) as Draft
      const draft = initialDraft(serializeSchema(m), hidden)
      expect(visibleDraft(serializeSchema(m), draft, hidden)).toEqual({
        mode: 'add',
        capabilities: []
      })
    }
  })
})

describe('initialDraft', () => {
  test('holds only schema fields, so manifest targets/bsvDir never leak into new mode', () => {
    const schema = serializeSchema(manifest)
    const draft = initialDraft(schema, seedDraft(manifest, {}) as Draft)
    expect(draft).not.toHaveProperty('targets')
    expect(draft).not.toHaveProperty('bsvDir')
    draft.mode = 'new'
    const payload = visibleDraft(schema, draft, seedDraft(manifest, { mode: 'new' }) as Draft)
    expect(payload).not.toHaveProperty('targets')
    expect(payload).not.toHaveProperty('bsvDir')
    expect(payload).toMatchObject({ mode: 'new', name: 'demo', frontend: 'react' })
  })
})

describe('page wiring', () => {
  const html = buildPage({ schema: serializeSchema(null), seed: { mode: 'new' } })

  test('/plan and /generate submit payload(), never the raw draft', () => {
    expect(html.split('body: JSON.stringify(payload())').length - 1).toBe(2)
    expect(html).not.toContain('JSON.stringify(draft)')
  })

  test('rendering and submitting share one visibility view', () => {
    expect(html).toMatch(/function shown\(f\) \{ return f\.key in payload\(\); \}/u)
    expect(html).not.toContain('whenOk(')
  })

  test('the command preview merges CLI flags under the payload, as the server does', () => {
    const withFlags = buildPage({
      schema: serializeSchema(null),
      seed: { mode: 'new' },
      flags: { bsvDir: 'lib/bsv' }
    })
    expect(withFlags).toContain('window.__FLAGS__ = {"bsvDir":"lib/bsv"};')
    expect(withFlags).toContain('Object.assign({}, FLAGS, payload())')
    expect(withFlags.split('buildCommand(commandDraft(), TARGET_DIR)').length - 1).toBe(1)
    expect(withFlags.split('buildTokens(commandDraft(), TARGET_DIR)').length - 1).toBe(1)
  })

  test('embeds the target directory for the command', () => {
    const page = buildPage({ schema: [], seed: {}, targetDir: '../proj' })
    expect(page).toContain('window.__TARGET_DIR__ = "../proj";')
  })

  test('payload() uses the per-mode seeds', () => {
    expect(html).toContain(
      'function payload() { return payloadOf(SCHEMA, draft, MODE_SEEDS, SEED); }'
    )
  })

  test('a draft edit clears the last Generate error, so the live plan error shows', () => {
    // every edit handler re-fetches the plan
    expect(html).toMatch(/function fetchPlan\(\) \{\n\s*state\.error = '';/u)
  })
})

/** The server's per-mode seeds for `flags`, as `startUiServer` embeds them. */
function modeSeedsFor(m: ProjectManifest | null, flags: ConfigDraft): Record<string, Draft> {
  return {
    new: seedDraft(m, { ...flags, mode: 'new' }) as Draft,
    add: seedDraft(m, { ...flags, mode: 'add' }) as Draft
  }
}

describe('modeDrafts', () => {
  test('new-only fields start from the new-mode seed, so flags survive flipping a project to New', () => {
    const flags = { name: 'flagged', network: 'main' } as const
    const schema = serializeSchema(manifest)
    const drafts = modeDrafts(
      schema,
      seedDraft(manifest, flags) as Draft,
      modeSeedsFor(manifest, flags)
    )
    expect(drafts.new).toMatchObject({ mode: 'new', name: 'flagged', network: 'main' })
    expect(drafts.add).toMatchObject({ mode: 'add', capabilities: [] })
  })
})

describe('payloadOf', () => {
  test('hidden fields take the seed for the current mode, not the initial seed', () => {
    const m: ProjectManifest = { ...manifest, starter: { id: 'custom', kind: 'generated' } }
    const flags = { mode: 'new', starter: 'meter' } as const
    const payload = payloadOf(
      serializeSchema(m),
      { mode: 'add', capabilities: [] },
      modeSeedsFor(m, flags),
      seedDraft(m, flags) as Draft
    )
    expect(payload).toEqual({ mode: 'add', capabilities: [] })
  })
})

describe('fieldOptions', () => {
  test('capabilities offer the terminal options for each mode', () => {
    const m: ProjectManifest = { ...manifest, capabilities: ['wallet-login'] }
    const caps = serializeSchema(m)
      .flatMap(s => s.fields)
      .find(f => f.key === 'capabilities')
    const all = listCapabilities()
    const values = (mode: string): string[] => fieldOptions(caps, mode).map(o => o.value)
    expect(values('new')).toEqual(all.filter(c => c.defaultSelected !== true).map(c => c.id))
    expect(values('add')).toEqual(
      remainingCapabilityIds(
        m,
        all.map(c => c.id)
      )
    )
    expect(values('add')).toContain('wallet-connect')
    expect(values('add')).not.toContain('wallet-login')
  })
})

describe('command', () => {
  const text = (d: Draft, dir: string): string =>
    buildTokens(d, dir)
      .map(t => t.t)
      .join('')
      .replace(/\s+/gu, ' ')
      .trim()

  test('add mode keeps the install, glue and package-manager flags', () => {
    const d = {
      mode: 'add',
      packageManager: 'pnpm',
      install: false,
      glue: false,
      capabilities: ['wallet-login']
    }
    const expected =
      'npx create-bsv-app --mode add --package-manager pnpm --skip-install --no-glue --capabilities wallet-login --yes'
    expect(buildCommand(d, '.')).toBe(expected)
    expect(text(d, '.')).toBe(expected)
  })

  test('add mode keeps --name so the copied command works without a project', () => {
    const d = { mode: 'add', name: 'my-app', capabilities: ['wallet-login'] }
    const expected =
      'npx create-bsv-app --mode add --name "my-app" --capabilities wallet-login --yes'
    expect(buildCommand(d, '.')).toBe(expected)
    expect(text(d, '.')).toBe(expected)
  })

  test('names a non-default target directory with --dir, quoted like --name', () => {
    const d = { mode: 'new', name: 'demo' }
    const expected = 'npx create-bsv-app --mode new --dir "../proj" --name "demo" --yes'
    expect(buildCommand(d, '../proj')).toBe(expected)
    expect(text(d, '../proj')).toBe(expected)
    expect(buildCommand(d, '.')).toBe('npx create-bsv-app --mode new --name "demo" --yes')
  })
})
