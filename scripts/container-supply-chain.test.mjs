import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const REGISTRY_PATH = join(REPOSITORY_ROOT, 'governance/container-images.json')
const BASE_REFRESH_DOCKERFILE_PATH = join(REPOSITORY_ROOT, 'governance/Dockerfile.container-bases')
const INFRA_RELEASE_PATH = join(REPOSITORY_ROOT, '.github/workflows/infra-release.yaml')
const MARKETPLACE_RELEASE_PATH = join(REPOSITORY_ROOT, '.github/workflows/wab-marketplace-release.yml')
const CI_PATH = join(REPOSITORY_ROOT, '.github/workflows/ci.yml')
const SCORECARD_PATH = join(REPOSITORY_ROOT, '.github/workflows/scorecard.yml')
const DEPENDABOT_PATH = join(REPOSITORY_ROOT, '.github/dependabot.yml')
const SHA256_DIGEST = /@sha256:[a-f0-9]{64}(?:\s|$)/

function trackedFiles (...pathspecs) {
  return execFileSync(
    'git',
    ['ls-files', '--', ...pathspecs],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
}

function readRepositoryFile (path) {
  return readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
}

test('container registry exactly owns every release Dockerfile and immutable base', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
  const registeredDockerfiles = registry.components
    .map(component => `${component.path}/Dockerfile`)
    .sort()
  const trackedDockerfiles = trackedFiles('infra/**/Dockerfile')

  assert.equal(registry.schemaVersion, 1)
  assert.equal(registry.platform, 'linux/amd64')
  assert.deepEqual(registeredDockerfiles, trackedDockerfiles)
  assert.equal(new Set(registry.components.map(component => component.name)).size, registry.components.length)

  const allowedBases = new Set(
    registry.baseImages.flatMap(base => base.references.map(reference => `${reference}@${base.digest}`))
  )
  const refreshBases = readFileSync(BASE_REFRESH_DOCKERFILE_PATH, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('FROM '))
    .map(line => line.split(/\s+/)[1])
    .sort()
  const expectedRefreshBases = registry.baseImages
    .flatMap(base => base.references.map(reference => `${reference}:${base.version}`))
    .sort()
  assert.deepEqual(refreshBases, expectedRefreshBases)

  for (const component of registry.components) {
    assert.match(component.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.match(component.license, /^(?:MIT|ISC|LicenseRef-[A-Za-z0-9-]+)$/)
    assert.match(component.documentation, /^https:\/\/github\.com\/bsv-blockchain\/ts-stack\//)
    assert.ok(component.title.length > 0)
    assert.ok(component.description.length > 0)
    assert.ok(existsSync(join(REPOSITORY_ROOT, component.path, 'package-lock.json')))

    const dockerfile = readRepositoryFile(`${component.path}/Dockerfile`)
    for (const base of registry.baseImages) {
      assert.ok(
        dockerfile.includes(base.version),
        `${component.name} must document governed base version ${base.version}`
      )
    }
    const bases = dockerfile
      .split('\n')
      .filter(line => line.startsWith('FROM '))
      .map(line => line.split(/\s+/)[1])

    assert.ok(bases.length >= 2, `${component.name} must remain a multi-stage image`)
    for (const base of bases) {
      assert.ok(allowedBases.has(base), `${component.name} uses unregistered base ${base}`)
      assert.match(base, SHA256_DIGEST)
    }
    const dockerfileInstructions = dockerfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(dockerfileInstructions, /\bapk upgrade\b/)
  }
})

test('checked-in deployment examples use immutable non-latest image references', () => {
  const deploymentFiles = trackedFiles(
    'infra/**/*.yml',
    'infra/**/*.yaml'
  )

  for (const path of deploymentFiles) {
    const imageLines = readRepositoryFile(path)
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^(?:-\s*)?image:\s*\S/.test(line))

    for (const line of imageLines) {
      const reference = line
        .replace(/^(?:-\s*)?image:\s*/, '')
        .replace(/\s+#.*$/, '')
        .replace(/^["']|["']$/g, '')
      if (reference.includes('${') || reference.startsWith('your-registry/')) continue
      assert.doesNotMatch(reference, /:latest(?:@|$)/, `${path}: ${reference}`)
      assert.match(reference, /^.+:[^@\s]+@sha256:[a-f0-9]{64}$/, `${path}: ${reference}`)
    }
  }
})

test('container release workflows scan before push and publish signed evidence', () => {
  const infraRelease = readFileSync(INFRA_RELEASE_PATH, 'utf8')
  const marketplaceRelease = readFileSync(MARKETPLACE_RELEASE_PATH, 'utf8')
  const ci = readFileSync(CI_PATH, 'utf8')
  const requiredLabels = [
    'org.opencontainers.image.created',
    'org.opencontainers.image.title',
    'org.opencontainers.image.description',
    'org.opencontainers.image.vendor',
    'org.opencontainers.image.version',
    'org.opencontainers.image.source',
    'org.opencontainers.image.revision',
    'org.opencontainers.image.licenses',
    'org.opencontainers.image.url',
    'org.opencontainers.image.documentation'
  ]

  assert.doesNotMatch(infraRelease, /npm install --package-lock-only/)
  assert.doesNotMatch(marketplaceRelease, /npm install --package-lock-only/)
  assert.match(infraRelease, /Manual infrastructure releases must run from main/)
  assert.match(marketplaceRelease, /Manual Marketplace releases must run from main/)
  assert.match(infraRelease, /type=sha,prefix=sha-,format=short/)
  assert.match(infraRelease, /SOURCE_DATE_EPOCH=/)
  assert.match(infraRelease, /artifact-metadata: write/)
  assert.match(infraRelease, /attestations: write/)
  assert.match(infraRelease, /id-token: write/)
  assert.match(infraRelease, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/)
  assert.match(infraRelease, /anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/)
  assert.match(infraRelease, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/)
  assert.match(infraRelease, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/)
  assert.equal(
    infraRelease.match(/docker\/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf/g)?.length,
    1,
    'the scanned release image must be built exactly once'
  )
  assert.ok(
    infraRelease.indexOf('Reject high and critical image vulnerabilities') <
      infraRelease.indexOf('Push the reviewed image'),
    'GHCR release must scan before pushing'
  )

  assert.match(marketplaceRelease, /SOURCE_DATE_EPOCH=/)
  assert.match(marketplaceRelease, /attestations: write/)
  assert.match(marketplaceRelease, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/)
  assert.match(marketplaceRelease, /anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/)
  assert.match(marketplaceRelease, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/)
  assert.ok(
    marketplaceRelease.indexOf('Reject high and critical image vulnerabilities') <
      marketplaceRelease.indexOf('Push image to Marketplace ECR'),
    'Marketplace release must scan before pushing'
  )

  for (const label of requiredLabels) {
    assert.match(infraRelease, new RegExp(label.replaceAll('.', '\\.')))
    assert.match(marketplaceRelease, new RegExp(label.replaceAll('.', '\\.')))
  }

  assert.match(ci, /Reject high and critical image vulnerabilities/)
  assert.match(ci, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/)
  assert.doesNotMatch(`${infraRelease}\n${marketplaceRelease}\n${ci}`, /ignore-unfixed:\s*true/)
})

test('Docker refreshes and OpenSSF posture checks remain automated', () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
  const dependabot = readFileSync(DEPENDABOT_PATH, 'utf8')
  const scorecard = readFileSync(SCORECARD_PATH, 'utf8')

  assert.match(dependabot, /package-ecosystem: docker/)
  assert.match(dependabot, /directory: \/governance/)
  assert.match(dependabot, /dependency-name: node/)
  for (const component of registry.components) {
    assert.match(dependabot, new RegExp(`- /${component.path.replaceAll('/', '\\/')}`))
  }
  const deploymentDirectories = new Set(
    trackedFiles('infra/**/*.yml', 'infra/**/*.yaml')
      .filter(path => !path.includes('/.github/'))
      .filter(path => /^(?:\s*-\s*)?\s*image:\s*\S/m.test(readRepositoryFile(path)))
      .map(path => dirname(path))
  )
  for (const directory of deploymentDirectories) {
    assert.match(
      dependabot,
      new RegExp(`- /${directory.replaceAll('/', '\\/')}(?:\\s|$)`),
      `Dependabot does not own deployment images in ${directory}`
    )
  }

  assert.match(scorecard, /ossf\/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc/)
  assert.match(scorecard, /publish_results: true/)
  assert.match(scorecard, /github\/codeql-action\/upload-sarif@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81/)
  assert.match(scorecard, /security-events: write/)
  assert.match(scorecard, /id-token: write/)
})
