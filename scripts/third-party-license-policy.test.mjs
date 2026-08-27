import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  expectedThirdPartyFilesForPackage,
  synchronizeThirdPartyMaterials,
  thirdPartyComponentsForPackage,
  validateThirdPartyMaterials
} from './third-party-license-policy.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'third-party-policy-'))
  fs.mkdirSync(path.join(root, 'governance/license-evidence'), { recursive: true })
  fs.mkdirSync(path.join(root, 'LICENSES'), { recursive: true })
  fs.mkdirSync(path.join(root, 'packages/example/src'), { recursive: true })
  const license = 'fixture license\n'
  fs.writeFileSync(path.join(root, 'LICENSES/example.txt'), license)
  fs.writeFileSync(path.join(root, 'packages/example/src/index.ts'), 'export const value = 1\n')
  fs.writeFileSync(
    path.join(root, 'packages/example/package.json'),
    `${JSON.stringify({ name: '@fixture/example', files: ['dist', 'LICENSE.txt'] }, null, 2)}\n`
  )
  const continuity = {
    schemaVersion: 1,
    snapshot: {
      uniformizationCommit: '1111111111111111111111111111111111111111',
      parentCommit: '2222222222222222222222222222222222222222',
      preexistingLicenseOrPolicyFiles: 1,
      preexistingTextsModified: 1,
      preexistingTextsRemovedOrRenamed: 0
    },
    priorFiles: [
      {
        path: 'packages/example/LICENSE.old',
        kind: 'license',
        gitBlobSha1: '3333333333333333333333333333333333333333',
        licenseText: 'example-license',
        scope: 'packages/example',
        uniformizationAction: 'modified'
      }
    ]
  }
  const provenance = { schemaVersion: 1, records: [] }
  const rootPolicy = '# Fixture prior policy\n'
  const evidence = [
    [
      'license-continuity',
      'governance/license-continuity.json',
      `${JSON.stringify(continuity, null, 2)}\n`
    ],
    [
      'license-provenance',
      'governance/license-evidence/provenance.json',
      `${JSON.stringify(provenance, null, 2)}\n`
    ],
    [
      'preuniformization-root-policy',
      'governance/license-evidence/pre-uniformization-root-policy.md',
      rootPolicy
    ]
  ]
  for (const [, evidencePath, contents] of evidence) {
    fs.writeFileSync(path.join(root, evidencePath), contents)
  }
  const registry = {
    schemaVersion: 1,
    policy: {
      firstPartyLicense: 'LicenseRef-Open-BSV-License-6',
      noticeFile: 'THIRD_PARTY_NOTICES.md',
      licensesDirectory: 'LICENSES',
      releaseRequiresAllClearances: true,
      evidenceFilesRequired: true,
      licenseContinuityFile: 'governance/license-continuity.json',
      licenseProvenanceFile: 'governance/license-evidence/provenance.json',
      forbiddenUnlicensedArtifacts: ['packages/example/unlicensed-bundle.js']
    },
    evidenceFiles: evidence.map(([id, evidencePath, contents]) => ({
      id,
      path: evidencePath,
      sha256: crypto.createHash('sha256').update(contents).digest('hex')
    })),
    licenseTexts: [
      {
        id: 'example-license',
        path: 'LICENSES/example.txt',
        sha256: crypto.createHash('sha256').update(license).digest('hex'),
        source: 'https://example.test/license'
      }
    ],
    materials: [
      {
        id: 'example',
        name: 'Example',
        version: '1.0.0',
        licenseExpression: 'MIT',
        licenseText: 'example-license',
        copyright: ['Copyright Example'],
        source: 'https://example.test/source',
        incorporation: 'modified source',
        paths: ['packages/example/src']
      }
    ],
    distributions: [
      { path: '.', materials: 'all' },
      { path: 'packages/example', packageName: '@fixture/example', materials: ['example'] }
    ],
    clearances: [
      {
        id: 'permission',
        status: 'required',
        materials: ['example'],
        finding: 'permission evidence is pending',
        acceptedEvidence: 'written permission'
      }
    ]
  }
  fs.writeFileSync(
    path.join(root, 'governance/third-party-materials.json'),
    `${JSON.stringify(registry, null, 2)}\n`
  )
  return root
}

test('synchronizes and validates scoped notice payloads and SBOM components', () => {
  const root = fixture()
  try {
    synchronizeThirdPartyMaterials(root)
    assert.deepEqual(validateThirdPartyMaterials(root), [])
    assert.deepEqual(expectedThirdPartyFilesForPackage('@fixture/example', root), [
      'THIRD_PARTY_NOTICES.md',
      'LICENSES/example.txt'
    ])
    assert.equal(thirdPartyComponentsForPackage('@fixture/example', root)[0].name, 'Example')
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'packages/example/package.json'), 'utf8')
    )
    assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.md'))
    assert.ok(manifest.files.includes('LICENSES'))

    const registryPath = path.join(root, 'governance/third-party-materials.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    const continuityPath = path.join(root, 'governance/license-continuity.json')
    const continuity = JSON.parse(fs.readFileSync(continuityPath, 'utf8'))
    continuity.priorFiles = []
    continuity.snapshot.preexistingLicenseOrPolicyFiles = 0
    continuity.snapshot.preexistingTextsModified = 0
    const continuityContents = `${JSON.stringify(continuity, null, 2)}\n`
    fs.writeFileSync(continuityPath, continuityContents)
    registry.evidenceFiles.find(evidence => evidence.id === 'license-continuity').sha256 = crypto
      .createHash('sha256')
      .update(continuityContents)
      .digest('hex')
    registry.materials[0].licenseText = null
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
    synchronizeThirdPartyMaterials(root)
    const manifestWithoutLicenseText = JSON.parse(
      fs.readFileSync(path.join(root, 'packages/example/package.json'), 'utf8')
    )
    assert.ok(!manifestWithoutLicenseText.files.includes('LICENSES'))
    assert.ok(!fs.existsSync(path.join(root, 'packages/example/LICENSES')))
    assert.deepEqual(validateThirdPartyMaterials(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('detects tampering and blocks releases until clearance is recorded', () => {
  const root = fixture()
  try {
    synchronizeThirdPartyMaterials(root)
    fs.appendFileSync(path.join(root, 'packages/example/LICENSES/example.txt'), 'tampered\n')
    fs.writeFileSync(path.join(root, 'packages/example/LICENSES/stale.txt'), 'stale\n')
    assert.ok(
      validateThirdPartyMaterials(root).some(error =>
        error.includes('packages/example/LICENSES/example.txt is missing or stale')
      )
    )
    assert.ok(
      validateThirdPartyMaterials(root).some(error =>
        error.includes('packages/example/LICENSES/stale.txt is unexpected')
      )
    )
    synchronizeThirdPartyMaterials(root)
    assert.ok(
      validateThirdPartyMaterials(root, { release: true }).some(error =>
        error.includes('release blocked by clearance permission')
      )
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a forbidden unlicensed artifact if it is restored', () => {
  const root = fixture()
  try {
    synchronizeThirdPartyMaterials(root)
    fs.writeFileSync(path.join(root, 'packages/example/unlicensed-bundle.js'), 'vendor bundle\n')
    assert.ok(
      validateThirdPartyMaterials(root).some(error =>
        error.includes(
          'forbidden unlicensed artifact is present: packages/example/unlicensed-bundle.js'
        )
      )
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('hash-pins provenance evidence and validates prior-license continuity', () => {
  const root = fixture()
  try {
    synchronizeThirdPartyMaterials(root)
    const provenancePath = path.join(root, 'governance/license-evidence/provenance.json')
    fs.appendFileSync(provenancePath, 'tampered\n')
    assert.ok(
      validateThirdPartyMaterials(root).some(error =>
        error.includes('governance/license-evidence/provenance.json hash is')
      )
    )

    const registryPath = path.join(root, 'governance/third-party-materials.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    const continuityPath = path.join(root, 'governance/license-continuity.json')
    const continuity = JSON.parse(fs.readFileSync(continuityPath, 'utf8'))
    continuity.priorFiles[0].licenseText = 'missing-license'
    const continuityContents = `${JSON.stringify(continuity, null, 2)}\n`
    fs.writeFileSync(continuityPath, continuityContents)
    registry.evidenceFiles.find(evidence => evidence.id === 'license-continuity').sha256 = crypto
      .createHash('sha256')
      .update(continuityContents)
      .digest('hex')
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
    assert.ok(
      validateThirdPartyMaterials(root).some(error =>
        error.includes('continuity references unknown license missing-license')
      )
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
