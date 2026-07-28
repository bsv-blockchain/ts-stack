import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalizePackedManifest,
  createLicenseInventory,
  deterministicUuid,
  mergeCycloneDxDocuments,
  prepareSbomManifest,
  removeInjectedRootDependencies,
  removeLocalFileReferences,
  topologicallyOrderProjects,
  validateBuildRuntime,
  validateRelativeArtifactPath,
  validateStagedLockfile
} from './package-release-artifacts.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const RELEASE_WORKFLOW = path.join(REPOSITORY_ROOT, '.github/workflows/release.yaml')
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/npm-package-supply-chain.json')
const PROJECTS_PATH = path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')

test('deterministic UUIDs are stable RFC 9562 version 8 identifiers', () => {
  const first = deterministicUuid('release-artifact')
  assert.equal(first, deterministicUuid('release-artifact'))
  assert.notEqual(first, deterministicUuid('other-artifact'))
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
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

test('packed manifest canonicalization sorts dependency maps without changing export order', () => {
  const manifest = {
    name: '@example-local/canonical-wave21',
    exports: {
      '.': {
        browser: './browser.js',
        import: './index.js',
        require: './index.cjs'
      }
    },
    dependencies: { zebra: '^1.0.0', alpha: '^1.0.0' },
    devDependencies: { delta: '^1.0.0', beta: '^1.0.0' },
    peerDependenciesMeta: { zebra: { optional: true }, alpha: { optional: false } }
  }
  const canonical = canonicalizePackedManifest(manifest)

  assert.deepEqual(Object.keys(canonical.dependencies), ['alpha', 'zebra'])
  assert.deepEqual(Object.keys(canonical.devDependencies), ['beta', 'delta'])
  assert.deepEqual(Object.keys(canonical.peerDependenciesMeta), ['alpha', 'zebra'])
  assert.deepEqual(Object.keys(canonical.exports['.']), ['browser', 'import', 'require'])
  assert.deepEqual(Object.keys(manifest.dependencies), ['zebra', 'alpha'])
})

test('SBOM preparation resolves the complete staged runtime and peer closure locally', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-sbom-closure-'))
  const names = {
    root: '@example-local/root-wave21',
    middle: '@example-local/middle-wave21',
    leaf: '@example-local/leaf-wave21',
    sdk: '@example-local/sdk-wave21'
  }
  const rootManifest = {
    name: names.root,
    version: '1.0.0',
    dependencies: { [names.middle]: '^1.0.0' }
  }
  const projects = [
    {
      name: names.middle,
      manifest: {
        name: names.middle,
        version: '1.0.0',
        dependencies: { [names.leaf]: '^1.0.0' },
        peerDependencies: { [names.sdk]: '^1.0.0' }
      }
    },
    { name: names.leaf, manifest: { name: names.leaf, version: '1.0.0' } },
    { name: names.sdk, manifest: { name: names.sdk, version: '1.0.0' } }
  ]

  try {
    const stagedByName = new Map()
    for (const project of projects) {
      const packageDirectory = path.join(temporaryDirectory, project.name.split('/').at(-1))
      fs.mkdirSync(packageDirectory, { recursive: true })
      fs.writeFileSync(
        path.join(packageDirectory, 'package.json'),
        `${JSON.stringify(project.manifest, null, 2)}\n`
      )
      stagedByName.set(project.name, {
        project,
        tarballPath: packageDirectory
      })
    }

    const prepared = prepareSbomManifest(rootManifest, stagedByName)
    assert.deepEqual(prepared.injectedNames, [names.leaf, names.sdk])
    assert.deepEqual(prepared.stagedNames, [names.leaf, names.middle, names.sdk])
    assert.equal(
      prepared.manifest.dependencies[names.middle],
      `file:${stagedByName.get(names.middle).tarballPath}`
    )
    assert.equal(
      prepared.manifest.dependencies[names.leaf],
      `file:${stagedByName.get(names.leaf).tarballPath}`
    )
    assert.equal(
      prepared.manifest.dependencies[names.sdk],
      `file:${stagedByName.get(names.sdk).tarballPath}`
    )

    const rootDirectory = path.join(temporaryDirectory, 'root')
    fs.mkdirSync(rootDirectory)
    fs.writeFileSync(
      path.join(rootDirectory, 'package.json'),
      `${JSON.stringify(prepared.manifest, null, 2)}\n`
    )
    execFileSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--offline'
      ],
      { cwd: rootDirectory, stdio: 'pipe' }
    )
    const lock = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package-lock.json'), 'utf8'))
    assert.doesNotThrow(() => validateStagedLockfile(lock, stagedByName, prepared.stagedNames))
    for (const name of Object.values(names).filter(name => name !== names.root)) {
      assert.ok(lock.packages[`node_modules/${name}`], `${name} must resolve from a local package`)
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('SBOM lockfile validation rejects registry fallback for a staged package', () => {
  const name = '@example-local/staged-wave21'
  const stagedByName = new Map([
    [
      name,
      {
        project: { manifest: { name, version: '1.0.0' } },
        tarballPath: '/tmp/staged-wave21.tgz'
      }
    ]
  ])
  assert.throws(
    () =>
      validateStagedLockfile(
        {
          packages: {
            [`node_modules/${name}`]: {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/staged-wave21/-/staged-wave21-1.0.0.tgz'
            }
          }
        },
        stagedByName,
        [name]
      ),
    /resolved outside its staged tarball/
  )
  assert.throws(
    () => validateStagedLockfile({ packages: {} }, stagedByName, [name]),
    /missing from the staged package lockfile/
  )
})

test('SBOM normalization removes local paths without changing portable references', () => {
  assert.deepEqual(
    removeLocalFileReferences([
      {
        name: '@example-local/staged-wave21',
        externalReferences: [
          { type: 'distribution', url: 'file:/tmp/staged-wave21.tgz' },
          { type: 'vcs', url: 'https://github.com/example/staged-wave21' }
        ]
      },
      {
        name: 'only-local',
        externalReferences: [{ type: 'distribution', url: 'file:../only-local.tgz' }]
      }
    ]),
    [
      {
        name: '@example-local/staged-wave21',
        externalReferences: [{ type: 'vcs', url: 'https://github.com/example/staged-wave21' }]
      },
      { name: 'only-local' }
    ]
  )
})

test('resolver-only closure dependencies are removed from the SBOM root relationship', () => {
  const dependencies = [
    {
      ref: '@example-local/root@1.0.0',
      dependsOn: [
        '@example-local/middle@1.0.0',
        '@example-local/leaf@1.0.0',
        '@example-local/sdk@1.0.0',
        'external@2.0.0'
      ]
    },
    {
      ref: '@example-local/middle@1.0.0',
      dependsOn: ['@example-local/leaf@1.0.0', '@example-local/sdk@1.0.0']
    }
  ]
  const filtered = removeInjectedRootDependencies(
    dependencies,
    '@example-local/root@1.0.0',
    new Set(['@example-local/leaf@1.0.0', '@example-local/sdk@1.0.0'])
  )

  assert.deepEqual(filtered, [
    {
      ref: '@example-local/root@1.0.0',
      dependsOn: ['@example-local/middle@1.0.0', 'external@2.0.0']
    },
    dependencies[1]
  ])
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

test('release staging requires the exact governed build runtime', () => {
  const policy = {
    buildRuntime: {
      node: '24.18.0',
      npmMinimum: '11.5.1',
      pnpm: '10.33.2'
    }
  }
  const governed = { node: 'v24.18.0', npm: '11.16.0', pnpm: '10.33.2' }
  assert.doesNotThrow(() => validateBuildRuntime(governed, policy))
  assert.throws(
    () => validateBuildRuntime({ ...governed, node: 'v24.14.0' }, policy),
    /Node\.js v24\.14\.0 does not match release policy v24\.18\.0/
  )
  assert.throws(
    () => validateBuildRuntime({ ...governed, npm: '11.5.0' }, policy),
    /below trusted publishing minimum/
  )
  assert.throws(
    () => validateBuildRuntime({ ...governed, pnpm: '10.33.1' }, policy),
    /does not match release policy/
  )
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
  assert.deepEqual(policy.artifacts.canonicalManifestDependencyFields, [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta'
  ])
  assert.deepEqual(policy.sbom.coordinatedCandidates, {
    resolver: 'staged tarball runtime and peer dependency closure',
    runtimeFields: ['dependencies', 'optionalDependencies', 'peerDependencies'],
    registryFallbackForStagedCandidates: false,
    preserveOriginalRootRelationships: true
  })
  assert.equal(policy.sbom.localFilesystemReferences, false)
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
