import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  classifyDirectDependency,
  collectOverrides,
  immutableDeploymentImages,
  parsePnpmOverrides,
  validateDependencyReleaseGovernance,
  validatePullRequestEvidence
} from './dependency-release-governance.mjs'

const dependencyPolicy = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'governance/dependency-release-policy.json'), 'utf8')
)

test('dependency and release governance is internally complete', () => {
  assert.deepEqual(validateDependencyReleaseGovernance(), [])

  const overrides = collectOverrides()
  assert.equal(overrides.length, 20)
  assert.equal(overrides.filter(entry => entry.selector === 'gaxios').length, 8)
  assert.equal(overrides.filter(entry => entry.selector === 'uuid').length, 3)
  assert.equal(overrides.filter(entry => entry.selector === 'brace-expansion').length, 4)
})

test('patched image-size rejects non-progressing ICNS entries', () => {
  const mobileManifest = path.join(
    process.cwd(),
    'packages/wallet/wallet-toolbox/mobile/package.json'
  )
  const source = `
    const { createRequire } = require('node:module')
    const requireFromMobile = createRequire(${JSON.stringify(mobileManifest)})
    const metroManifest = requireFromMobile.resolve('metro/package.json')
    const requireFromMetro = createRequire(metroManifest)
    const { imageSize } = requireFromMetro('image-size')
    const imageSizeManifest = requireFromMetro.resolve('image-size/package.json')
    const { findBox } = require(
      require('node:path').join(require('node:path').dirname(imageSizeManifest), 'dist/types/utils.js')
    )
    const zeroBox = Buffer.alloc(8)
    zeroBox.write('meta', 4)
    if (findBox(zeroBox, 'meta', 0) !== undefined) process.exit(4)
    const input = Buffer.alloc(16)
    input.write('icns', 0)
    input.writeUInt32BE(16, 4)
    input.write('ic07', 8)
    input.writeUInt32BE(0, 12)
    try {
      imageSize(input)
      process.exit(2)
    } catch (error) {
      if (!String(error).includes('Invalid ICNS image entry length')) process.exit(3)
    }
  `
  const result = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 2_000
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})

test('pnpm override parsing preserves scoped parent selectors', () => {
  assert.deepEqual(
    parsePnpmOverrides(`
minimumReleaseAge: 1440
overrides:
  brace-expansion@<5.0.9: 5.0.9
  'typed-rest-client@2.3.1>qs': 6.15.3
trustPolicy: no-downgrade
`),
    [
      { selector: 'brace-expansion@<5.0.9', value: '5.0.9' },
      { selector: 'typed-rest-client@2.3.1>qs', value: '6.15.3' }
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
