import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'
import { partitionMutationTarget } from '../mutation-partitions.mjs'
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
for (const id of ['sdk-auth-http', 'wallet-retained-snapshot'].filter(id =>
  Object.hasOwn(targets, id)
))
  test(`actual pinned ${id} partitions exhaust the original canonical mutant inventory and complete test configuration`, async () => {
    const target = targets[id]
    const canonical = await targetEvidence(root, target, id)
    const parts = await Promise.all(
      partitionMutationTarget(id, target).map(async part => ({
        ...part,
        evidence: await targetEvidence(root, part.target, id, part.id)
      }))
    )
    const actual = parts.flatMap(part => part.evidence.mutants.map(tuple)).sort()
    assert.deepEqual(actual, canonical.mutants.map(tuple).sort())
    assert.equal(new Set(actual).size, actual.length)
    for (const part of parts) {
      assert.deepEqual(part.target.runnerOptions, target.runnerOptions)
      const comparable = ({ mutate: _mutate, jsonReporter: _reporter, ...config }) => config
      assert.deepEqual(comparable(part.evidence.config), comparable(canonical.config))
    }
  })
