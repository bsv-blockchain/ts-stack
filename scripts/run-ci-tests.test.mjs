import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArguments, selectCiPackageNames } from './run-ci-tests.mjs'

const projects = [
  { name: '@bsv/ts-stack', scripts: { test: 'node --test' } },
  {
    name: '@bsv/example-covered',
    scripts: { test: 'vitest run', 'test:coverage': 'vitest run --coverage' }
  },
  { name: '@bsv/example-standard', scripts: { test: 'node test.mjs' } },
  {
    name: '@bsv/example-browser',
    scripts: {
      test: 'vitest run',
      'test:browser': 'pnpm build && node browser.mjs',
      'test:coverage': 'vitest run --coverage'
    }
  },
  {
    name: '@bsv/sdk',
    scripts: {
      test: 'jest',
      'test:browser': 'pnpm build && node browser.mjs',
      'test:coverage': 'jest --coverage'
    }
  },
  {
    name: '@bsv/did',
    scripts: {
      test: 'jest',
      'test:browser': 'pnpm build && node browser.mjs',
      'test:coverage': 'jest --coverage'
    }
  },
  { name: 'docs-site', scripts: { test: 'vitest run' } }
]

test('CI package selection partitions standard and coverage suites without duplication', () => {
  assert.deepEqual(selectCiPackageNames(projects, 'test'), [
    '@bsv/did',
    '@bsv/example-browser',
    '@bsv/example-covered',
    '@bsv/example-standard',
    '@bsv/sdk'
  ])
  assert.deepEqual(selectCiPackageNames(projects, 'standard'), ['@bsv/example-standard'])
  assert.deepEqual(selectCiPackageNames(projects, 'coverage-other'), [
    '@bsv/example-browser',
    '@bsv/example-covered'
  ])
})

test('CI browser selection includes browser contracts except dedicated platform suites', () => {
  assert.deepEqual(selectCiPackageNames(projects, 'browser'), ['@bsv/did', '@bsv/example-browser'])
})

test('CI artifact selection keeps every package that defines pack:check', () => {
  const packed = [
    { name: '@bsv/ts-stack', scripts: { 'pack:check': 'node check.mjs' } },
    { name: '@bsv/sdk', scripts: { 'pack:check': 'pnpm build && node check.mjs' } },
    { name: '@bsv/example-standard', scripts: { test: 'node test.mjs' } },
    { name: '@bsv/example-covered', scripts: { 'pack:check': 'node check.mjs' } }
  ]
  // Dedicated test suites still publish artifacts, so they are not excluded here.
  assert.deepEqual(selectCiPackageNames(packed, 'pack'), ['@bsv/example-covered', '@bsv/sdk'])
})

test('CI test selector validates its command-line contract', () => {
  assert.deepEqual(parseArguments(['--projects-json', 'projects.json', '--mode', 'browser']), {
    projectsJson: 'projects.json',
    mode: 'browser'
  })
  assert.throws(() => parseArguments([]), /--projects-json is required/)
  assert.throws(
    () => parseArguments(['--projects-json', 'projects.json', '--mode', 'unknown']),
    /--mode must be/
  )
})
