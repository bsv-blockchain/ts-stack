import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  changedLockfileImporters,
  conformanceIsAffected,
  dependencyClosure,
  docsAreAffected,
  lockfileAffectedImporters,
  lockfileImporterSections,
  mutationTargetProjectNames,
  projectRegistryChanges,
  selectInfraComponents,
  selectRuntimeComponents,
  selectWorkspaceScope,
  workspaceChangeIsResolutionOnly
} from './ci-affected-scope.mjs'

const projects = [
  {
    name: '@bsv/ts-stack',
    path: '.',
    manifest: { name: '@bsv/ts-stack' }
  },
  {
    name: '@bsv/base',
    path: 'packages/base',
    manifest: { name: '@bsv/base' }
  },
  {
    name: '@bsv/direct',
    path: 'packages/direct',
    manifest: { name: '@bsv/direct', dependencies: { '@bsv/base': 'workspace:^' } }
  },
  {
    name: '@bsv/consumer',
    path: 'packages/consumer',
    manifest: { name: '@bsv/consumer', peerDependencies: { '@bsv/direct': '^1.0.0' } }
  },
  {
    name: '@bsv/unrelated',
    path: 'packages/unrelated',
    manifest: { name: '@bsv/unrelated' }
  }
]

test('lockfile importer parsing identifies only changed dependency snapshots', () => {
  const base = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      tool: 1\n\n  packages/direct:\n    devDependencies:\n      fast-check: 1\n\npackages:\n`
  const head = base.replace('fast-check: 1', 'fast-check: 2')
  assert.deepEqual([...lockfileImporterSections(base).keys()], ['.', 'packages/direct'])
  assert.deepEqual(changedLockfileImporters(base, head), ['packages/direct'])
})

test('workspace scope tests direct changes, typechecks dependents, and builds dependencies', () => {
  const scope = selectWorkspaceScope(projects, ['packages/direct/src/index.ts'])
  assert.deepEqual(scope.direct, ['@bsv/direct'])
  assert.deepEqual(scope.affected, ['@bsv/consumer', '@bsv/direct'])
  assert.deepEqual(scope.build, ['@bsv/base', '@bsv/consumer', '@bsv/direct'])
})

test('workspace scope directly selects packages that compile a shared source root', () => {
  const sharedProjects = [
    ...projects,
    {
      name: '@bsv/direct-browser',
      path: 'packages/direct/browser',
      sourceRoots: ['packages/direct/src'],
      manifest: { name: '@bsv/direct-browser' }
    },
    {
      name: '@bsv/direct-mobile',
      path: 'packages/direct/mobile',
      sourceRoots: ['packages/direct/src'],
      manifest: { name: '@bsv/direct-mobile' }
    }
  ]

  const scope = selectWorkspaceScope(sharedProjects, ['packages/direct/src/index.ts'])

  assert.deepEqual(scope.direct, ['@bsv/direct', '@bsv/direct-browser', '@bsv/direct-mobile'])
})

test('documentation and QA policy changes do not fan out package tests', () => {
  assert.deepEqual(
    selectWorkspaceScope(projects, [
      'packages/direct/README.md',
      'governance/mutation-testing/policy.json'
    ]),
    { direct: [], affected: [], build: [] }
  )
})

test('lock-only package changes select that importer and its dependents', () => {
  const scope = selectWorkspaceScope(projects, ['pnpm-lock.yaml'], ['packages/direct'])
  assert.deepEqual(scope.direct, ['@bsv/direct'])
  assert.deepEqual(scope.affected, ['@bsv/consumer', '@bsv/direct'])
})

test('root toolchain changes deliberately retain full workspace coverage', () => {
  assert.deepEqual(selectWorkspaceScope(projects, ['tsconfig.base.json']).direct, [
    '@bsv/base',
    '@bsv/consumer',
    '@bsv/direct',
    '@bsv/unrelated'
  ])
  assert.equal(
    selectWorkspaceScope(projects, ['governance/repository-health/projects.json']).direct.length,
    4
  )
  // Package tsconfigs extend the shared compiler configuration.
  assert.equal(
    selectWorkspaceScope(projects, ['config/typescript/node-library.json']).direct.length,
    4
  )
})

test('infrastructure scope never rebuilds unrelated images for workflow-only changes', () => {
  assert.deepEqual(selectInfraComponents(['.github/workflows/docs-deploy.yml']), [])
  assert.deepEqual(
    selectInfraComponents(['infra/message-box-server/src/index.ts']).map(entry => entry.component),
    ['message-box-server']
  )
  assert.equal(selectInfraComponents(['governance/container-images.json']).length, 9)
})

test('runtime image scope follows component contexts and wallet-image consumers', () => {
  assert.deepEqual(
    selectRuntimeComponents(['.github/workflows/container-runtime-contract.yml']),
    []
  )
  assert.deepEqual(
    selectRuntimeComponents(['infra/chaintracks-server/src/index.ts']).map(entry => entry.name),
    ['chaintracks-server']
  )
  assert.deepEqual(
    selectRuntimeComponents(['infra/wallet-infra/Dockerfile']).map(entry => entry.name),
    [
      'message-box-server',
      'overlay-server',
      'uhrp-server-basic',
      'uhrp-server-cloud-bucket',
      'wallet-infra'
    ]
  )
  assert.equal(selectRuntimeComponents(['scripts/container-runtime-contract.mjs']).length, 8)
  assert.deepEqual(selectInfraComponents(['scripts/container-runtime-contract.mjs']), [])
  assert.deepEqual(selectRuntimeComponents(['governance/container-images.json']), [])
  assert.deepEqual(selectRuntimeComponents(['packages/wallet/wallet-toolbox/src/index.ts']), [])
})

test('docs and conformance work are selected from their actual inputs', () => {
  assert.equal(docsAreAffected(['packages/direct/README.md']), true)
  assert.equal(docsAreAffected(['packages/direct/src/index.ts']), false)
  assert.equal(conformanceIsAffected(['conformance/vectors/example.json']), true)
  assert.equal(conformanceIsAffected(['packages/direct/src/index.ts']), false)
})

test('shared CI execution and result gates select the complete governed workspace', () => {
  for (const file of ['.github/workflows/ci.yml', 'scripts/ci-result-gate.mjs']) {
    assert.equal(selectWorkspaceScope(projects, [file]).direct.length, 4)
  }
  assert.equal(selectInfraComponents(['.github/workflows/ci.yml']).length, 9)
})

test('required mutation targets add their built dependencies without widening package tests', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const registry = JSON.parse(
    readFileSync(path.join(root, 'governance/repository-health/projects.json'), 'utf8')
  )
  const realProjects = registry.projects.map(project => {
    const manifest = JSON.parse(readFileSync(path.join(root, project.path, 'package.json'), 'utf8'))
    return {
      ...project,
      path: project.path.split(path.sep).join('/'),
      manifest,
      name: manifest.name
    }
  })
  const targets = buildMutationTargets(root)
  const names = mutationTargetProjectNames(realProjects, targets, [
    'amount-format',
    'btms-permission'
  ])
  assert.deepEqual(names, ['@bsv/amountinator', '@bsv/btms-permission-module'])
  const scope = selectWorkspaceScope(realProjects, ['packages/overlays/topics/package.json'])
  assert.equal(scope.affected.includes('@bsv/amountinator'), false)
  assert.equal(scope.build.includes('@bsv/wallet-toolbox-client'), false)
  assert.equal(scope.build.includes('@bsv/btms'), false)
  const build = dependencyClosure(realProjects, [...scope.build, ...names])
  assert.equal(build.includes('@bsv/wallet-toolbox-client'), true)
  assert.equal(build.includes('@bsv/btms'), true)
  assert.equal(build.includes('@bsv/amountinator'), true)
})

function lockfile({
  settings = 'autoInstallPeers: true',
  leaf = '1.0.0',
  integrity = 'sha512-a'
} = {}) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    `  ${settings}`,
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      tool:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '',
    '  packages/direct:',
    '    dependencies:',
    "      '@bsv/base':",
    '        specifier: workspace:^',
    '        version: link:../base',
    '      http-client:',
    '        specifier: 2.0.0',
    '        version: 2.0.0',
    '',
    '  packages/unrelated:',
    '    dependencies:',
    '      tool:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '',
    'packages:',
    '',
    '  http-client@2.0.0:',
    '    resolution: {integrity: sha512-b}',
    '',
    `  redirects@${leaf}:`,
    `    resolution: {integrity: ${integrity}}`,
    '',
    '  tool@1.0.0:',
    '    resolution: {integrity: sha512-c}',
    '',
    'snapshots:',
    '',
    '  http-client@2.0.0:',
    '    dependencies:',
    `      redirects: ${leaf}`,
    '',
    `  redirects@${leaf}: {}`,
    '',
    '  tool@1.0.0: {}',
    ''
  ].join('\n')
}

test('lockfile analysis selects importers that reach a changed transitive package', () => {
  // An indirect upgrade changes no importer section, yet changes what the importer installs.
  assert.deepEqual(changedLockfileImporters(lockfile(), lockfile({ leaf: '1.0.1' })), [])
  assert.deepEqual(lockfileAffectedImporters(lockfile(), lockfile({ leaf: '1.0.1' })), [
    'packages/direct'
  ])
  // A republished tarball under the same version still changes the install.
  assert.deepEqual(lockfileAffectedImporters(lockfile(), lockfile({ integrity: 'sha512-z' })), [
    'packages/direct'
  ])
  assert.deepEqual(lockfileAffectedImporters(lockfile(), lockfile()), [])
  // Lockfile settings can change every install, so they select the root.
  assert.deepEqual(
    lockfileAffectedImporters(lockfile(), lockfile({ settings: 'autoInstallPeers: false' })),
    ['.']
  )
})

test('nested lockfile importers select their most specific project', () => {
  const nested = [
    ...projects,
    {
      name: '@bsv/direct-mobile',
      path: 'packages/direct/mobile',
      manifest: { name: '@bsv/direct-mobile' }
    }
  ]
  assert.deepEqual(
    selectWorkspaceScope(nested, ['pnpm-lock.yaml'], ['packages/direct/mobile']).direct,
    ['@bsv/direct-mobile']
  )
  assert.deepEqual(
    selectWorkspaceScope(nested, ['pnpm-lock.yaml'], ['packages/direct/docs/examples']).direct,
    ['@bsv/direct']
  )
})

test('resolution-only workspace changes defer to the lockfile; other settings stay global', () => {
  const base = 'packages:\n  - packages/*\noverrides:\n  redirects@<1.0.1: 1.0.1\n'
  assert.equal(
    workspaceChangeIsResolutionOnly(base, base.replace('1.0.1: 1.0.1', '1.0.2: 1.0.2')),
    true
  )
  assert.equal(
    workspaceChangeIsResolutionOnly(
      base,
      `${base}patchedDependencies:\n  tool@1.0.0: patches/tool.patch\n`
    ),
    true
  )
  assert.equal(
    workspaceChangeIsResolutionOnly(
      `# old note\n${base}`,
      `# new note\n${base}`.replace('  redirects', '# why\n  redirects')
    ),
    true
  )
  assert.equal(workspaceChangeIsResolutionOnly(base, base.replace('packages/*', 'apps/*')), false)
  assert.equal(workspaceChangeIsResolutionOnly(base, `${base}nodeLinker: hoisted\n`), false)
  assert.equal(
    selectWorkspaceScope(projects, ['pnpm-workspace.yaml', 'pnpm-lock.yaml'], [], {
      narrowed: ['pnpm-workspace.yaml']
    }).direct.length,
    0
  )
})

test('project registry entry changes select only those projects', () => {
  const registry = {
    schemaVersion: 1,
    profiles: { library: {} },
    projects: [
      { path: '.', name: '@bsv/ts-stack' },
      { path: 'packages/direct', profile: 'library' },
      { path: 'packages/unrelated', profile: 'library' }
    ]
  }
  const edit = change => JSON.stringify(change(structuredClone(registry)))
  const base = JSON.stringify(registry)

  const added = projectRegistryChanges(
    base,
    edit(r => (r.projects.push({ path: 'packages/base', profile: 'library' }), r))
  )
  assert.deepEqual(added, { full: false, paths: ['packages/base'] })
  assert.deepEqual(
    selectWorkspaceScope(projects, ['governance/repository-health/projects.json'], [], {
      narrowed: ['governance/repository-health/projects.json'],
      projectPaths: added.paths
    }).direct,
    ['@bsv/base']
  )
  assert.deepEqual(
    projectRegistryChanges(
      base,
      edit(r => ((r.projects[1].owner = 'wallet'), r))
    ),
    { full: false, paths: ['packages/direct'] }
  )
  // Shared definitions, the root entry, and unreadable input keep the whole workspace.
  assert.equal(
    projectRegistryChanges(
      base,
      edit(r => ((r.profiles.library.x = 1), r))
    ).full,
    true
  )
  assert.equal(
    projectRegistryChanges(
      base,
      edit(r => ((r.projects[0].owner = 'x'), r))
    ).full,
    true
  )
  assert.equal(projectRegistryChanges('', base).full, true)
})
