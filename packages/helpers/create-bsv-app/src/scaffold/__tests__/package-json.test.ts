import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { mergePackageJsonDeps, applyCapabilityDeps, rangeFloor } from '../package-json'
import { formatDependencyChanges } from '../../pipeline'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cba-pkg-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writePkg = (d: string, pkg: unknown): void =>
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg), 'utf8')
const readPkg = (d: string): any => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))

test('adds missing deps, preserves a higher floor, never touches devDeps', () => {
  writePkg(dir, {
    name: 'x',
    dependencies: { react: '^19.0.0' },
    devDependencies: { typescript: '^6.0.0' }
  })
  const changes = mergePackageJsonDeps(dir, {
    '@bsv/auth': '^0.1.0',
    react: '>=18',
    typescript: '^9.9.9'
  })
  const pkg = readPkg(dir)
  expect(pkg.dependencies['@bsv/auth']).toBe('^0.1.0') // added
  expect(pkg.dependencies.react).toBe('^19.0.0') // preserved (not downgraded)
  expect(pkg.dependencies.typescript).toBeUndefined() // not added to dependencies
  expect(pkg.devDependencies.typescript).toBe('^6.0.0') // never changed
  expect(changes).toEqual([
    { name: 'typescript', from: '^6.0.0', to: '^9.9.9', action: 'left', reason: 'devDependency' }
  ])
})

test('raises a lower floor in dependencies', () => {
  writePkg(dir, { dependencies: { '@bsv/sdk': '^2.4.1' } })
  const changes = mergePackageJsonDeps(dir, { '@bsv/sdk': '^4.0.1' })
  expect(readPkg(dir).dependencies['@bsv/sdk']).toBe('^4.0.1')
  expect(changes).toEqual([{ name: '@bsv/sdk', from: '^2.4.1', to: '^4.0.1', action: 'raised' }])
})

test('keeps an equal or higher floor silently', () => {
  writePkg(dir, { dependencies: { react: '^19.0.0', a: '^1.2.3' } })
  const changes = mergePackageJsonDeps(dir, { react: '>=18', a: '^1.2.3' })
  expect(readPkg(dir).dependencies.react).toBe('^19.0.0')
  expect(changes).toEqual([])
})

test('leaves and reports an unparseable range', () => {
  writePkg(dir, { dependencies: { '@bsv/sdk': 'workspace:*' } })
  const changes = mergePackageJsonDeps(dir, { '@bsv/sdk': '^4.0.1' })
  expect(readPkg(dir).dependencies['@bsv/sdk']).toBe('workspace:*')
  expect(changes).toEqual([
    { name: '@bsv/sdk', from: 'workspace:*', to: '^4.0.1', action: 'left', reason: 'unparseable' }
  ])
})

test('throws a clear error when the capability range is unparseable', () => {
  writePkg(dir, { dependencies: { '@bsv/sdk': '^4.0.1' } })
  expect(() => mergePackageJsonDeps(dir, { '@bsv/sdk': 'latest' })).toThrow(
    'capability range for @bsv/sdk is not a plain version floor: latest'
  )
})

test('reports an unparseable devDependency as left/devDependency', () => {
  writePkg(dir, { devDependencies: { '@bsv/sdk': 'latest' } })
  expect(mergePackageJsonDeps(dir, { '@bsv/sdk': '^4.0.1' })).toEqual([
    { name: '@bsv/sdk', from: 'latest', to: '^4.0.1', action: 'left', reason: 'devDependency' }
  ])
})

test('a devDependency at or above the required floor is not reported', () => {
  writePkg(dir, { devDependencies: { '@bsv/sdk': '^5.0.0' } })
  expect(mergePackageJsonDeps(dir, { '@bsv/sdk': '^4.0.1' })).toEqual([])
})

test('creates a minimal package.json when none exists', () => {
  expect(mergePackageJsonDeps(dir, { '@bsv/auth': '^0.1.0' })).toEqual([])
  expect(existsSync(join(dir, 'package.json'))).toBe(true)
  expect(readPkg(dir).dependencies['@bsv/auth']).toBe('^0.1.0')
})

test('empty deps is a no-op (no file created)', () => {
  mergePackageJsonDeps(dir, {})
  expect(existsSync(join(dir, 'package.json'))).toBe(false)
})

describe('rangeFloor', () => {
  test.each([
    ['^4.0.1', [4, 0, 1]],
    ['~0.1.8', [0, 1, 8]],
    ['>=2.4.1', [2, 4, 1]],
    ['4.0.1', [4, 0, 1]],
    ['>=18', [18, 0, 0]],
    ['^0.7', [0, 7, 0]],
    ['*', undefined],
    ['latest', undefined],
    ['workspace:^', undefined],
    ['npm:@bsv/sdk@4.0.1', undefined],
    ['file:../sdk', undefined],
    ['^2 || ^3', undefined],
    ['', undefined]
  ])('%s', (range, expected) => {
    expect(rangeFloor(range)).toEqual(expected)
  })
})

test('property: merged floor is never below either input floor', () => {
  const version = fc
    .tuple(fc.constantFrom('^', '~', '>=', ''), fc.nat(30), fc.nat(30), fc.nat(30))
    .map(([prefix, a, b, c]) => `${prefix}${a}.${b}.${c}`)
  const cmp = (x: number[], y: number[]): number => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  fc.assert(
    fc.property(version, version, (a, b) => {
      writePkg(dir, { dependencies: { p: a } })
      mergePackageJsonDeps(dir, { p: b })
      const merged = rangeFloor(readPkg(dir).dependencies.p)!
      expect(cmp(merged, rangeFloor(a)!)).toBeGreaterThanOrEqual(0)
      expect(cmp(merged, rangeFloor(b)!)).toBeGreaterThanOrEqual(0)
    })
  )
})

test('formatDependencyChanges names target, package and ranges', () => {
  const lines = formatDependencyChanges([
    { target: 'client', name: '@bsv/sdk', from: '^2.4.1', to: '^4.0.1', action: 'raised' },
    {
      target: 'server',
      name: '@bsv/sdk',
      from: 'workspace:*',
      to: '^4.0.1',
      action: 'left',
      reason: 'unparseable'
    }
  ])
  expect(lines[0]).toBe('client: @bsv/sdk ^2.4.1 → ^4.0.1')
  expect(lines[1]).toContain('server')
  expect(lines[1]).toContain('@bsv/sdk')
  expect(lines[1]).toContain('workspace:*')
  expect(lines[1]).toContain('^4.0.1')
})

test('formatDependencyChanges text for each left reason', () => {
  const left = {
    target: 'client',
    name: '@bsv/sdk',
    from: '^2.0.0',
    to: '^4.0.1',
    action: 'left'
  } as const
  expect(
    formatDependencyChanges([
      { ...left, reason: 'devDependency' },
      { ...left, reason: 'unparseable' }
    ])
  ).toEqual([
    'client: @bsv/sdk is "^2.0.0" — needs ^4.0.1, it is a devDependency, move it to dependencies manually',
    'client: @bsv/sdk is "^2.0.0" — needs ^4.0.1, check it manually'
  ])
})

describe('applyCapabilityDeps integration', () => {
  test('merges deps into root, client, and server dirs', () => {
    const clientDir = join(dir, 'client')
    const serverDir = join(dir, 'server')
    // pre-create client package.json with react already present
    mkdirSync(clientDir, { recursive: true })
    writePkg(clientDir, { dependencies: { react: '^19.0.0' } })
    applyCapabilityDeps(
      dir,
      { client: 'client', server: 'server' },
      {
        root: {},
        client: { '@bsv/sdk': '^1.0.0', react: '>=18' },
        server: { '@bsv/auth': '^0.1.0' }
      }
    )
    // root: empty → no file created
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    // client: @bsv/sdk added, react preserved
    const clientPkg = readPkg(clientDir)
    expect(clientPkg.dependencies['@bsv/sdk']).toBe('^1.0.0')
    expect(clientPkg.dependencies.react).toBe('^19.0.0')
    // server: @bsv/auth added (package.json created)
    expect(existsSync(join(serverDir, 'package.json'))).toBe(true)
    expect(readPkg(serverDir).dependencies['@bsv/auth']).toBe('^0.1.0')
  })

  test('tags each change with its target', () => {
    mkdirSync(join(dir, 'client'), { recursive: true })
    mkdirSync(join(dir, 'server'), { recursive: true })
    writePkg(join(dir, 'client'), { dependencies: { s: '^1.0.0' } })
    writePkg(join(dir, 'server'), { dependencies: { s: '^1.0.0' } })
    const changes = applyCapabilityDeps(
      dir,
      { client: 'client', server: 'server' },
      { root: {}, client: { s: '^2.0.0' }, server: { s: '^3.0.0' } }
    )
    expect(changes).toEqual([
      { target: 'client', name: 's', from: '^1.0.0', to: '^2.0.0', action: 'raised' },
      { target: 'server', name: 's', from: '^1.0.0', to: '^3.0.0', action: 'raised' }
    ])
  })
})
