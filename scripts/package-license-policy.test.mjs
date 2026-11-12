import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  discoverPackageManifests,
  EXPECTED_LICENSE_SHA256,
  EXPECTED_PATENTS_SHA256,
  LICENSE_DECLARATION,
  LICENSE_FILE,
  LICENSE_NAME,
  NOTICE_FILE,
  OCI_LICENSE_REFERENCE,
  PATENTS_FILE,
  REPOSITORY_ROOT,
  synchronizePackageLicenses,
  validatePackageLicenses
} from './package-license-policy.mjs'

test('license discovery excludes generated mutation copies but retains authored neighbors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'license-inventory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authored = ['.', 'packages/example', 'packages/example/.stryker-tmp-lookalike']
  for (const directory of [...authored, 'packages/example/.stryker-tmp/sandbox-fixture']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true })
    fs.writeFileSync(path.join(root, directory, 'package.json'), '{}')
  }
  assert.deepEqual(
    discoverPackageManifests(root),
    authored
      .map(directory => path.join(root, directory, 'package.json'))
      .sort((a, b) => a.localeCompare(b))
  )
})

test('all package projects use the exact Apache License 2.0, the root NOTICE and PATENTS', () => {
  assert.equal(LICENSE_NAME, 'Apache License, Version 2.0')
  assert.equal(
    EXPECTED_LICENSE_SHA256,
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
  )
  assert.equal(LICENSE_FILE, 'LICENSE')
  assert.equal(NOTICE_FILE, 'NOTICE')
  assert.equal(PATENTS_FILE, 'PATENTS')
  assert.equal(
    EXPECTED_PATENTS_SHA256,
    '02988c67da2b43a9c2a566df2f3ff1376e7fa3eaed3562fa983d12f78a8cd8e0'
  )
  assert.equal(LICENSE_DECLARATION, 'Apache-2.0')
  assert.equal(OCI_LICENSE_REFERENCE, 'Apache-2.0')
  assert.equal(discoverPackageManifests().length, 57)
  assert.deepEqual(validatePackageLicenses(), [])
})

test('license synchronization repairs manifest, lockfile, copy, and filename drift', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-license-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  fs.copyFileSync(path.join(REPOSITORY_ROOT, LICENSE_FILE), path.join(fixture, LICENSE_FILE))
  fs.copyFileSync(path.join(REPOSITORY_ROOT, NOTICE_FILE), path.join(fixture, NOTICE_FILE))
  fs.copyFileSync(path.join(REPOSITORY_ROOT, PATENTS_FILE), path.join(fixture, PATENTS_FILE))
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    `${JSON.stringify({ name: 'fixture-root', private: true, license: LICENSE_DECLARATION }, null, 2)}\n`
  )

  const child = path.join(fixture, 'package')
  fs.mkdirSync(child)
  fs.writeFileSync(
    path.join(child, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-child',
        version: '1.0.0',
        license: 'MIT',
        files: ['dist', 'license.md', 'LICENSE.txt']
      },
      null,
      2
    )}\n`
  )
  fs.writeFileSync(
    path.join(child, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'fixture-child',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture-child', version: '1.0.0', license: 'MIT' }
        }
      },
      null,
      2
    )}\n`
  )
  fs.writeFileSync(path.join(child, LICENSE_FILE), 'stale text\n')
  fs.writeFileSync(path.join(child, 'LICENSE.txt'), 'legacy text\n')

  assert.ok(validatePackageLicenses(fixture).length >= 5)
  synchronizePackageLicenses(fixture)
  assert.deepEqual(validatePackageLicenses(fixture), [])
  assert.equal(fs.existsSync(path.join(child, 'LICENSE.txt')), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(child, 'package.json'), 'utf8')).files, [
    'dist',
    LICENSE_FILE,
    NOTICE_FILE,
    PATENTS_FILE
  ])
  assert.ok(
    fs
      .readFileSync(path.join(child, NOTICE_FILE))
      .equals(fs.readFileSync(path.join(fixture, NOTICE_FILE)))
  )
  assert.ok(
    fs
      .readFileSync(path.join(child, PATENTS_FILE))
      .equals(fs.readFileSync(path.join(fixture, PATENTS_FILE)))
  )
})
