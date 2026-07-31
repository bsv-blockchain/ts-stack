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
  lintScriptExcludesAuthoredCode,
  readJson,
  validateExceptionRegistry,
  validateProjectRegistry
} from './repository-health.mjs'
import { validateBaseline as validateCiPerformanceBaseline } from './ci-performance.mjs'

const healthDirectory = path.join(REPOSITORY_ROOT, 'governance/repository-health')
const projects = readJson(path.join(healthDirectory, 'projects.json'))

test('lint exclusion parsing rejects authored tests and benchmarks without backtracking', () => {
  assert.equal(
    lintScriptExcludesAuthoredCode("oxlint src --ignore-pattern '**/__tests__/**' --deny-warnings"),
    true
  )
  assert.equal(
    lintScriptExcludesAuthoredCode('oxlint src --ignore-pattern=benchmarks/** --deny-warnings'),
    true
  )
  assert.equal(
    lintScriptExcludesAuthoredCode(
      "oxlint src --ignore-pattern 'src/generated/**' --deny-warnings"
    ),
    false
  )
})

test('workspace discovery exactly matches the 38-project registry', () => {
  const discovered = discoverWorkspaceProjects()

  assert.equal(discovered.length, 38)
  assert.equal(discovered.filter(project => project.manifest.private !== true).length, 31)
  assert.deepEqual(
    discovered.map(project => project.path),
    [...projects.projects].map(project => project.path).sort()
  )
  assert.deepEqual(validateProjectRegistry(projects, discovered), [])
  assert.equal(projects.generatedArtifacts.length, 10)
  assert.ok(projects.generatedArtifacts.every(item => item.owner === 'ts-stack-maintainers'))
  assert.deepEqual(projects.dependencyAutomation.firstParty, {
    pattern: '@bsv/*',
    owner: 'ts-stack-maintainers',
    dependabotPolicy: 'ignored',
    updateMechanism: 'scripts/sync-versions.mjs',
    releaseWorkflow: '.github/workflows/release.yaml',
    verification: 'scripts/check-versions.mjs',
    rationale:
      'First-party versions are updated as one release-aware graph after packages are published; generic Dependabot PRs cannot safely coordinate unpublished sibling versions.'
  })
})

test('current repository health controls and ratchet are internally consistent', () => {
  const result = evaluateRepositoryHealth({ today: '2026-07-30' })

  assert.deepEqual(result.errors, [])
  assert.equal(result.projects.length, 38)
  assert.equal(result.publicPackages, 31)
  assert.equal(result.findings.length, 0)
})

test('CI performance baseline retains representative full and targeted cohorts', () => {
  const baseline = readJson(path.join(REPOSITORY_ROOT, 'governance/ci-performance-baseline.json'))
  assert.deepEqual(validateCiPerformanceBaseline(baseline), [])
  assert.deepEqual(baseline.observability.captured, [
    'run duration and variance',
    'per-job and per-step duration',
    'job queue time',
    'artifact upload/download step duration'
  ])
})

test('published declaration dependencies are explicit and backed by runtime modules', () => {
  const governed = projects.projects.filter(project => project.declarationDependencies)
  assert.deepEqual(
    governed.map(project => project.name),
    [
      '@bsv/paymail',
      '@bsv/auth-express-middleware',
      '@bsv/payment-express-middleware',
      '@bsv/overlay-express',
      '@bsv/wallet-relay',
      '@bsv/wallet-toolbox'
    ]
  )
  assert.ok(
    governed.every(
      project =>
        project.declarationDependencies.length === 1 &&
        project.declarationDependencies[0] === '@types/express'
    )
  )
  const authExpress = discoverWorkspaceProjects().find(
    project => project.manifest.name === '@bsv/auth-express-middleware'
  ).manifest
  assert.equal(authExpress.dependencies?.['@types/express'], undefined)
  assert.equal(authExpress.peerDependencies?.['@types/express'], '>=4.17.0 <6')

  const invalidProjects = structuredClone(projects)
  invalidProjects.projects.find(
    project => project.name === '@bsv/paymail'
  ).declarationDependencies = ['express']
  assert.match(
    validateProjectRegistry(invalidProjects, discoverWorkspaceProjects()).join('\n'),
    /invalid declaration dependency "express"/
  )

  const invalidDiscovered = structuredClone(discoverWorkspaceProjects())
  delete invalidDiscovered.find(project => project.manifest.name === '@bsv/paymail').manifest
    .dependencies['@types/express']
  delete invalidDiscovered.find(project => project.manifest.name === '@bsv/paymail').manifest
    .peerDependencies?.['@types/express']
  assert.match(
    validateProjectRegistry(projects, invalidDiscovered).join('\n'),
    /must publish declaration dependency @types\/express/
  )
})

test('every public package declares supported runtime and canonical support metadata', () => {
  const publicPackages = discoverWorkspaceProjects().filter(
    project => project.manifest.private !== true
  )

  assert.equal(publicPackages.length, 31)
  for (const project of publicPackages) {
    assert.equal(
      project.manifest.engines?.node,
      '>=22',
      `${project.path} must declare the exact supported Node.js runtime floor`
    )
    assert.equal(
      project.manifest.publishConfig?.access,
      'public',
      `${project.path} must explicitly publish with public access`
    )
    assert.deepEqual(
      project.manifest.repository,
      {
        type: 'git',
        url: 'git+https://github.com/bsv-blockchain/ts-stack.git',
        directory: project.path
      },
      `${project.path} must point consumers to its canonical monorepo source`
    )
    assert.equal(
      project.manifest.homepage,
      `https://github.com/bsv-blockchain/ts-stack/tree/main/${project.path}#readme`,
      `${project.path} must point consumers to its package README`
    )
    assert.deepEqual(
      project.manifest.bugs,
      { url: 'https://github.com/bsv-blockchain/ts-stack/issues' },
      `${project.path} must point consumers to the shared support tracker`
    )
    assert.ok(
      typeof project.manifest.author === 'string' && project.manifest.author.trim().length > 0,
      `${project.path} must identify an author or organization`
    )
    assert.ok(
      Array.isArray(project.manifest.keywords) &&
        project.manifest.keywords.some(keyword => keyword.toLowerCase() === 'bsv'),
      `${project.path} must expose searchable BSV package metadata`
    )
    assert.ok(
      typeof project.manifest.sideEffects === 'boolean' ||
        (Array.isArray(project.manifest.sideEffects) &&
          project.manifest.sideEffects.every(
            item => typeof item === 'string' && item.trim().length > 0
          )),
      `${project.path} must declare its tree-shaking side-effect contract`
    )
  }
})

test('every public package has canonical, machine-verified consumer profiles', () => {
  const publicProjects = projects.projects.filter(project => project.release === 'npm-oidc')
  assert.equal(publicProjects.length, 31)
  assert.ok(publicProjects.every(project => project.consumerProfiles.length > 0))
  assert.deepEqual(
    [...new Set(publicProjects.flatMap(project => project.consumerProfiles))].sort(),
    [
      'browser-bundler',
      'browser-esm',
      'cli',
      'node-cjs',
      'node-esm',
      'react-native-metro',
      'umd-global',
      'wasm-worker'
    ]
  )

  const unsorted = structuredClone(projects)
  unsorted.projects.find(project => project.name === '@bsv/sdk').consumerProfiles = [
    'node-esm',
    'browser-esm'
  ]
  assert.match(
    validateProjectRegistry(unsorted, discoverWorkspaceProjects()).join('\n'),
    /consumerProfiles must use canonical lexical order/
  )

  const unsupportedMode = structuredClone(discoverWorkspaceProjects())
  unsupportedMode.find(project => project.manifest.name === '@bsv/overlay-topics').manifest.scripts[
    'pack:check'
  ] = 'node check-package-artifact.mjs . --modes cjs'
  assert.match(
    validateProjectRegistry(projects, unsupportedMode).join('\n'),
    /consumer profile node-esm is not exercised by the pack:check modes/
  )

  const missingTarget = structuredClone(projects)
  missingTarget.projects.find(
    project => project.name === '@bsv/message-box-client'
  ).runtimeTargets = ['browser', 'node']
  assert.match(
    validateProjectRegistry(missingTarget, discoverWorkspaceProjects()).join('\n'),
    /consumer profile umd-global requires runtime target umd/
  )

  const sourceOnlyBrowser = structuredClone(discoverWorkspaceProjects())
  sourceOnlyBrowser.find(project => project.manifest.name === '@bsv/did').manifest.scripts[
    'test:browser'
  ] = 'node browser/source-only.mjs'
  assert.match(
    validateProjectRegistry(projects, sourceOnlyBrowser).join('\n'),
    /browser consumer profiles require an exact-package browser checker/
  )
})

test('contract findings are deterministic and match their recorded baseline', () => {
  const discovered = discoverWorkspaceProjects()
  const findings = collectContractFindings(projects, discovered)
  const baseline = readJson(path.join(healthDirectory, 'contract-baseline.json'))

  assert.deepEqual(compareContractBaseline(baseline, findings), [])
  assert.deepEqual(createContractBaseline(findings, '2026-07-26'), baseline)
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

  assert.deepEqual(validateExceptionRegistry(registry, '2026-07-25'), [
    'exception temporary-hold reason must be at least 20 characters',
    'exception temporary-hold must have one or more evidence references',
    'exception temporary-hold expired on 2026-07-24'
  ])
})

test('exception registry requires a current monthly review even when empty', () => {
  assert.deepEqual(
    validateExceptionRegistry(
      {
        schemaVersion: 1,
        lastReviewed: '2026-06-01',
        exceptions: []
      },
      '2026-07-25'
    ),
    ['exceptions.json monthly review is overdue: last reviewed 2026-06-01']
  )
  assert.deepEqual(
    validateExceptionRegistry(
      {
        schemaVersion: 1,
        lastReviewed: '2026-07-26',
        exceptions: []
      },
      '2026-07-25'
    ),
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
    validateExceptionRegistry(
      {
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
      },
      '2026-07-25',
      projects.ownerDefinitions
    ),
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

test('runtime, compiler, and database majors remain coordinated migrations', () => {
  const dependabot = fs.readFileSync(path.join(REPOSITORY_ROOT, '.github/dependabot.yml'), 'utf8')
  const exceptions = readJson(path.join(healthDirectory, 'exceptions.json'))
  const majorHolds = [
    ...dependabot.matchAll(
      /- dependency-name: ([^\n]+)\s+update-types:\s+- version-update:semver-major/g
    )
  ].map(match => match[1].replaceAll("'", '').trim())

  assert.equal(
    majorHolds.filter(dependency => dependency === 'typescript').length,
    2,
    'TypeScript compatibility-package majors must be held in root and infra npm scopes'
  )
  assert.equal(
    majorHolds.filter(dependency => dependency === '@typescript/native').length,
    2,
    'Native TypeScript compiler majors must be held in root and infra npm scopes'
  )
  assert.ok(majorHolds.includes('node'), 'Node majors require an owned runtime migration')
  assert.ok(majorHolds.includes('mysql'), 'MySQL majors require an owned data migration')
  assert.ok(majorHolds.includes('mongo'), 'MongoDB majors require an owned data migration')
  assert.ok(
    exceptions.exceptions.some(item => item.id === 'typescript-7-compiler-api-compatibility')
  )
})

test('workflows pin actions, deny implicit lifecycle scripts, and keep codegen read-only', () => {
  const workflowDirectory = path.join(REPOSITORY_ROOT, '.github/workflows')
  const workflowFiles = fs
    .readdirSync(workflowDirectory)
    .filter(file => /\.(?:yml|yaml)$/.test(file))
    .sort()
  assert.ok(workflowFiles.length > 0)

  for (const file of workflowFiles) {
    const source = fs.readFileSync(path.join(workflowDirectory, file), 'utf8')
    const actionReferences = [...source.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)]
      .map(match => match[1])
      .filter(reference => !reference.startsWith('./'))
    for (const reference of actionReferences) {
      assert.match(
        reference,
        /@[0-9a-f]{40}$/,
        `${file} action reference must use a full immutable commit SHA: ${reference}`
      )
    }

    const frozenInstalls = source.match(/pnpm install --frozen-lockfile[^\n]*/g) ?? []
    for (const install of frozenInstalls) {
      assert.match(
        install,
        /--ignore-scripts(?:\s|$)/,
        `${file} full-workspace install must deny implicit lifecycle scripts`
      )
    }
    assert.doesNotMatch(source, /(?:@latest|\bnpx\s+--yes\b|\bpip install\b|\bgo install\b)/)
  }

  const codegen = fs.readFileSync(path.join(workflowDirectory, 'codegen.yml'), 'utf8')
  assert.match(codegen, /^permissions: \{\}$/m)
  assert.doesNotMatch(codegen, /contents:\s*write|git-auto-commit|git push/)
  for (const lockfile of [
    'tools/codegen/go.sum',
    'tools/codegen/node/package-lock.json',
    'tools/codegen/uv.lock'
  ]) {
    assert.match(codegen, new RegExp(lockfile.replaceAll('.', '\\.')))
  }
})

test('CI and release typecheck the built cross-package declaration graph', () => {
  for (const [file, buildStep] of [
    ['ci.yml', '- name: Build workspace'],
    ['release.yaml', '- name: Build all packages']
  ]) {
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, '.github/workflows', file), 'utf8')
    const buildIndex = source.indexOf(buildStep)
    const typecheckIndex = source.indexOf('- name: Typecheck workspace')

    assert.notEqual(buildIndex, -1, `${file} must retain its workspace build`)
    assert.ok(typecheckIndex > buildIndex, `${file} must typecheck after building package outputs`)
    if (file === 'ci.yml') {
      assert.match(source.slice(typecheckIndex), /AFFECTED_PROJECTS:/)
      assert.match(source.slice(typecheckIndex), /pnpm -r --if-present.*run typecheck/)
    } else {
      assert.match(source.slice(typecheckIndex), /run: pnpm typecheck/)
    }
  }
})
