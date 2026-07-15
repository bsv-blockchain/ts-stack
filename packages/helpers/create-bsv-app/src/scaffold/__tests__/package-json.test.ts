import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergePackageJsonDeps, applyCapabilityDeps } from '../package-json'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-pkg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('adds missing deps, preserves existing version, leaves devDeps alone', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { react: '^19.0.0' }, devDependencies: { typescript: '^6.0.0' } }), 'utf8')
  mergePackageJsonDeps(dir, { '@bsv/auth': '^0.1.0', react: '>=18', typescript: '^9.9.9' })
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  expect(pkg.dependencies['@bsv/auth']).toBe('^0.1.0') // added
  expect(pkg.dependencies.react).toBe('^19.0.0') // preserved (not downgraded)
  expect(pkg.dependencies.typescript).toBeUndefined() // already a devDep
})

test('creates a minimal package.json when none exists', () => {
  mergePackageJsonDeps(dir, { '@bsv/auth': '^0.1.0' })
  expect(existsSync(join(dir, 'package.json'))).toBe(true)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  expect(pkg.dependencies['@bsv/auth']).toBe('^0.1.0')
})

test('empty deps is a no-op (no file created)', () => {
  mergePackageJsonDeps(dir, {})
  expect(existsSync(join(dir, 'package.json'))).toBe(false)
})

describe('applyCapabilityDeps integration', () => {
  test('merges deps into root, client, and server dirs', () => {
    const clientDir = join(dir, 'client')
    const serverDir = join(dir, 'server')
    // pre-create client package.json with react already present
    mkdirSync(clientDir, { recursive: true })
    writeFileSync(join(clientDir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }), 'utf8')
    applyCapabilityDeps(dir, { client: 'client', server: 'server' }, {
      root: {},
      client: { '@bsv/sdk': '^1.0.0', react: '>=18' },
      server: { '@bsv/auth': '^0.1.0' }
    })
    // root: empty → no file created
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    // client: @bsv/sdk added, react preserved
    const clientPkg = JSON.parse(readFileSync(join(clientDir, 'package.json'), 'utf8'))
    expect(clientPkg.dependencies['@bsv/sdk']).toBe('^1.0.0')
    expect(clientPkg.dependencies.react).toBe('^19.0.0')
    // server: @bsv/auth added (package.json created)
    expect(existsSync(join(serverDir, 'package.json'))).toBe(true)
    const serverPkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'))
    expect(serverPkg.dependencies['@bsv/auth']).toBe('^0.1.0')
  })
})
