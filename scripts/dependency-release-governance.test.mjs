import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  classifyDirectDependency,
  readPublishedPackage,
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
  assert.equal(overrides.length, 30)
  assert.deepEqual(
    overrides.filter(entry => entry.selector === 'nodemon'),
    ['uhrp-server-basic', 'uhrp-server-cloud-bucket', 'wab'].map(component => ({
      source: `infra/${component}/package.json`,
      selector: 'nodemon',
      value: { chokidar: '4.0.3' }
    }))
  )
  assert.equal(overrides.filter(entry => entry.selector === 'gaxios').length, 8)
  assert.equal(overrides.filter(entry => entry.selector === 'uuid').length, 3)
  assert.equal(overrides.filter(entry => entry.selector === 'brace-expansion').length, 4)
  assert.equal(
    overrides.find(entry => entry.selector === 'brace-expansion@<5.0.12')?.value,
    '5.0.12'
  )
  assert.equal(overrides.find(entry => entry.selector === 'engine.io@<6.6.10')?.value, '6.6.10')
  assert.equal(overrides.filter(entry => entry.selector === 'toml@<4.2.0').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml@<3.15.2').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml').length, 1)
  assert.equal(overrides.find(entry => entry.selector === 'lodash-es@<4.18.0')?.value, '4.18.1')
  assert.equal(overrides.filter(entry => entry.selector.includes('image-size')).length, 0)
  assert.equal(
    overrides.find(entry => entry.selector === 'metro-file-map@0.87.1>micromatch')?.value,
    "'-'"
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

test('initial package verification distinguishes registry absence from failure or an existing publication', async () => {
  const project = { name: '@example/initial' }
  const absent = Object.assign(new Error('not found'), {
    stdout: JSON.stringify({
      error: {
        code: 'E404',
        summary: 'Not Found - GET https://registry.npmjs.org/@example%2finitial - Not found'
      }
    })
  })
  const notFound = async () => {
    throw absent
  }
  const initial = await readPublishedPackage(project, '0.1.0', null, 'initial', notFound)
  assert.equal(initial.status, 'unpublished-initial-candidate')
  assert.equal(initial.publishedLatest, null)
  assert.equal(initial.recordedPublishedBaseline, null)
  await assert.rejects(
    readPublishedPackage(project, '0.1.0', '0.0.1', 'patch', notFound),
    error => error === absent
  )
  await assert.rejects(
    readPublishedPackage(project, '0.1.0', null, 'patch', notFound),
    error => error === absent
  )
  for (const failure of [
    new Error('offline'),
    Object.assign(new Error('authentication failed'), {
      stdout: JSON.stringify({ error: { code: 'E403' } })
    })
  ]) {
    await assert.rejects(
      readPublishedPackage(project, '0.1.0', null, 'initial', async () => {
        throw failure
      }),
      error => error === failure
    )
  }
  for (const summary of [
    'No match found for version latest',
    'Unpublished on 2026-01-01',
    'Not Found - GET https://registry.npmjs.org/@example%2fother - Not found',
    'Not Found - GET https://unrelated.example/@example%2finitial - Not found'
  ]) {
    const failure = Object.assign(new Error(summary), {
      stdout: JSON.stringify({ error: { code: 'E404', summary } })
    })
    await assert.rejects(
      readPublishedPackage(project, '0.1.0', null, 'initial', async () => {
        throw failure
      }),
      error => error === failure
    )
  }
  const published = async () => ({
    version: '0.1.0',
    'dist.integrity': 'sha512-fixture',
    'dist.attestations': { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } }
  })
  assert.equal(
    (await readPublishedPackage(project, '0.1.0', null, 'initial', published)).status,
    'diverged'
  )
  const reconciled = await readPublishedPackage(project, '0.1.0', '0.1.0', 'none', published)
  assert.equal(reconciled.status, 'current')
  assert.equal(reconciled.provenance, true)
  assert.equal(
    (await readPublishedPackage(project, '0.2.0', '0.1.0', 'minor', published)).status,
    'first-party-release-held'
  )
})
