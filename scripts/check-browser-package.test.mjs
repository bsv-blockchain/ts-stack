import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bundleSizes,
  prohibitedModuleIds,
  prohibitedRuntimeSpecifiers,
  validateBrowserBudget,
  validateBundleBudget
} from './check-browser-package.mjs'

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

test('browser bundle budgets validate every compression dimension', () => {
  const actual = bundleSizes(Buffer.from('browser-contract'.repeat(100)))
  validateBundleBudget(actual, actual, 'exact')
  assert.throws(
    () => validateBundleBudget(actual, { ...actual, gzip: actual.gzip - 1 }, 'small'),
    /exceeds budget/
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
    }
  }
  assert.doesNotThrow(() => validateBrowserBudget(budget, manifest))
  assert.throws(
    () => validateBrowserBudget({ ...budget, package: '@bsv/other' }, manifest),
    /does not match/
  )
})
