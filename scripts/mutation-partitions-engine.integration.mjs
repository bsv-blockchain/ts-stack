import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import fs from 'node:fs'
import { REPOSITORY_ROOT } from './mutation-testing.mjs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { canonicalInventory, targetSources } from './mutation-final-qualification.mjs'
import {
  partitionMutationTarget,
  canonicalMutationPartitions,
  selectedMutationPartition,
  mutationExecutionMatrix,
  applyPartitionComponentTests
} from './mutation-partitions.mjs'

function lexicalCompare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

async function* inventories(directory, parts) {
  for (const part of parts)
    yield canonicalInventory(
      directory,
      targetSources(REPOSITORY_ROOT, part.target),
      part.target.mutate
    )
}

test('primary sync execution retains every original file/range, full configuration and future helper', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-sync']
  const parts = partitionMutationTarget('wallet-snapshot-sync', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['session', 'checkpoint', 'copy', 'storage', 'primary']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).toSorted(lexicalCompare),
    [...canonical.mutate].toSorted(lexicalCompare)
  )
  const owners = new Map()
  const tuples = []
  const directory = join(REPOSITORY_ROOT, canonical.packageDirectory)
  const tuple = mutant =>
    JSON.stringify({
      file: mutant.fileName,
      name: mutant.mutatorName,
      location: mutant.location,
      replacement: mutant.replacement
    })
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
    for (const specification of part.target.mutate) {
      const file = specification.replace(/:\d+(?:-\d+)?$/, '')
      assert.ok(!owners.has(file) || owners.get(file) === part.id)
      owners.set(file, part.id)
    }
  }
  for await (const mutants of inventories(directory, parts)) tuples.push(...mutants.map(tuple))
  const original = (
    await canonicalInventory(directory, targetSources(REPOSITORY_ROOT, canonical), canonical.mutate)
  ).map(tuple)
  assert.ok(original.length > 0)
  assert.equal(new Set(tuples).size, tuples.length)
  assert.deepEqual(tuples.toSorted(lexicalCompare), original.toSorted(lexicalCompare))
  assert.equal(owners.get('src/storage/WalletStorageManager.ts'), 'primary')
  assert.equal(owners.get('src/storage/StorageKnex.ts'), 'storage')
  assert.equal(owners.get('src/storage/snapshot/SnapshotSync.ts'), 'session')
  const helper = 'src/storage/snapshot/FuturePrimaryHelper.ts'
  const future = partitionMutationTarget('wallet-snapshot-sync', {
    ...canonical,
    mutate: [...canonical.mutate, helper]
  })
  assert.deepEqual(future[0].target.mutate, [...parts[0].target.mutate, helper])
  assert.equal(selectedMutationPartition('wallet-snapshot-sync', canonical), canonical)
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.ok(mutationExecutionMatrix(Object.keys(targets), targets).include.length <= 256)
})

test('installed mutation engine retains the complete canonical serializer inventory exactly once', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-portable-canonical-chunks']
  const parts = partitionMutationTarget('wallet-portable-canonical-chunks', canonical)
  const directory = join(REPOSITORY_ROOT, canonical.packageDirectory)
  const tuple = mutant =>
    JSON.stringify({
      file: mutant.fileName,
      name: mutant.mutatorName,
      location: mutant.location,
      replacement: mutant.replacement
    })
  const tuples = []
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  }
  for await (const mutants of inventories(directory, parts)) tuples.push(...mutants.map(tuple))
  const original = (
    await canonicalInventory(directory, targetSources(REPOSITORY_ROOT, canonical), canonical.mutate)
  ).map(tuple)
  assert.ok(original.length > 0)
  assert.equal(new Set(tuples).size, tuples.length)
  assert.deepEqual(tuples.toSorted(lexicalCompare), original.toSorted(lexicalCompare))
})

test('every generated refinement retains the actual full canonical inventory and identical complete runner exactly once', async () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    plan = JSON.parse(
      fs.readFileSync(
        join(REPOSITORY_ROOT, 'governance/mutation-testing/execution-partitions.json'),
        'utf8'
      )
    ),
    tuple = mutant =>
      JSON.stringify({
        file: mutant.fileName,
        name: mutant.mutatorName,
        location: mutant.location,
        replacement: mutant.replacement
      })
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.engine, '9.6.1')
  let count = 0
  for (const unit of plan.units) {
    const canonical = targets[unit.target],
      originalBase = canonicalMutationPartitions(unit.target, canonical).find(
        part => part.id === unit.existingPartition
      ),
      base =
        unit.target === 'wallet-retained-snapshot' && unit.existingPartition === 'sqlite-bootstrap'
          ? applyPartitionComponentTests(
              originalBase,
              canonical.componentTestPartitions['sqlite-bootstrap'],
              file => fs.readFileSync(join(REPOSITORY_ROOT, canonical.packageDirectory, file))
            )
          : originalBase,
      ids = new Set(unit.parts.map(part => part.id)),
      parts = partitionMutationTarget(unit.target, canonical).filter(part => ids.has(part.id)),
      directory = join(REPOSITORY_ROOT, canonical.packageDirectory),
      sources = targetSources(REPOSITORY_ROOT, base.target),
      expected = (await canonicalInventory(directory, sources, base.target.mutate)).map(tuple),
      actual = [],
      files = new Set()
    assert.equal(parts.length, unit.parts.length)
    for (const part of parts) {
      if (base === originalBase) assert.equal(part.target.runnerOptions, canonical.runnerOptions)
      else assert.deepEqual(part.target.runnerOptions, base.target.runnerOptions)
      assert.deepEqual(part.target, { ...base.target, mutate: part.target.mutate })
      const partSources = targetSources(REPOSITORY_ROOT, part.target)
      for (const [file, source] of partSources) {
        assert.equal(
          source,
          sources.get(file),
          'Complete source bytes changed inside an execution range'
        )
        files.add(file)
      }
      actual.push(
        ...(await canonicalInventory(directory, partSources, part.target.mutate)).map(tuple)
      )
    }
    assert.equal(new Set(actual).size, actual.length, 'Cross-part canonical mutant overlap')
    assert.deepEqual(actual.toSorted(lexicalCompare), expected.toSorted(lexicalCompare))
    assert.deepEqual([...files].sort(lexicalCompare), [...sources.keys()].sort(lexicalCompare))
    assert.equal(actual.length, unit.canonicalCount)
    count += actual.length
  }
  assert.equal(
    count,
    plan.units.reduce((sum, unit) => sum + unit.canonicalCount, 0)
  )
  const matrix = mutationExecutionMatrix(Object.keys(targets), targets)
  assert.equal(matrix.include.length, plan.executionRows)
  assert.ok(matrix.include.length <= 256)
})
