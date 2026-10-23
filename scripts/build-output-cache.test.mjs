import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildableNames,
  cacheFileName,
  dependencyClosure,
  packageKeys,
  packageOutputs,
  parseArguments
} from './build-output-cache.mjs'

const projects = [
  { name: '@bsv/base', path: 'packages/base', sourceRoots: [], dependencies: [] },
  { name: '@bsv/middle', path: 'packages/middle', sourceRoots: [], dependencies: ['@bsv/base'] },
  { name: '@bsv/top', path: 'packages/top', sourceRoots: [], dependencies: ['@bsv/middle', 'x'] },
  { name: '@bsv/other', path: 'packages/other', sourceRoots: [], dependencies: [] }
]
const names = projects.map(project => project.name)
const listing =
  (changes = {}) =>
  paths =>
    paths.map(entry => `${entry} ${changes[entry] ?? 'v1'}`).join('\n')

test('a package key covers its own files and every workspace package it depends on', () => {
  assert.deepEqual(dependencyClosure(projects, '@bsv/top'), [
    '@bsv/base',
    '@bsv/middle',
    '@bsv/top'
  ])
  const before = packageKeys(projects, names, listing())
  const edited = packageKeys(projects, names, listing({ 'packages/middle': 'v2' }))
  // The edited package and its dependents rebuild; its dependencies and unrelated packages do not.
  assert.notEqual(edited.get('@bsv/middle'), before.get('@bsv/middle'))
  assert.notEqual(edited.get('@bsv/top'), before.get('@bsv/top'))
  assert.equal(edited.get('@bsv/base'), before.get('@bsv/base'))
  assert.equal(edited.get('@bsv/other'), before.get('@bsv/other'))
  // Root toolchain inputs invalidate every package.
  const toolchain = packageKeys(projects, names, listing({ 'pnpm-lock.yaml': 'v2' }))
  for (const name of names) assert.notEqual(toolchain.get(name), before.get(name))
  // Shared compiler configuration that package tsconfigs extend invalidates every package.
  const compiler = packageKeys(projects, names, listing({ 'config/typescript': 'v2' }))
  for (const name of names) assert.notEqual(compiler.get(name), before.get(name))
  assert.deepEqual(packageKeys(projects, names, listing()), before)
  assert.throws(() => packageKeys(projects, ['@bsv/missing'], listing()), /Unknown/)
})

test('package outputs exclude node_modules and nested packages', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'build-output-cache-'))
  try {
    for (const directory of [
      'packages/wallet/dist/cjs',
      'packages/wallet/src/out',
      'packages/wallet/node_modules/dep/dist',
      'packages/wallet/mobile/dist'
    ])
      mkdirSync(path.join(root, directory), { recursive: true })
    writeFileSync(path.join(root, 'packages/wallet/tsconfig.tsbuildinfo'), '{}')
    writeFileSync(path.join(root, 'packages/wallet/mobile/tsconfig.tsbuildinfo'), '{}')
    const nested = [
      { name: '@bsv/wallet', path: 'packages/wallet', sourceRoots: [], dependencies: [] },
      {
        name: '@bsv/wallet-mobile',
        path: 'packages/wallet/mobile',
        sourceRoots: [],
        dependencies: []
      }
    ]
    assert.deepEqual(packageOutputs(nested, '@bsv/wallet', root), [
      'packages/wallet/dist',
      'packages/wallet/src/out',
      'packages/wallet/tsconfig.tsbuildinfo'
    ])
    assert.deepEqual(packageOutputs(nested, '@bsv/wallet-mobile', root), [
      'packages/wallet/mobile/dist',
      'packages/wallet/mobile/tsconfig.tsbuildinfo'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cache entries are named per package and the command line is strict', () => {
  assert.equal(cacheFileName('@bsv/sdk', 'abc'), '_bsv_sdk--abc.tar.gz')
  assert.deepEqual(parseArguments(['restore', '--names-json', '[]', '--cache-directory', 'c']), {
    command: 'restore',
    'names-json': '[]',
    'cache-directory': 'c'
  })
  assert.deepEqual(parseArguments(['names']), { command: 'names' })
  assert.deepEqual(
    buildableNames([...projects, { name: 'docs-site' }, { name: 'example-paymail' }]),
    ['@bsv/base', '@bsv/middle', '@bsv/other', '@bsv/top']
  )
  assert.throws(() => parseArguments(['prune']), /names, restore or save/)
  assert.throws(() => parseArguments(['save', '--names-json', '[]']), /--cache-directory/)
})
