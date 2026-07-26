import assert from 'node:assert/strict'
import test from 'node:test'

import { validatePackedFiles } from './check-package-artifact.mjs'

const manifest = {
  name: '@bsv/example',
  version: '1.2.3'
}

test('packed artifact policy accepts a minimal compiled package', () => {
  assert.deepEqual(
    validatePackedFiles(
      {
        name: manifest.name,
        version: manifest.version,
        files: [
          { path: 'LICENSE.txt' },
          { path: 'README.md' },
          { path: 'dist/index.js' },
          { path: 'dist/index.d.ts' },
          { path: 'package.json' }
        ]
      },
      manifest
    ),
    []
  )
})

test('packed artifact policy rejects source, tests, caches, locks, and identity drift', () => {
  const errors = validatePackedFiles(
    {
      name: '@bsv/wrong',
      version: '9.9.9',
      files: [
        { path: 'LICENSE.txt' },
        { path: 'LICENSE.txt' },
        { path: 'src/index.ts' },
        { path: 'dist/index.test.js' },
        { path: 'dist/tsconfig.tsbuildinfo' },
        { path: 'package-lock.json' },
        { path: 'package.json' }
      ]
    },
    manifest
  )

  assert.ok(errors.some(error => error.includes('exactly one root LICENSE.txt')))
  assert.ok(errors.some(error => error.includes('root README')))
  assert.ok(errors.some(error => error.includes('uncompiled TypeScript')))
  assert.ok(errors.some(error => error.includes('test artifact')))
  assert.ok(errors.some(error => error.includes('compiler cache')))
  assert.ok(errors.some(error => error.includes('package-manager lockfile')))
  assert.ok(errors.some(error => error.includes('tarball name')))
  assert.ok(errors.some(error => error.includes('tarball version')))
})
