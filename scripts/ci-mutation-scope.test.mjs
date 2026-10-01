import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyMutationScope,
  dependencyEvidence,
  mutationScope,
  readSnapshot,
  reviewedRuntimeInputs
} from './ci-mutation-scope.mjs'

import { targets, policy, snapshot } from './ci-integration/fixtures/dependency-snapshots.mjs'

const classify = (files, dependency, legacyRequired = []) =>
  classifyMutationScope({ targets, policy, changedFiles: files, dependency, legacyRequired })

test('docs-only PRs retain empty critical scope and honestly defer unaffected noncritical work', () => {
  const result = classify(['docs/reference/guide.md'], dependencyEvidence([snapshot()]))
  assert.deepEqual(result.required, [])
  assert.deepEqual(result.deferred, ['isolated'])
  assert.deepEqual(result.newlyDeferred, [])
  assert.deepEqual(result.outside, ['producer', 'consumer', 'optional'])
})

test('package helpers, fixtures and manifests select all affected target owners', () => {
  const dependency = dependencyEvidence([snapshot()])
  for (const file of [
    'packages/producer/src/helper.ts',
    'packages/producer/tests/fixture.json',
    'packages/producer/package.json'
  ]) {
    assert.deepEqual(classify([file], dependency).required, ['producer'])
  }
  assert.deepEqual(classify(['packages/isolated/src/input.ts'], dependency).required, ['isolated'])
})

test('base/head reverse closure retains removed dev, peer and optional dependencies', () => {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    const before = snapshot({
      manifests: {
        consumer: { name: 'consumer', [field]: { producer: 'workspace:^' } },
        optional: { name: 'optional', dependencies: { consumer: 'workspace:^' } }
      }
    })
    const dependency = dependencyEvidence([before, snapshot()])
    assert.deepEqual(classify(['packages/producer/src/helper.ts'], dependency).required, [
      'producer',
      'consumer',
      'optional'
    ])
  }
})

test('unknown lock resolution, shared controls, unowned paths and absent base retain every target', () => {
  const dependency = dependencyEvidence([snapshot()])
  for (const file of [
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    'scripts/mutation-testing.mjs',
    'shared/runtime.ts'
  ])
    assert.deepEqual(classify([file], dependency).required, Object.keys(targets))
  const unresolved = mutationScope('/tmp', { base: 'missing', targets, policy })
  assert.deepEqual(unresolved.required, Object.keys(targets))
  assert.equal(unresolved.deferred.length, 0)
  assert.match(unresolved.unknownReasons[0], /Unresolved classification/)
})

test('prior critical obligations stay required while only proven-unaffected noncritical ones newly defer', () => {
  const result = classify(['packages/producer/src/input.ts'], dependencyEvidence([snapshot()]), [
    'consumer',
    'isolated'
  ])
  assert.deepEqual(result.required, ['producer', 'consumer'])
  assert.deepEqual(result.newlyDeferred, ['isolated'])
  const unknown = structuredClone(policy)
  unknown.targets.find(target => target.id === 'isolated').risk = 'unknown'
  const failClosed = classifyMutationScope({
    targets,
    policy: unknown,
    changedFiles: [],
    dependency: dependencyEvidence([snapshot()])
  })
  assert.deepEqual(failClosed.required, ['isolated'])
})

test('the reviewed air-gap parent-walking loader binds the exact source and shared corpus', () => {
  const snapshot = readSnapshot(new URL('..', import.meta.url).pathname, 'HEAD')
  const file = 'packages/helpers/air-gap/tests/helpers.ts'
  const paths = new Set(snapshot.records.map(record => record.file))
  const source = snapshot.files.get(file)
  assert.deepEqual(reviewedRuntimeInputs(file, source, paths), [
    'conformance/vectors/transport/air-gap-optical.json'
  ])
  assert.equal(reviewedRuntimeInputs(file, source + '\\nchanged', paths), undefined)
  paths.add('packages/helpers/air-gap/conformance/vectors/transport/air-gap-optical.json')
  assert.equal(reviewedRuntimeInputs(file, source, paths), undefined)
  paths.delete('packages/helpers/air-gap/conformance/vectors/transport/air-gap-optical.json')
  paths.delete('conformance/vectors/transport/air-gap-optical.json')
  assert.equal(reviewedRuntimeInputs(file, source, paths), undefined)
})

test('standalone-only scheduler changes preserve critical obligations and defer proven-unaffected high targets', () => {
  const result = classify(
    ['.github/workflows/mutation-tests.yml'],
    dependencyEvidence([snapshot()]),
    Object.keys(targets)
  )
  assert.deepEqual(result.required, ['producer', 'consumer', 'optional'])
  assert.deepEqual(result.newlyDeferred, ['isolated'])
  assert.deepEqual(result.unknownReasons, [])
})
