// src/__tests__/agents-md-layout.test.ts
// AGENTS.md wiring, capability sections and dependencies follow the project layout.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderAgentsMd } from '../agents-md'
import { planPlacement, type TargetKey } from '../engine'
import { applyConfig } from '../pipeline'
import { resolveConfig } from '../config/validate'
import { registry, resolveCapabilities } from '../registry'
import type { Layout, ProjectConfig, Stack, TargetPaths } from '../config/model'
import type { Capability, Role } from '../types'

type Shape = Exclude<Layout, 'none'>
const REACT = { framework: 'react' as const, variant: 'react-ts' }
const EXPRESS = { framework: 'express' as const }
const SHAPES: Record<Shape, { stack: Stack; targets: TargetPaths }> = {
  'frontend-only': { stack: { frontend: REACT }, targets: { client: '' } },
  'backend-only': { stack: { backend: EXPRESS }, targets: { server: '' } },
  monorepo: {
    stack: { frontend: REACT, backend: EXPRESS },
    targets: { client: 'client', server: 'server' }
  }
}
const LAYOUTS = Object.keys(SHAPES) as Shape[]
const MODES: Array<{ label: string; mode: 'new' | 'add'; glue: boolean }> = [
  { label: 'new + glue', mode: 'new', glue: true },
  { label: 'new --no-glue', mode: 'new', glue: false },
  { label: 'add', mode: 'add', glue: false }
]
// Every capability on its own (with what it requires), plus all of them together.
const CAP_SETS: string[][] = [...registry.map(c => [c.id]), registry.map(c => c.id)]

function configFor(
  layout: Shape,
  mode: 'new' | 'add',
  glue: boolean,
  capabilities: string[],
  targets: TargetPaths = SHAPES[layout].targets
): ProjectConfig {
  return {
    mode,
    name: 'demo',
    dir: '.',
    starter: 'custom',
    stack: SHAPES[layout].stack,
    targets,
    bsvDir: 'src/bsv',
    capabilities,
    glue,
    install: false,
    packageManager: 'npm',
    network: 'test'
  }
}

const rel = (root: string | undefined, path: string): string =>
  root == null || root === '' ? path : `${root}/${path}`

// Every project-relative path that exists after the run: placed capability files plus the
// base files (the user's own main.tsx / App.tsx / index.ts in add mode, generated ones in new mode).
function existingPaths(config: ProjectConfig, caps: Capability[]): Set<string> {
  const placement = planPlacement(config, caps)
  const paths = new Set([...placement.utilFiles, ...placement.glueFiles].map(f => f.path))
  const { client, server } = config.targets
  const glued = config.mode === 'new' && config.glue
  if (client != null) {
    paths.add(rel(client, 'src/main.tsx'))
    paths.add(rel(client, 'src/App.tsx'))
    if (glued) paths.add(rel(client, `${config.bsvDir}/Home.tsx`))
  }
  if (server != null) {
    paths.add(rel(server, 'src/index.ts'))
    if (glued) paths.add(rel(server, `${config.bsvDir}/config.ts`))
  }
  return paths
}

const exists = (paths: Set<string>, mention: string): boolean =>
  [...paths].some(p => p === mention || p.endsWith('/' + mention))

// Source-file mentions in AGENTS.md naming a file that does not exist. A line that is explicitly
// about new glued projects is checked against what a new glued project of this layout writes.
function missingMentions(md: string, config: ProjectConfig, caps: Capability[]): string[] {
  const actual = existingPaths(config, caps)
  const glued = existingPaths({ ...config, mode: 'new', glue: true }, caps)
  const missing: string[] = []
  for (const line of md.split('\n')) {
    const scope = /new glued projects|new projects \(glue on\)/i.test(line) ? glued : actual
    for (const m of line.matchAll(/[\w./-]+\.(?:tsx|ts|css)\b/g)) {
      if (!exists(scope, m[0])) missing.push(`${m[0]}  <-  ${line.trim().slice(0, 80)}`)
    }
  }
  return [...new Set(missing)]
}

describe('AGENTS.md only mentions files the layout has', () => {
  for (const layout of LAYOUTS) {
    for (const { label, mode, glue } of MODES) {
      test.each(CAP_SETS.map(ids => [ids.join('+'), ids]))(
        `${layout}, ${label}: %s`,
        (_name, ids) => {
          const config = configFor(layout, mode, glue, ids as string[])
          const caps = resolveCapabilities(ids as string[], { layout })
          const md = renderAgentsMd(config, caps)
          expect(missingMentions(md, config, caps)).toEqual([])
          expect(md).not.toMatch(/\n{3,}/) // dropped layout lines leave no blank-line runs
        }
      )
    }
  }
})

const heading = (path: string): string => `### \`${path}\``

describe('manual wiring follows the layout', () => {
  const all = registry.map(c => c.id)
  const md = (layout: Shape, targets?: TargetPaths): string =>
    renderAgentsMd(
      configFor(layout, 'add', false, all, targets),
      resolveCapabilities(all, { layout })
    )

  test('backend-only: server wiring at src/index.ts, no React wiring', () => {
    const out = md('backend-only')
    expect(out).toContain(heading('src/index.ts'))
    expect(out).toContain('in src/index.ts')
    expect(out).not.toContain('server/src/index.ts')
    expect(out).not.toContain('main.tsx')
    expect(out).not.toContain('App.tsx')
    expect(out).not.toContain('<Route')
    expect(out).not.toContain('<WalletProviders>')
    expect(out).toContain('SERVER_PRIVATE_KEY')
  })

  test('frontend-only: React wiring, no server wiring or server env note', () => {
    const out = md('frontend-only')
    const wiring = out.slice(out.indexOf('## Wiring'), out.indexOf('## wallet-connect'))
    expect(out).toContain(heading('src/main.tsx'))
    expect(out).toContain(heading('src/App.tsx'))
    expect(out).not.toContain('index.ts')
    expect(wiring).not.toContain('WalletRelayService')
    expect(wiring).not.toContain("app.post('/api/login'")
    expect(out).not.toContain('> **`SERVER_PRIVATE_KEY`**')
  })

  test('monorepo: each base file under its own target', () => {
    const out = md('monorepo')
    expect(out).toContain(heading('client/src/main.tsx'))
    expect(out).toContain(heading('client/src/App.tsx'))
    expect(out).toContain(heading('server/src/index.ts'))
    expect(out).toContain('in server/src/index.ts')
    expect(out).toContain('in client/src/main.tsx')
  })

  test('monorepo with custom targets: paths use those targets', () => {
    const out = md('monorepo', { client: 'web', server: 'api' })
    expect(out).toContain(heading('web/src/main.tsx'))
    expect(out).toContain(heading('api/src/index.ts'))
    expect(out).not.toContain('server/src/index.ts')
    expect(out).toContain('cd web && npm i')
    expect(out).toContain('cd api && npm i')
  })

  test.each([
    ['backend-only', 'src/index.ts', ['main.tsx', 'App.tsx']],
    ['frontend-only', 'src/main.tsx', ['index.ts', 'server']]
  ] as const)('%s new + glue: names only its own base files', (layout, has, hasNot) => {
    const config = configFor(layout, 'new', true, all)
    const out = renderAgentsMd(config, resolveCapabilities(all, { layout }))
    const wiring = out.slice(out.indexOf('## Wiring'), out.indexOf('## wallet-connect'))
    expect(wiring).toContain('wired automatically')
    expect(wiring).toContain(has)
    for (const s of hasNot) expect(wiring).not.toContain(s)
  })
})

describe('install section lists the deps placed in each target', () => {
  test.each(LAYOUTS)('%s', layout => {
    const all = registry.map(c => c.id)
    const config = configFor(layout, 'add', false, all)
    const caps = resolveCapabilities(all, { layout })
    const out = renderAgentsMd(config, caps)
    const install = out.slice(out.indexOf('## Install dependencies'), out.indexOf('## Wiring'))
    const { deps } = planPlacement(config, caps)
    for (const key of ['client', 'server'] as const) {
      for (const [name, range] of Object.entries(deps[key])) {
        expect(install).toContain(`${name}@${range}`)
      }
    }
    expect(install).toContain('npm i')
  })
})

describe('dependencies follow role targets', () => {
  const ROLE_TARGETS: Record<Shape, Record<Role, TargetKey[]>> = {
    'frontend-only': { shared: ['client'], client: ['client'], server: [] },
    'backend-only': { shared: ['server'], client: [], server: ['server'] },
    monorepo: { shared: ['client', 'server'], client: ['client'], server: ['server'] }
  }
  test.each(LAYOUTS)('%s: each target gets only the deps of roles placed there', layout => {
    const all = registry.map(c => c.id)
    const caps = resolveCapabilities(all, { layout })
    const { deps } = planPlacement(configFor(layout, 'add', false, all), caps)
    for (const key of ['root', 'client', 'server'] as TargetKey[]) {
      const allowed = new Set<string>()
      for (const cap of caps) {
        const roleDeps = cap.npmDependencies({
          name: 'demo',
          network: 'test',
          bsvDir: 'src/bsv',
          stack: SHAPES[layout].stack,
          layout
        })
        for (const role of ['shared', 'client', 'server'] as Role[]) {
          if (ROLE_TARGETS[layout][role].includes(key))
            for (const name of Object.keys(roleDeps[role] ?? {})) allowed.add(name)
        }
      }
      expect(Object.keys(deps[key]).filter(n => !allowed.has(n))).toEqual([])
    }
  })
})

describe('regression: tx-core added to an existing backend-only Express project', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cba-layout-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('AGENTS.md and package.json carry no client wiring or client deps', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), '// express entry\n', 'utf8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'api', dependencies: { express: '^5.1.0' } }),
      'utf8'
    )
    // Only tx-core is requested; it needs wallet-connect only for its client page, so nothing is pulled.
    const config = resolveConfig({
      mode: 'add',
      name: 'api',
      stack: { backend: { framework: 'express' } },
      capabilities: ['tx-core'],
      glue: false,
      install: false
    })
    expect(config.pulled).toEqual([])
    expect(config.capabilities).toEqual(['tx-core'])
    applyConfig(config, dir, { runCommand: () => {}, force: false })

    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(md).not.toContain('TransactionsDemo')
    expect(md).not.toContain('main.tsx')
    expect(md).not.toContain('App.tsx')
    expect(md).not.toContain('<Route')
    expect(md).not.toContain('server/src/index.ts')
    // no relay, so no server wiring at all
    expect(md).not.toContain(heading('src/index.ts'))
    expect(md).not.toContain('WalletRelayService')
    expect(md).toContain('@bsv/wallet-helper@')

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const names = Object.keys(pkg.dependencies)
    for (const clientOnly of ['react', 'react-router-dom']) expect(names).not.toContain(clientOnly)
    expect(names).toEqual(expect.arrayContaining(['@bsv/sdk', '@bsv/wallet-helper']))
    for (const relay of ['@bsv/wallet-relay', 'qrcode', '@bsv/auth'])
      expect(names).not.toContain(relay)
  })
})

// Text of one `## <id>` capability section.
function sectionOf(md: string, id: string): string {
  const start = md.indexOf(`## ${id}`)
  const next = md.indexOf('\n## ', start + 1)
  return md.slice(start, next === -1 ? undefined : next)
}

describe('wallet-connect relay text follows the layout', () => {
  const caps = resolveCapabilities(['wallet-connect'], { layout: 'monorepo' })
  const render = (layout: Shape, mode: 'new' | 'add' = 'add'): string =>
    sectionOf(
      renderAgentsMd(configFor(layout, mode, mode === 'new', ['wallet-connect']), caps),
      'wallet-connect'
    )

  test('frontend-only: no base server entry; the relay path needs your backend at API_BASE_URL', () => {
    const section = render('frontend-only')
    expect(section).not.toContain('base server entry')
    expect(section).not.toContain('desktop connect only')
    const backendLine = section.split('\n').find(l => l.includes('needs your backend')) ?? ''
    for (const term of [
      'WalletRelayService',
      '@bsv/wallet-relay',
      'API_BASE_URL',
      'GET /api/session/:id',
      'POST /api/request/:id',
      'DELETE /api/session/:id',
      '/ws',
      'GET /api/session`'
    ])
      expect(backendLine).toContain(term)
    expect(section).not.toContain('The server publishes')
  })

  test.each(['backend-only', 'monorepo'] as const)(
    '%s: the base server entry runs the relay',
    layout => {
      const section = render(layout)
      expect(section).toContain('base server entry runs')
      expect(section).not.toContain('needs your backend')
      expect(section).not.toContain('desktop connect only')
    }
  )

  const CLIENT_TERMS = [
    'useWalletRelayClient',
    'the browser keeps using localhost',
    'import.meta.env.DEV',
    'getServerIdentity()'
  ]

  test('backend-only: only server-side text, nothing about the client', () => {
    const section = render('backend-only')
    for (const term of CLIENT_TERMS) expect(section).not.toContain(term)
    expect(section).toContain('The server publishes its own identity key at `GET /api/identity`')
    expect(section).toContain('the phone pairs over `/ws`')
    expect(section).toContain('SERVER_ORIGIN=http://<your LAN IP>:<your server port>')
  })

  test('monorepo: the client side of the relay is still described', () => {
    const section = render('monorepo')
    for (const term of CLIENT_TERMS) expect(section).toContain(term)
    expect(section).toContain('creates that session and shows its QR')
  })

  test("monorepo: the glue note names the client's main.tsx", () => {
    expect(render('monorepo', 'new')).toContain("the client's `src/main.tsx`")
  })
})

describe('wallet-login environment heading', () => {
  const caps = resolveCapabilities(['wallet-login'], { layout: 'monorepo' })
  const envBlock = (config: ProjectConfig): string => {
    const section = sectionOf(renderAgentsMd(config, caps), 'wallet-login')
    return section.slice(section.indexOf('### Environment'), section.indexOf('### Future'))
  }
  test.each(MODES)('monorepo $label: server env is not claimed to live in bsv/config.ts', m => {
    const block = envBlock(configFor('monorepo', m.mode, m.glue, ['wallet-login']))
    expect(block.split('\n')[0]).toBe('### Environment')
    const server = block.split('\n').find(l => l.startsWith('- Server')) ?? ''
    expect(server.startsWith('- Server environment')).toBe(true)
    expect(server).toContain('): `SERVER_PRIVATE_KEY`')
    expect(block).toContain('): `API_BASE_URL`')
  })
})

test('no capability puts React packages in its server role', () => {
  for (const layout of LAYOUTS) {
    for (const cap of registry) {
      const server = cap.npmDependencies({
        name: 'demo',
        network: 'test',
        bsvDir: 'src/bsv',
        stack: SHAPES[layout].stack,
        layout
      }).server
      for (const name of ['react', 'react-dom', 'react-router-dom'])
        expect(Object.keys(server ?? {})).not.toContain(name)
    }
  }
})

describe('targets omitted: single-target layouts live at the root', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cba-layout-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('backend-only add with no targets writes files, deps and AGENTS paths at the root', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api' }), 'utf8')
    const config = configFor('backend-only', 'add', false, ['wallet-connect', 'tx-core'], {})
    const res = applyConfig(config, dir, { runCommand: () => {}, force: false })
    expect(res.written).toContain('src/bsv/transactions.ts')
    expect(res.written.some(p => p.startsWith('server/'))).toBe(false)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies)).toContain('@bsv/wallet-helper')
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(md).toContain(heading('src/index.ts'))
    expect(md).not.toContain('server/')
  })

  test('a manifest-style add config without targets resolves to the root', () => {
    const config = resolveConfig({
      mode: 'add',
      name: 'api',
      stack: { backend: { framework: 'express' } },
      capabilities: ['tx-core']
    })
    expect(config.targets).toEqual({ server: '' })
  })

  test('monorepo new + glue with no targets reports base files under client/ and server/', () => {
    const config = configFor('monorepo', 'new', true, ['wallet-connect'], {})
    const res = applyConfig(config, dir, { runCommand: () => {} })
    expect(res.written).toContain('client/src/main.tsx')
    expect(res.written).toContain('server/src/index.ts')
    expect(res.written).not.toContain('src/main.tsx')
  })
})
