import assert from 'node:assert/strict'
import test from 'node:test'

import {
  changedLockfileImporters,
  conformanceIsAffected,
  docsAreAffected,
  lockfileImporterSections,
  selectInfraComponents,
  selectRuntimeComponents,
  selectWorkspaceScope
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

test('documentation and QA policy changes do not fan out package tests', () => {
  assert.deepEqual(
    selectWorkspaceScope(projects, [
      'packages/direct/README.md',
      'governance/mutation-testing/policy.json',
      '.github/workflows/ci.yml'
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
})

test('infrastructure scope never rebuilds unrelated images for workflow-only changes', () => {
  assert.deepEqual(selectInfraComponents(['.github/workflows/ci.yml']), [])
  assert.deepEqual(
    selectInfraComponents(['infra/message-box-server/src/index.ts']).map(entry => entry.component),
    ['message-box-server']
  )
  assert.equal(selectInfraComponents(['governance/container-images.json']).length, 8)
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
  assert.equal(selectRuntimeComponents(['scripts/container-runtime-contract.mjs']).length, 7)
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
