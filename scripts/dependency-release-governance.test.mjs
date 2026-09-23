import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  classifyDirectDependency,
  collectOverrides,
  immutableDeploymentImages,
  isAutomationPullRequest,
  parsePnpmOverrides,
  validateDependabotExclusions,
  validateDependencyReleaseGovernance,
  validatePullRequestEvidence
} from './dependency-release-governance.mjs'

const dependencyPolicy = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'governance/dependency-release-policy.json'), 'utf8')
)

test('dependency and release governance is internally complete', () => {
  assert.deepEqual(validateDependencyReleaseGovernance(), [])

  const overrides = collectOverrides()
  assert.equal(overrides.length, 24)
  assert.equal(overrides.filter(entry => entry.selector === 'gaxios').length, 8)
  assert.equal(overrides.filter(entry => entry.selector === 'uuid').length, 3)
  assert.equal(overrides.filter(entry => entry.selector === 'brace-expansion').length, 4)
  assert.equal(overrides.filter(entry => entry.selector === 'toml@<4.2.0').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml@<3.15.2').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml').length, 1)
  assert.deepEqual(
    overrides.filter(entry => entry.selector === 'metro@0.87.0>image-size'),
    [
      {
        source: 'pnpm-workspace.yaml',
        selector: 'metro@0.87.0>image-size',
        value: '2.0.4'
      }
    ]
  )
})

test('pnpm override parsing preserves scoped parent selectors', () => {
  assert.deepEqual(
    parsePnpmOverrides(`
minimumReleaseAge: 1440
overrides:
  brace-expansion@<5.0.9: 5.0.9
  qs@<6.16.0: 6.16.0
trustPolicy: no-downgrade
`),
    [
      { selector: 'brace-expansion@<5.0.9', value: '5.0.9' },
      { selector: 'qs@<6.16.0', value: '6.16.0' }
    ]
  )
})

test('direct dependency inventory distinguishes freshness holds and governed compatibility', () => {
  const declaration = {
    name: 'example',
    declared: '^1.0.0',
    field: 'dependencies',
    manifest: 'package.json'
  }
  const now = new Date('2026-07-30T18:00:00.000Z')
  assert.equal(
    classifyDirectDependency(
      declaration,
      { latest: '1.1.0', publishedAt: '2026-07-30T17:30:00.000Z' },
      dependencyPolicy,
      now
    ),
    'release-age-hold'
  )
  assert.equal(
    classifyDirectDependency(
      declaration,
      { latest: '1.1.0', publishedAt: '2026-07-28T17:30:00.000Z' },
      dependencyPolicy,
      now
    ),
    'compatible-update'
  )
  assert.equal(
    classifyDirectDependency(
      {
        name: 'typescript',
        declared: 'npm:@typescript/typescript6@6.0.2',
        field: 'devDependencies',
        manifest: 'packages/sdk/package.json'
      },
      { latest: '7.0.2', publishedAt: '2026-07-01T00:00:00.000Z' },
      dependencyPolicy,
      now
    ),
    'toolchain-bridge'
  )
})

test('dependency evidence findings apply only to dependency-shaped changes', () => {
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

test('automated pull requests are exempt from dependency evidence', () => {
  assert.equal(isAutomationPullRequest({ authorType: 'Bot' }), true)
  assert.equal(isAutomationPullRequest({ authorLogin: 'dependabot[bot]' }), true)
  assert.equal(isAutomationPullRequest({ actor: 'release-bot' }), true)
  assert.equal(
    isAutomationPullRequest({
      actor: 'maintainer',
      authorLogin: 'contributor',
      authorType: 'User'
    }),
    false
  )
})

test('every checked-in deployment image is immutable and scheduled for pull verification', () => {
  const images = immutableDeploymentImages()
  assert.ok(images.length >= 6)
  assert.ok(images.every(image => /@sha256:[0-9a-f]{64}$/.test(image)))
})

test('scheduled dependency verification installs the workspace before docs facts', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), dependencyPolicy.scheduledVerification.workflow),
    'utf8'
  )
  const install = workflow.indexOf('run: pnpm install --frozen-lockfile --ignore-scripts')
  const docsFacts = workflow.indexOf('run: pnpm docs:facts:check')
  assert.ok(install > 0)
  assert.ok(docsFacts > install)
  assert.doesNotMatch(workflow, /^\s*(NODE_AUTH_TOKEN|NPM_TOKEN|registry-url)\s*:/m)
})

test('Dependabot rejects parent paths before GitHub disables every update job', () => {
  const invalid = `updates:
  - package-ecosystem: npm
    exclude-paths:
      - '../../pnpm-lock.yaml'
      - "../../../pnpm-workspace.yaml"
    ignore:
      - dependency-name: '..unrelated-name'
`
  assert.deepEqual(validateDependabotExclusions(invalid), [
    "Dependabot exclude-paths line 4 must not contain '..'",
    "Dependabot exclude-paths line 5 must not contain '..'"
  ])
  assert.deepEqual(
    validateDependabotExclusions(
      invalid
        .replace('../../pnpm-lock.yaml', '**/pnpm-lock.yaml')
        .replace('../../../pnpm-workspace.yaml', '**/pnpm-workspace.yaml')
    ),
    []
  )
})
