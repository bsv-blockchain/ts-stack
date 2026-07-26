import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  discoverPackageManifests,
  EXPECTED_LICENSE_SHA256,
  LICENSE_DECLARATION,
  LICENSE_FILE,
  LICENSE_VERSION,
  REPOSITORY_ROOT,
  synchronizePackageLicenses,
  validatePackageLicenses
} from './package-license-policy.mjs'

test('all package projects use the exact current Open BSV license', () => {
  assert.equal(LICENSE_VERSION, 6)
  assert.equal(
    EXPECTED_LICENSE_SHA256,
    'bac995a0c84dd533f7d5335b6d870aae9fee7d28d189b8aa78b103e0c9932bc0'
  )
  assert.equal(LICENSE_FILE, 'LICENSE.txt')
  assert.equal(LICENSE_DECLARATION, 'SEE LICENSE IN LICENSE.txt')
  assert.equal(discoverPackageManifests().length, 46)
  assert.deepEqual(validatePackageLicenses(), [])
})

test('license synchronization repairs manifest, lockfile, copy, and filename drift', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-license-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, LICENSE_FILE),
    path.join(fixture, LICENSE_FILE)
  )
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    `${JSON.stringify({ name: 'fixture-root', private: true, license: LICENSE_DECLARATION }, null, 2)}\n`
  )

  const child = path.join(fixture, 'package')
  fs.mkdirSync(child)
  fs.writeFileSync(
    path.join(child, 'package.json'),
    `${JSON.stringify({
      name: 'fixture-child',
      version: '1.0.0',
      license: 'MIT',
      files: ['dist', 'license.md']
    }, null, 2)}\n`
  )
  fs.writeFileSync(
    path.join(child, 'package-lock.json'),
    `${JSON.stringify({
      name: 'fixture-child',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture-child', version: '1.0.0', license: 'MIT' }
      }
    }, null, 2)}\n`
  )
  fs.writeFileSync(path.join(child, LICENSE_FILE), 'stale text\n')
  fs.writeFileSync(path.join(child, 'license.md'), 'legacy text\n')

  assert.ok(validatePackageLicenses(fixture).length >= 4)
  synchronizePackageLicenses(fixture)
  assert.deepEqual(validatePackageLicenses(fixture), [])
  assert.equal(fs.existsSync(path.join(child, 'license.md')), false)
})
