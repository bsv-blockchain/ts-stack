import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  compareCoveragePaths,
  validateShardUnion
} from './output-knowledge-coverage-validation.mjs'

const directory = fileURLToPath(
  new URL('../packages/application/output-knowledge/', import.meta.url)
)
const identity = { sha: 'a'.repeat(40), run: '1', attempt: '1', configuration: 'b'.repeat(64) }
const expected = ['test/a.test.ts', 'test/b.test.ts']

test('canonical path ordering retains deterministic code units and the original input array', () => {
  const input = ['é', 'a', '😀', 'A', '_', '-']
  const before = [...input]
  assert.deepEqual(input.toSorted(compareCoveragePaths), ['-', 'A', '_', 'a', 'é', '😀'])
  assert.deepEqual(input, before)
  assert.equal(compareCoveragePaths('same', 'same'), 0)
  assert.equal(compareCoveragePaths('a', 'A'), 1)
  assert.equal(compareCoveragePaths('A', 'a'), -1)
})

function evidence() {
  return expected.map((name, index) => ({
    manifest: {
      identity: structuredClone(identity),
      shard: index + 1,
      total: 2,
      allTests: [...expected],
      selectedTests: [name]
    },
    results: {
      success: true,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      testResults: [
        {
          name: path.join(directory, name),
          status: 'passed',
          assertionResults: [{ status: 'passed' }]
        }
      ]
    }
  }))
}

test('complete same-run shards establish a disjoint complete original test union', () => {
  assert.doesNotThrow(() => validateShardUnion(evidence(), identity, expected))
  const reversed = evidence().reverse()
  assert.doesNotThrow(() => validateShardUnion(reversed, identity, expected))
})

test('missing, duplicate, extra, changed-source and other-attempt shards fail closed', () => {
  assert.throws(() => validateShardUnion(evidence().slice(0, 1), identity, expected))
  for (const mutate of [
    shards => {
      shards[1] = structuredClone(shards[0])
    },
    shards => {
      shards[1].manifest.selectedTests = ['test/extra.test.ts']
    },
    shards => {
      shards[1].manifest.allTests.pop()
    },
    shards => {
      shards[1].manifest.identity.sha = 'c'.repeat(40)
    },
    shards => {
      shards[1].manifest.identity.attempt = '2'
    },
    shards => {
      shards[1].manifest.identity.run = '2'
    },
    shards => {
      shards[1].manifest.identity.configuration = 'c'.repeat(64)
    },
    shards => {
      shards[1].manifest.total = 3
    }
  ]) {
    const shards = evidence()
    mutate(shards)
    assert.throws(() => validateShardUnion(shards, identity, expected))
  }
})

test('failed, missing, pending, todo and unexecuted assertions cannot qualify', () => {
  for (const mutate of [
    results => {
      results.success = false
    },
    results => {
      results.numFailedTests = 1
    },
    results => {
      results.numPendingTests = 1
    },
    results => {
      results.numTodoTests = 1
    },
    results => {
      results.numPassedTests = 0
    },
    results => {
      results.testResults = []
    },
    results => {
      results.testResults[0].status = 'failed'
    },
    results => {
      results.testResults[0].assertionResults = []
    },
    results => {
      results.testResults[0].assertionResults[0].status = 'pending'
    }
  ]) {
    const shards = evidence()
    mutate(shards[1].results)
    assert.throws(() => validateShardUnion(shards, identity, expected))
  }
})
