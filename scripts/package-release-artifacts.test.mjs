import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  createLicenseInventory,
  deterministicUuid,
  mergeCycloneDxDocuments,
  topologicallyOrderProjects,
  validateRelativeArtifactPath
} from './package-release-artifacts.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const RELEASE_WORKFLOW = path.join(REPOSITORY_ROOT, '.github/workflows/release.yaml')
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/npm-package-supply-chain.json')
const PROJECTS_PATH = path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')

test('deterministic UUIDs are stable RFC 4122 version 5 identifiers', () => {
  const first = deterministicUuid('release-artifact')
  assert.equal(first, deterministicUuid('release-artifact'))
  assert.notEqual(first, deterministicUuid('other-artifact'))
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('package order respects internal runtime and peer dependencies with deterministic ties', () => {
  const projects = [
    { name: '@bsv/downstream', manifest: { dependencies: { '@bsv/upstream': '^1.0.0' } } },
    { name: '@bsv/independent', manifest: {} },
    { name: '@bsv/peer-consumer', manifest: { peerDependencies: { '@bsv/upstream': '^1.0.0' } } },
    { name: '@bsv/upstream', manifest: {} }
  ]
  assert.deepEqual(
    topologicallyOrderProjects(projects).map(project => project.name),
    ['@bsv/independent', '@bsv/upstream', '@bsv/downstream', '@bsv/peer-consumer']
  )
  assert.throws(
    () =>
      topologicallyOrderProjects([
        { name: 'a', manifest: { dependencies: { b: '*' } } },
        { name: 'b', manifest: { dependencies: { a: '*' } } }
      ]),
    /dependency cycle/
  )
})

test('artifact paths cannot be absolute, ambiguous, or escaping', () => {
  assert.equal(
    validateRelativeArtifactPath('packages/bsv-sdk-1.0.0.tgz'),
    'packages/bsv-sdk-1.0.0.tgz'
  )
  for (const invalid of [
    '',
    '/tmp/package.tgz',
    '../package.tgz',
    'packages/../package.tgz',
    './package.tgz',
    'packages\\package.tgz'
  ]) {
    assert.throws(() => validateRelativeArtifactPath(invalid), /invalid release artifact path/)
  }
})

test('aggregate CycloneDX retains package roots and dependency relationships', () => {
  const records = [
    {
      rootBomRef: '@bsv/example@1.0.0',
      project: { name: '@bsv/example' },
      sha256: 'a'.repeat(64),
      bom: {
        metadata: {
          component: {
            'bom-ref': '@bsv/example@1.0.0',
            type: 'library',
            name: '@bsv/example',
            version: '1.0.0'
          }
        },
        components: [
          {
            'bom-ref': 'pkg:npm/dependency@2.0.0',
            type: 'library',
            name: 'dependency',
            version: '2.0.0'
          }
        ],
        dependencies: [
          {
            ref: '@bsv/example@1.0.0',
            dependsOn: ['pkg:npm/dependency@2.0.0']
          }
        ]
      }
    }
  ]
  const aggregate = mergeCycloneDxDocuments(records, {
    repository: 'bsv-blockchain/ts-stack',
    commit: 'f'.repeat(40),
    created: '2026-07-27T00:00:00Z',
    npm: '11.16.0'
  })

  assert.equal(aggregate.bomFormat, 'CycloneDX')
  assert.equal(aggregate.specVersion, '1.5')
  assert.equal(aggregate.components.length, 2)
  assert.deepEqual(
    aggregate.dependencies.find(item => item.ref.startsWith('pkg:github/')).dependsOn,
    ['@bsv/example@1.0.0']
  )
})

test('license inventory rejects missing and restricted production licenses', () => {
  const aggregate = {
    components: [
      {
        'bom-ref': 'permissive@1.0.0',
        name: 'permissive',
        version: '1.0.0',
        licenses: [{ license: { id: 'MIT' } }]
      },
      {
        'bom-ref': 'restricted@1.0.0',
        name: 'restricted',
        version: '1.0.0',
        licenses: [{ license: { id: 'GPL-3.0-only' } }]
      },
      {
        'bom-ref': 'unknown@1.0.0',
        name: 'unknown',
        version: '1.0.0'
      }
    ]
  }
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
  const inventory = createLicenseInventory(aggregate, policy)

  assert.equal(inventory.componentCount, 3)
  assert.deepEqual(
    inventory.findings.map(finding => [finding.component, finding.severity]),
    [
      ['restricted@1.0.0', 'HIGH'],
      ['unknown@1.0.0', 'HIGH']
    ]
  )
})

test('npm release workflow preserves scan, attestation, verification, and exact-byte order', () => {
  const workflow = fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
  const projects = JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8'))
  const publicPackages = projects.projects.filter(project => project.release === 'npm-oidc')

  assert.equal(policy.publicPackageCount, publicPackages.length)
  assert.equal(policy.trustedPublisher.repository, 'bsv-blockchain/ts-stack')
  assert.equal(policy.trustedPublisher.workflow, 'release.yaml')
  assert.equal(policy.releaseEnvironment, 'npm-production')
  assert.deepEqual(policy.buildRuntime, {
    runner: 'ubuntu-24.04',
    node: '24.18.0',
    npmMinimum: '11.5.1',
    pnpm: '10.33.2'
  })
  assert.deepEqual(policy.scanGate.targets, ['vulnerabilities', 'licenses'])
  assert.deepEqual(policy.scanGate.severities, ['HIGH', 'CRITICAL'])
  assert.equal(policy.scanGate.ignoreUnfixed, false)
  assert.equal(policy.licensePolicy.requireDeclaredLicense, true)
  assert.equal(policy.licensePolicy.internalLicense, 'Open BSV License Version 6')
  assert.deepEqual(policy.attestations.predicates, [
    'https://slsa.dev/provenance/v1',
    'https://cyclonedx.org/bom'
  ])

  assert.match(workflow, /attestations: write/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/)
  assert.match(workflow, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/g)
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/)
  assert.doesNotMatch(workflow, /pnpm\s+-r[\s\S]{0,100}\spublish\b/)
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.equal(workflow.match(/runs-on: ubuntu-24\.04/g)?.length, 3)
  assert.equal(workflow.match(/node-version: 24\.18\.0/g)?.length, 3)
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 3)
  assert.match(workflow, /candidate: \$\{\{ steps\.artifacts\.outputs\.candidate \}\}/)
  assert.match(workflow, /name: \$\{\{ needs\.prepare\.outputs\.candidate \}\}/)
  const prepareJob = workflow.slice(workflow.indexOf('  prepare:'), workflow.indexOf('  publish:'))
  assert.doesNotMatch(prepareJob, /id-token: write|environment: npm-production/)
  assert.match(prepareJob, /permissions:\n\s+contents: read/)

  const stage = workflow.indexOf('- name: Stage exact npm release artifacts')
  const scan = workflow.indexOf('- name: Reject high and critical package findings')
  const provenance = workflow.indexOf('- name: Attest npm package build provenance')
  const sbom = workflow.indexOf('- name: Attest npm package CycloneDX SBOM')
  const verify = workflow.indexOf('- name: Verify npm package attestations')
  const upload = workflow.indexOf('- name: Retain npm release evidence')
  const publish = workflow.indexOf('- name: Publish the attested npm tarballs')
  assert.ok(stage > 0)
  assert.ok(stage < scan)
  assert.ok(scan < provenance)
  assert.ok(provenance < sbom)
  assert.ok(sbom < verify)
  assert.ok(verify < upload)
  assert.ok(upload < publish)
})
