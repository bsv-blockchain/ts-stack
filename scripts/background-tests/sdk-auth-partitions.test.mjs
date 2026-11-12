import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'
import {
  partitionMutationTarget,
  canonicalMutationPartitions,
  applyPartitionComponentTests
} from '../mutation-partitions.mjs'
import { targetEvidence } from '../mutation-final-qualification.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tuple = mutant =>
  JSON.stringify([
    mutant.fileName,
    mutant.mutatorName,
    mutant.replacement,
    mutant.location.start.line,
    mutant.location.start.column,
    mutant.location.end.line,
    mutant.location.end.column,
    mutant.status,
    mutant.statusReason
  ])
const targets = buildMutationTargets(root)
// Every target that executes in parts, whether by an explicit or an automatic
// plan, must replay to exactly its canonical inventory.
const partitioned = Object.keys(targets).filter(
  id => partitionMutationTarget(id, targets[id]).length > 1
)
test('admitted scheduling stays within the original matrix ceiling and keeps every target', () => {
  const matrix = Object.keys(targets).flatMap(id =>
    partitionMutationTarget(id, targets[id]).map(part => ({ id, part: part.id }))
  )
  assert.ok(matrix.length <= 256)
  assert.deepEqual([...new Set(matrix.map(row => row.id))].sort(), Object.keys(targets).sort())
})
for (const id of partitioned)
  test(`actual pinned ${id} partitions exhaust the original canonical mutant inventory and complete test configuration`, async () => {
    const target = targets[id]
    const canonical = await targetEvidence(root, target, id)
    const bootstrap =
      id === 'wallet-retained-snapshot'
        ? applyPartitionComponentTests(
            canonicalMutationPartitions(id, target).find(part => part.id === 'sqlite-bootstrap'),
            target.componentTestPartitions['sqlite-bootstrap'],
            file => readFileSync(join(root, target.packageDirectory, file))
          ).target
        : undefined
    const parts = await Promise.all(
      partitionMutationTarget(id, target).map(async part => ({
        ...part,
        evidence: await targetEvidence(root, part.target, id, part.id)
      }))
    )
    const actual = parts.flatMap(part => part.evidence.mutants.map(tuple)).sort()
    assert.deepEqual(actual, canonical.mutants.map(tuple).sort())
    assert.equal(new Set(actual).size, actual.length)
    const children = parts.filter(
      part => id === 'wallet-retained-snapshot' && /^sqlite-bootstrap-\d{3}$/.test(part.id)
    )
    assert.equal(children.length, bootstrap === undefined ? 0 : 6)
    for (const part of parts) {
      const component = children.includes(part)
      assert.deepEqual(
        part.target.runnerOptions,
        component ? bootstrap.runnerOptions : target.runnerOptions
      )
      const expectedConfig = component
        ? {
            ...canonical.config,
            jest: {
              ...canonical.config.jest,
              config: {
                ...canonical.config.jest.config,
                testMatch: bootstrap.runnerOptions.jest.config.testMatch
              }
            }
          }
        : canonical.config
      const comparable = ({ mutate: _mutate, jsonReporter: _reporter, ...config }) => config
      assert.deepEqual(comparable(part.evidence.config), comparable(expectedConfig))
    }
  })
