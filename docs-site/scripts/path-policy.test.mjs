import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  SITE_BASE,
  assetPathForBuiltUrl,
  isExternalUrl,
  resolveInsideRoot,
  routeOutput,
  splitUrl
} from './path-policy.mjs'

test('external URL classification preserves supported non-local schemes', () => {
  for (const value of [
    'https://example.com',
    'http://example.com',
    'data:image/png;base64,AA==',
    'mailto:security@example.com',
    '#section',
    '//cdn.example.com/app.js'
  ]) {
    assert.equal(isExternalUrl(value), true, value)
  }
  assert.equal(isExternalUrl(`${SITE_BASE}guide/`), false)
})

test('URL suffixes are separated without changing their content', () => {
  assert.deepEqual(splitUrl('/ts-stack/guide/?tab=api#usage'), {
    pathname: '/ts-stack/guide/',
    suffix: '?tab=api#usage'
  })
  assert.deepEqual(splitUrl('/ts-stack/guide/'), {
    pathname: '/ts-stack/guide/',
    suffix: ''
  })
})

test('built asset paths accept the owned base and reject unrelated routes', () => {
  assert.equal(assetPathForBuiltUrl('/ts-stack/assets/images/logo.svg'), 'assets/images/logo.svg')
  assert.equal(assetPathForBuiltUrl('/assets/images/logo.svg'), 'assets/images/logo.svg')
  assert.equal(assetPathForBuiltUrl('/other/assets/images/logo.svg'), null)
})

test('resolved assets cannot escape the build root', () => {
  const root = resolve('/tmp', 'ts-stack-docs-dist')
  assert.equal(resolveInsideRoot(root, 'assets/logo.svg'), resolve(root, 'assets/logo.svg'))
  assert.equal(resolveInsideRoot(root, '../secret'), null)
  assert.equal(resolveInsideRoot(root, '%2e%2e/secret'), null)
  assert.equal(resolveInsideRoot(root, '%E0%A4%A'), null)
})

test('static route outputs remain inside the build root', () => {
  const root = resolve('/tmp', 'ts-stack-docs-dist')
  assert.equal(routeOutput(root, '/'), resolve(root, 'index.html'))
  assert.equal(routeOutput(root, '/packages/sdk/'), resolve(root, 'packages/sdk/index.html'))
  assert.throws(() => routeOutput(root, '/../secret'), /Unsafe static route path/)
  assert.throws(() => routeOutput(root, '/guide?q=unsafe'), /Unsafe static route path/)
})
