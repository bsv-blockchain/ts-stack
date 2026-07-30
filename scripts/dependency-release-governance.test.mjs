import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectOverrides,
  immutableDeploymentImages,
  parsePnpmOverrides,
  validateDependencyReleaseGovernance,
  validatePullRequestEvidence
} from './dependency-release-governance.mjs'

test('dependency and release governance is internally complete', () => {
  assert.deepEqual(validateDependencyReleaseGovernance(), [])

  const overrides = collectOverrides()
  assert.equal(overrides.length, 19)
  assert.equal(overrides.filter(entry => entry.selector === 'gaxios').length, 8)
  assert.equal(overrides.filter(entry => entry.selector === 'uuid').length, 3)
  assert.equal(overrides.filter(entry => entry.selector === 'brace-expansion').length, 4)
})

test('pnpm override parsing preserves scoped parent selectors', () => {
  assert.deepEqual(
    parsePnpmOverrides(`
minimumReleaseAge: 1440
overrides:
  brace-expansion@<=5.0.7: 5.0.8
  'typed-rest-client@2.3.1>qs': 6.15.3
trustPolicy: no-downgrade
`),
    [
      { selector: 'brace-expansion@<=5.0.7', value: '5.0.8' },
      { selector: 'typed-rest-client@2.3.1>qs', value: '6.15.3' }
    ]
  )
})

test('dependency evidence is required only for dependency-shaped changes', () => {
  assert.deepEqual(validatePullRequestEvidence('', ['packages/sdk/src/index.ts']), [])
  assert.deepEqual(validatePullRequestEvidence('', ['pnpm-lock.yaml']), [
    'Dependency changes require the ## Dependency evidence section'
  ])

  const body = `## Dependency evidence

- Release notes and necessity: Reviewed the linked upstream release notes.
- Runtime, build, and peer compatibility: Supported ranges and engines remain compatible.
- Deduplicated lockfile: Regenerated once from the frozen manifests.
- Audit and CodeQL: High/critical audit and CodeQL are green.
- Package and consumer tests: Exact package and consumer checks are green.
- Bundle and performance impact: No measured regression.
- Affected public package versions: No public source changed.
`
  assert.deepEqual(validatePullRequestEvidence(body, ['infra/wab/package-lock.json']), [])
})

test('every checked-in deployment image is immutable and scheduled for pull verification', () => {
  const images = immutableDeploymentImages()
  assert.ok(images.length >= 6)
  assert.ok(images.every(image => /@sha256:[0-9a-f]{64}$/.test(image)))
})
