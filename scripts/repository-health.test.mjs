import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  REPOSITORY_ROOT,
  collectContractFindings,
  compareContractBaseline,
  createContractBaseline,
  discoverWorkspaceProjects,
  evaluateRepositoryHealth,
  readJson,
  validateExceptionRegistry,
  validateProjectRegistry
} from './repository-health.mjs'

const healthDirectory = path.join(REPOSITORY_ROOT, 'governance/repository-health')
const projects = readJson(path.join(healthDirectory, 'projects.json'))

test('workspace discovery exactly matches the 37-project registry', () => {
  const discovered = discoverWorkspaceProjects()

  assert.equal(discovered.length, 37)
  assert.equal(discovered.filter(project => project.manifest.private !== true).length, 30)
  assert.deepEqual(
    discovered.map(project => project.path),
    [...projects.projects].map(project => project.path).sort()
  )
  assert.deepEqual(validateProjectRegistry(projects, discovered), [])
  assert.equal(projects.generatedArtifacts.length, 4)
  assert.ok(
    projects.generatedArtifacts.every(item => item.owner === 'ts-stack-maintainers')
  )
})

test('current repository health controls and ratchet are internally consistent', () => {
  const result = evaluateRepositoryHealth({ today: '2026-07-25' })

  assert.deepEqual(result.errors, [])
  assert.equal(result.projects.length, 37)
  assert.equal(result.publicPackages, 30)
  assert.ok(result.findings.length > 0, 'known debt must remain visible until remediated')
})

test('contract findings are deterministic and match their recorded baseline', () => {
  const discovered = discoverWorkspaceProjects()
  const findings = collectContractFindings(projects, discovered)
  const baseline = readJson(path.join(healthDirectory, 'contract-baseline.json'))

  assert.deepEqual(compareContractBaseline(baseline, findings), [])
  assert.deepEqual(
    createContractBaseline(findings, '2026-07-25'),
    baseline
  )
  assert.ok(
    findings.some(item =>
      item.id ===
      'packages/messaging/ts-paymail/docs/examples::placeholder-quality-script::test'
    ),
    'the failing npm test placeholder must remain visible until it is replaced'
  )
})

test('contract ratchet detects both new and stale resolved findings', () => {
  const sample = {
    id: 'packages/example::missing-script::test',
    path: 'packages/example',
    name: '@bsv/example',
    rule: 'missing-script',
    message: 'Profile node-library requires script test'
  }
  const baseline = createContractBaseline([sample], '2026-07-25')

  assert.match(compareContractBaseline(baseline, [])[0], /Resolved package-contract finding/)
  assert.match(
    compareContractBaseline(createContractBaseline([], '2026-07-25'), [sample])[0],
    /New package-contract finding/
  )
})

test('exception registry rejects expired, under-evidenced exceptions', () => {
  const registry = {
    schemaVersion: 1,
    lastReviewed: '2026-07-25',
    exceptions: [
      {
        id: 'temporary-hold',
        category: 'dependency-hold',
        target: 'example',
        owner: 'ts-stack-maintainers',
        reason: 'short',
        evidence: [],
        created: '2026-07-01',
        reviewBy: '2026-07-24',
        removeWhen: 'fixed upstream'
      }
    ]
  }

  assert.deepEqual(
    validateExceptionRegistry(registry, '2026-07-25'),
    [
      'exception temporary-hold reason must be at least 20 characters',
      'exception temporary-hold must have one or more evidence references',
      'exception temporary-hold expired on 2026-07-24'
    ]
  )
})

test('exception registry requires a current monthly review even when empty', () => {
  assert.deepEqual(
    validateExceptionRegistry({
      schemaVersion: 1,
      lastReviewed: '2026-06-01',
      exceptions: []
    }, '2026-07-25'),
    ['exceptions.json monthly review is overdue: last reviewed 2026-06-01']
  )
  assert.deepEqual(
    validateExceptionRegistry({
      schemaVersion: 1,
      lastReviewed: '2026-07-26',
      exceptions: []
    }, '2026-07-25'),
    ['exceptions.json lastReviewed is in the future: 2026-07-26']
  )
})

test('generated-artifact and exception owners must resolve to the owner registry', () => {
  const discovered = discoverWorkspaceProjects()
  const invalidProjects = structuredClone(projects)
  invalidProjects.generatedArtifacts[0].owner = 'unknown-owner'

  assert.match(
    validateProjectRegistry(invalidProjects, discovered).join('\n'),
    /generated artifact conformance\/generated\/\*\* references unknown owner/
  )
  assert.deepEqual(
    validateExceptionRegistry({
      schemaVersion: 1,
      lastReviewed: '2026-07-25',
      exceptions: [
        {
          id: 'owned-hold',
          category: 'dependency-hold',
          target: 'example',
          owner: 'unknown-owner',
          reason: 'A sufficiently detailed temporary compatibility hold.',
          evidence: ['https://example.test/evidence'],
          created: '2026-07-25',
          reviewBy: '2026-08-01',
          removeWhen: 'Compatibility is restored.'
        }
      ]
    }, '2026-07-25', projects.ownerDefinitions),
    ['exception owned-hold references unknown owner "unknown-owner"']
  )
})

test('exception JSON schema is checked in and references the active schema version', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(healthDirectory, 'exception.schema.json'), 'utf8')
  )

  assert.equal(schema.properties.schemaVersion.const, 1)
  assert.ok(schema.properties.exceptions.items.required.includes('reviewBy'))
  assert.ok(schema.properties.exceptions.items.required.includes('removeWhen'))
})
