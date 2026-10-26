import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  aggregateBundleSizes,
  bundleComposition,
  bundleSizes,
  parseBrowserArguments,
  prohibitedModuleIds,
  prohibitedRuntimeSpecifiers,
  validateBrowserBudget,
  validateBundleBudget,
  validateBudgetFile
} from './check-browser-package.mjs'

test('browser selector preserves default CLI and independently selects an optional budget', () => {
  assert.deepEqual(parseBrowserArguments(['.']), {
    packageDirectory: '.',
    budgetFile: 'browser-budget.json',
    measureOnly: false
  })
  assert.deepEqual(
    parseBrowserArguments(['.', '--budget', 'browser-brc52-budget.json', '--measure']),
    {
      packageDirectory: '.',
      budgetFile: 'browser-brc52-budget.json',
      measureOnly: true
    }
  )
  for (const arguments_ of [
    [],
    ['--measure'],
    ['.', 'extra'],
    ['.', '--budget'],
    ['.', '--measure', '--measure'],
    ['.', '--budget', 'a', '--budget', 'b']
  ]) {
    assert.throws(() => parseBrowserArguments(arguments_))
  }
})

test('browser budget selector requires registered package-local files without fallback', () => {
  const directory = fileURLToPath(new URL('../packages/helpers/did', import.meta.url))
  const policy = {
    packages: [
      { path: 'packages/helpers/did', budget: 'packages/helpers/did/browser-brc52-budget.json' }
    ]
  }
  assert.equal(validateBudgetFile(directory, 'browser-budget.json', policy), 'browser-budget.json')
  assert.equal(
    validateBudgetFile(directory, 'browser-brc52-budget.json', policy),
    'browser-brc52-budget.json'
  )
  for (const filename of [
    '../browser-brc52-budget.json',
    '/tmp/browser-brc52-budget.json',
    'sub/browser-brc52-budget.json',
    'browser-missing.json',
    '',
    undefined
  ]) {
    assert.throws(() => validateBudgetFile(directory, filename, policy))
  }
  assert.throws(() =>
    validateBudgetFile(path.join(directory, 'other'), 'browser-brc52-budget.json', policy)
  )
})

test('multi-file payload sizes sum each independently transferred representation', () => {
  const payloads = [Buffer.from('alpha alpha alpha'), Buffer.from('alpha alpha alpha')]
  const individual = bundleSizes(payloads[0])
  assert.deepEqual(aggregateBundleSizes(payloads), {
    raw: individual.raw * 2,
    gzip: individual.gzip * 2,
    brotli: individual.brotli * 2
  })
})

test('browser bundle composition rejects Node and server dependencies', () => {
  assert.deepEqual(
    prohibitedModuleIds([
      '/repo/node_modules/@bsv/sdk/mod.js',
      '/repo/node_modules/express/index.js',
      'node:crypto'
    ]),
    ['/repo/node_modules/express/index.js', 'node:crypto']
  )
  assert.deepEqual(
    prohibitedRuntimeSpecifiers(
      'import value from "node:fs"; const other = require("path"); import("./safe.js")'
    ),
    ['node:fs', 'path']
  )
})

test('browser composition reports stable chunk, module, and package evidence', () => {
  assert.deepEqual(
    bundleComposition(
      [
        '/consumer/node_modules/@bsv/sdk/mod.js',
        '/consumer/node_modules/.pnpm/uuid@11/node_modules/uuid/index.js',
        '/consumer/entry.mjs'
      ],
      ['/tmp/consumer.mjs', '/tmp/chunk.js', '/tmp/consumer.mjs.map']
    ),
    {
      chunks: 2,
      modules: 3,
      packages: ['@bsv/sdk', 'uuid']
    }
  )
})

test('browser bundle budgets validate every compression dimension', () => {
  const actual = bundleSizes(Buffer.from('browser-contract'.repeat(100)))
  validateBundleBudget(actual, actual, 'exact')
  assert.throws(
    () => validateBundleBudget(actual, { ...actual, gzip: actual.gzip - 1 }, 'small'),
    /exceeds budget/
  )
  assert.doesNotThrow(() =>
    validateBundleBudget(actual, { ...actual, gzip: actual.gzip - 1 }, 'measurement', false)
  )
})

test('browser budget metadata is bound to the package and contract', () => {
  const manifest = { name: '@bsv/example' }
  const budget = {
    schemaVersion: 1,
    profile: 'browser',
    package: '@bsv/example',
    entry: './browser',
    requiredExports: ['Example'],
    prohibitedExports: ['ServerOnly'],
    maximumBytes: {
      vite: { raw: 1, gzip: 1, brotli: 1 },
      esbuild: { raw: 1, gzip: 1, brotli: 1 }
    },
    umd: {
      path: 'dist/example.js',
      additionalPaths: ['dist/example.wasm'],
      global: 'example',
      maximumBytes: { raw: 1, gzip: 1, brotli: 1 }
    }
  }
  assert.doesNotThrow(() => validateBrowserBudget(budget, manifest))
  assert.throws(
    () => validateBrowserBudget({ ...budget, package: '@bsv/other' }, manifest),
    /does not match/
  )
  assert.throws(
    () =>
      validateBrowserBudget(
        {
          ...budget,
          umd: { ...budget.umd, additionalPaths: ['dist/example.js'] }
        },
        manifest
      ),
    /paths must be unique/
  )
})
