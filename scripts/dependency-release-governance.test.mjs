import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  classifyDirectDependency,
  collectOverrides,
  immutableDeploymentImages,
  isAutomationPullRequest,
  parsePnpmOverrides,
  publishedInstallContexts,
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
  assert.equal(overrides.length, 27)
  assert.equal(overrides.filter(entry => entry.selector === 'gaxios').length, 8)
  assert.equal(overrides.filter(entry => entry.selector === 'uuid').length, 3)
  assert.equal(overrides.filter(entry => entry.selector === 'brace-expansion').length, 4)
  assert.equal(
    overrides.find(entry => entry.selector === 'brace-expansion@<5.0.11')?.value,
    '5.0.11'
  )
  assert.equal(overrides.find(entry => entry.selector === 'engine.io@<6.6.10')?.value, '6.6.10')
  assert.equal(overrides.filter(entry => entry.selector === 'toml@<4.2.0').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml@<3.15.2').length, 1)
  assert.equal(overrides.filter(entry => entry.selector === 'js-yaml').length, 1)
  assert.equal(overrides.find(entry => entry.selector === 'lodash-es@<4.18.0')?.value, '4.18.1')
  assert.equal(overrides.filter(entry => entry.selector.includes('image-size')).length, 0)
  assert.deepEqual(
    overrides.filter(entry => entry.source.includes('nodemon')),
    []
  )
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
    'release-age-advisory'
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

function installReport(names) {
  return {
    schemaVersion: 1,
    errors: [],
    packages: names.map(name => ({
      name,
      publishedLatest: '1.2.3',
      integrity: 'sha512-fixture',
      provenance: true,
      status: 'current'
    }))
  }
}

test('every governed public package gets an exact isolated consumer, including held candidates', () => {
  const names = JSON.parse(fs.readFileSync('governance/repository-health/projects.json', 'utf8'))
    .projects.filter(project => project.release === 'npm-oidc')
    .map(project => project.name)
  const report = installReport(names)
  report.packages[0].status = 'first-party-release-held'
  const contexts = publishedInstallContexts(report)
  assert.equal(contexts.length, names.length)
  assert.equal(new Set(contexts.map(context => context.directory)).size, names.length)
  assert.deepEqual(contexts.map(context => context.name).sort(), [...names].sort())
  for (const context of contexts) {
    assert.match(context.directory, /^\d+-[a-z0-9][a-z0-9._-]*$/)
    assert.deepEqual(context.manifest.dependencies, { [context.name]: '1.2.3' })
    assert.equal(context.manifest.private, true)
  }
})

test('published consumer admission rejects incomplete reports, duplicate packages and unsafe selectors', () => {
  const names = ['@bsv/sdk', '@bsv/paymail']
  const valid = installReport(names)
  const invalid = [
    { ...valid, schemaVersion: 2 },
    { ...valid, errors: ['unverified provenance'] },
    { ...valid, packages: [valid.packages[0]] },
    { ...valid, packages: [valid.packages[0], valid.packages[0]] }
  ]
  for (const change of [
    { name: '@bsv/../../escape' },
    { name: '@bsv/unknown' },
    { publishedLatest: 'latest' },
    { publishedLatest: 'file:../../escape' },
    { integrity: '' },
    { provenance: false },
    { status: 'diverged' }
  ]) {
    invalid.push({ ...valid, packages: [valid.packages[0], { ...valid.packages[1], ...change }] })
  }
  assert.throws(() => publishedInstallContexts(undefined, names))
  for (const report of invalid) assert.throws(() => publishedInstallContexts(report, names))
})

const execFileAsync = promisify(execFile)

async function peerRegistryFixture(directory) {
  const routes = new Map()
  const packages = new Map()
  const server = http.createServer((request, response) => {
    const body = routes.get(decodeURIComponent(request.url))
    response.writeHead(body === undefined ? 404 : 200)
    response.end(body ?? 'Unknown fixture package')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  try {
    for (const manifest of [
      { name: '@bsv/sdk', version: '2.0.0' },
      { name: '@bsv/sdk', version: '3.0.0' },
      { name: '@bsv/paymail', version: '1.0.0', peerDependencies: { '@bsv/sdk': '^2.0.0' } }
    ]) {
      const slug = `${manifest.name.slice(5)}-${manifest.version}`
      const source = path.join(directory, slug)
      fs.mkdirSync(path.join(source, 'package'), { recursive: true })
      fs.writeFileSync(path.join(source, 'package/package.json'), JSON.stringify(manifest))
      const tarball = path.join(source, 'package.tgz')
      execFileSync('tar', ['-czf', tarball, '-C', source, 'package'], { timeout: 10_000 })
      const bytes = fs.readFileSync(tarball)
      const tarballPath = `/tar/${slug}.tgz`
      routes.set(tarballPath, bytes)
      const metadata = packages.get(manifest.name) ?? {
        name: manifest.name,
        versions: {},
        'dist-tags': {}
      }
      metadata.versions[manifest.version] = {
        ...manifest,
        dist: {
          tarball: registry + tarballPath,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        }
      }
      metadata['dist-tags'].latest = manifest.version
      packages.set(manifest.name, metadata)
    }
    for (const [name, metadata] of packages) routes.set('/' + name, JSON.stringify(metadata))
    return { registry, server }
  } catch (error) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    throw error
  }
}

test(
  'ordinary npm peer resolution fails the combined root and passes both isolated consumers',
  { timeout: 60_000 },
  async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-published-peers-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const fixture = await peerRegistryFixture(directory)
    t.after(async () => {
      fixture.server.closeAllConnections()
      await new Promise(resolve => fixture.server.close(resolve))
    })
    const names = ['@bsv/sdk', '@bsv/paymail']
    const report = installReport(names)
    report.packages[0].publishedLatest = '3.0.0'
    report.packages[1].publishedLatest = '1.0.0'
    const contexts = publishedInstallContexts(report, names)
    const install = async (name, manifest) => {
      const cwd = path.join(directory, name)
      fs.mkdirSync(cwd)
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
      await execFileAsync(
        'npm',
        [
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--strict-peer-deps',
          '--fetch-retries=0',
          '--fetch-timeout=5000',
          '--registry=' + fixture.registry,
          '--cache=' + path.join(directory, 'cache')
        ],
        { cwd, timeout: 15_000, encoding: 'utf8' }
      )
      return JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'))
    }
    await assert.rejects(
      install('combined', {
        private: true,
        dependencies: { '@bsv/sdk': '3.0.0', '@bsv/paymail': '1.0.0' }
      }),
      error => /ERESOLVE/.test(error.stderr)
    )
    const sdk = contexts.find(context => context.name === '@bsv/sdk')
    const paymail = contexts.find(context => context.name === '@bsv/paymail')
    const sdkLock = await install(sdk.directory, sdk.manifest)
    const paymailLock = await install(paymail.directory, paymail.manifest)
    assert.equal(sdkLock.packages['node_modules/@bsv/sdk'].version, '3.0.0')
    assert.equal(paymailLock.packages['node_modules/@bsv/sdk'].version, '2.0.0')
    assert.equal(paymailLock.packages['node_modules/@bsv/paymail'].version, '1.0.0')
  }
)

test('scheduled verification installs and verifies every context and retains every lock', () => {
  const workflow = fs.readFileSync(dependencyPolicy.scheduledVerification.workflow, 'utf8')
  assert.equal(workflow.match(/\.contexts\[\]\.directory/g)?.length, 2)
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/)
  assert.match(workflow, /npm audit signatures/)
  assert.match(workflow, /published-install\/\*\*\/package-lock\.json/)
  assert.match(workflow, /published-install\/contexts\.json/)
  assert.doesNotMatch(workflow, /--legacy-peer-deps|--force/)
})

test('dependency resolution has no release-age block and retains real security controls', () => {
  const workspace = fs.readFileSync('pnpm-workspace.yaml', 'utf8')
  assert.doesNotMatch(workspace, /^minimumReleaseAge(?:Exclude)?:/m)
  const npmrc = fs.readFileSync('.npmrc', 'utf8')
  assert.doesNotMatch(npmrc, /^min(?:imum)?-release-age(?:-exclude)?(?:\[\])?=/m)
  assert.match(workspace, /^trustPolicy: no-downgrade$/m)
  assert.match(workspace, /^blockExoticSubdeps: true$/m)
  assert.match(workspace, /^strictDepBuilds: true$/m)
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8')
  assert.match(ci, /run: pnpm audit:security/)
  assert.match(ci, /pnpm install --frozen-lockfile --ignore-scripts/)
  const lock = fs.readFileSync('pnpm-lock.yaml', 'utf8')
  assert.doesNotMatch(lock, /handlebars@4\.7\.9:/)
  assert.match(lock, /handlebars@4\.7\.10:/)
})
