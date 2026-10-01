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
test('actual pinned SDKAuth partitions exhaust the original canonical mutant inventory and complete test configuration', async () => {
  const id = 'sdk-auth-http',
    target = buildMutationTargets(root)[id]
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
