import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './mutation-testing.mjs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { canonicalInventory, targetSources } from './mutation-final-qualification.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix
} from './mutation-partitions.mjs'

test('primary sync execution retains every original file/range, full configuration and future helper', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-sync']
  const parts = partitionMutationTarget('wallet-snapshot-sync', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['session', 'checkpoint', 'copy', 'storage', 'primary']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
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
    tuples.push(
      ...(
        await canonicalInventory(
          directory,
          targetSources(REPOSITORY_ROOT, part.target),
          part.target.mutate
        )
      ).map(tuple)
    )
  }
  const original = (
    await canonicalInventory(directory, targetSources(REPOSITORY_ROOT, canonical), canonical.mutate)
  ).map(tuple)
  assert.ok(original.length > 0)
  assert.equal(new Set(tuples).size, tuples.length)
  assert.deepEqual(tuples.sort(), original.sort())
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
