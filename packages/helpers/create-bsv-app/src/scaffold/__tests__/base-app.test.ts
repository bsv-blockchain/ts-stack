import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleBaseFile, assembleAndWrite, bsvImport, newBuilder, MAIN_TEMPLATE, APP_TEMPLATE } from '../base-app.js'

const CTX = { name: 'd', network: 'test' as const, bsvDir: 'src/bsv', stack: {}, layout: 'monorepo' as const }

describe('assembleBaseFile', () => {
  test('fills imports + wrap, removes empty markers', () => {
    const b = newBuilder()
    b.main.imports.push("import { WalletProviders } from './bsv/WalletProviders'")
    b.main.wraps.push({ open: '<WalletProviders>', close: '</WalletProviders>' })
    const out = assembleBaseFile(MAIN_TEMPLATE, b, CTX)
    expect(out).toContain("import { WalletProviders } from './bsv/WalletProviders'")
    expect(out).toContain('<WalletProviders>')
    expect(out).toContain('</WalletProviders>')
    expect(out).not.toContain('{{') // all markers consumed
  })
  test('empty builder removes all markers, leaving valid base', () => {
    const out = assembleBaseFile(MAIN_TEMPLATE, newBuilder(), CTX)
    expect(out).not.toContain('{{')
    expect(out).toContain('<App />')
  })
  test('wraps nest: opens in push order, closes reversed', () => {
    const b = newBuilder()
    b.main.wraps.push({ open: '<A>', close: '</A>' })
    b.main.wraps.push({ open: '<B>', close: '</B>' })
    const out = assembleBaseFile(MAIN_TEMPLATE, b, CTX)
    expect(out.indexOf('<A>')).toBeLessThan(out.indexOf('<B>')) // A outermost open
    expect(out.indexOf('</B>')).toBeLessThan(out.indexOf('</A>')) // B closes first
  })
  test('route descriptor renders named import and <Route> JSX', () => {
    const b = newBuilder()
    b.app.routes.push({ path: '/a', component: 'A', importPath: './bsv/A' })
    const out = assembleBaseFile(APP_TEMPLATE, b, CTX)
    expect(out).toContain("import { A } from './bsv/A'")
    expect(out).toContain('<Route path="/a" element={<A />} />')
  })
  test('default Home import resolves to ./bsv with the default bsvDir', () => {
    const out = assembleBaseFile(APP_TEMPLATE, newBuilder(), CTX)
    expect(out).toContain("import { Home } from './bsv/Home'")
  })
  test('non-default bsvDir rewrites the Home import path relative to src/', () => {
    const out = assembleBaseFile(APP_TEMPLATE, newBuilder(), { ...CTX, bsvDir: 'lib/bsv' })
    expect(out).toContain("import { Home } from '../lib/bsv/Home'")
    expect(out).not.toContain("'./bsv/Home'")
  })
})

describe('bsvImport', () => {
  test("src/-prefixed bsvDir → './' relative path", () => {
    expect(bsvImport(CTX, 'WalletProviders')).toBe('./bsv/WalletProviders')
    expect(bsvImport({ ...CTX, bsvDir: 'src/helpers' }, 'Home')).toBe('./helpers/Home')
  })
  test("non-src bsvDir → '../' relative path", () => {
    expect(bsvImport({ ...CTX, bsvDir: 'lib/bsv' }, 'loginRoute.js')).toBe('../lib/bsv/loginRoute.js')
  })
})

describe('assembleAndWrite', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-base-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const cap = (edit: (b: any) => void): any => ({ id: 'm', roles: [], files: () => ({}), npmDependencies: () => ({}), agentsSection: () => '', baseEdits: ({ builder }: any) => edit(builder) })
  const ctx = { name: 'd', network: 'test' as const, bsvDir: 'src/bsv', stack: {}, layout: 'monorepo' as const }

  test('writes main.tsx + App.tsx to clientDir and index.ts to serverDir', () => {
    const caps = [cap((b: any) => {
      b.main.wraps.push({ open: '<W>', close: '</W>' })
      b.app.routes.push({ path: '/x', component: 'X', importPath: './bsv/X' })
      b.server.routes.push('app.get("/y", h)')
    })]
    const r = assembleAndWrite(caps, ctx, { clientDir: join(dir, 'client'), serverDir: join(dir, 'server') })
    const appTsx = readFileSync(join(dir, 'client/src/App.tsx'), 'utf8')
    expect(appTsx).toContain('<Route path="/x" element={<X />} />') // generated from the descriptor
    expect(appTsx).toContain("import { X } from './bsv/X'") // import generated too
    expect(readFileSync(join(dir, 'server/src/index.ts'), 'utf8')).toContain('app.get("/y", h)')
    expect(r.client).toEqual(expect.arrayContaining(['src/main.tsx', 'src/App.tsx']))
    expect(r.server).toEqual(['src/index.ts'])
  })
})
