import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  APPLICATION_COVERAGE_SHARDS,
  compareCoveragePaths,
  validateShardUnion
} from './output-knowledge-coverage-validation.mjs'

const directory = fileURLToPath(
  new URL('../packages/application/output-knowledge/', import.meta.url)
)
const identity = { sha: 'a'.repeat(40), run: '1', attempt: '1', configuration: 'b'.repeat(64) }
const expected = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts']

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
      total: APPLICATION_COVERAGE_SHARDS,
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

test('a missing or relabeled fourth shard cannot qualify a complete campaign', () => {
  const missing = evidence().slice(0, -1)
  assert.throws(() => validateShardUnion(missing, identity, expected))
  for (const id of [0, 5, 1.5, '4', NaN]) {
    const changed = evidence()
    changed.at(-1).manifest.shard = id
    assert.throws(() => validateShardUnion(changed, identity, expected))
  }
})
import {
  applicationCoverageBatches,
  mergeCoverageBatchResults
} from './output-knowledge-coverage-validation.mjs'

const batchSelected = [
  'test/a.test.ts',
  'test/private-purchase-alias-coordinator.property.test.ts',
  'test/private-purchase-alias-disclosure.property.test.ts',
  'test/z.test.ts'
]
function batchEvidence() {
  return applicationCoverageBatches(batchSelected).map(plan => ({
    manifest: { identity: structuredClone(identity), ...structuredClone(plan) },
    results: {
      ...structuredClone(evidence()[0].results),
      numTotalTests: plan.selectedTests.length,
      numPassedTests: plan.selectedTests.length,
      numTotalTestSuites: plan.selectedTests.length,
      numPassedTestSuites: plan.selectedTests.length,
      testResults: plan.selectedTests.map(name => ({
        name: path.join(directory, name),
        status: 'passed',
        assertionResults: [{ status: 'passed' }]
      }))
    }
  }))
}

test('fresh serial placement preserves the exact discovered shard without mutating discovery', () => {
  const before = [...batchSelected]
  assert.deepEqual(applicationCoverageBatches(batchSelected), [
    {
      id: 'private-purchase-alias-coordinator.property',
      selectedTests: [batchSelected[1]],
      runInBand: true
    },
    {
      id: 'private-purchase-alias-disclosure.property',
      selectedTests: [batchSelected[2]],
      runInBand: true
    },
    { id: 'ordinary', selectedTests: [batchSelected[0], batchSelected[3]], runInBand: false }
  ])
  assert.deepEqual(batchSelected, before)
  assert.deepEqual(applicationCoverageBatches(['test/a.test.ts']), [
    { id: 'ordinary', selectedTests: ['test/a.test.ts'], runInBand: false }
  ])
  assert.equal(applicationCoverageBatches([batchSelected[1]]).length, 1)
  for (const selected of [
    [],
    ['test/a.test.ts', 'test/a.test.ts'],
    ['test/z.test.ts', 'test/a.test.ts'],
    ['test/../a.test.ts'],
    ['test//a.test.ts'],
    ['test/./a.test.ts'],
    ['/tmp/a.test.ts'],
    [1]
  ]) {
    assert.throws(() => applicationCoverageBatches(selected))
  }
})

test('complete raw same-run batch receipts reconcile to the original successful shard result', () => {
  const rows = batchEvidence(),
    original = structuredClone(rows)
  const merged = mergeCoverageBatchResults(rows.reverse(), identity, batchSelected)
  assert.equal(merged.numTotalTests, 4)
  assert.equal(merged.numPassedTestSuites, 4)
  assert.deepEqual(
    merged.testResults.map(suite => path.relative(directory, suite.name)),
    [batchSelected[1], batchSelected[2], batchSelected[0], batchSelected[3]]
  )
  assert.deepEqual(rows.reverse(), original)
  assert.doesNotThrow(() => validateShardUnion(evidence(), identity, expected))
})

test('missing, duplicate, altered-selection and other-source batch receipts are refused', () => {
  const mutations = [
    rows => rows.pop(),
    rows => rows.push(structuredClone(rows[0])),
    rows => {
      rows[1] = structuredClone(rows[0])
    },
    rows => {
      rows[0].manifest.id = 'unknown'
    },
    rows => {
      rows[0].manifest.runInBand = false
    },
    rows => {
      rows[0].manifest.selectedTests = ['test/a.test.ts']
    },
    rows => {
      rows[0].manifest.identity.sha = 'c'.repeat(40)
    },
    rows => {
      rows[0].manifest.identity.run = '2'
    },
    rows => {
      rows[0].manifest.identity.attempt = '2'
    },
    rows => {
      rows[0].manifest.identity.configuration = 'c'.repeat(64)
    }
  ]
  for (const mutate of mutations) {
    const rows = batchEvidence()
    mutate(rows)
    assert.throws(() => mergeCoverageBatchResults(rows, identity, batchSelected))
  }
})

test('a failed, skipped, relabeled or unexecuted batch cannot qualify the merged shard', () => {
  for (const mutate of [
    result => {
      result.success = false
    },
    result => {
      result.numFailedTests = 1
    },
    result => {
      result.numPendingTests = 1
    },
    result => {
      result.numTodoTests = 1
    },
    result => {
      result.numPassedTests = 0
    },
    result => {
      result.numTotalTests = 2
    },
    result => {
      result.testResults[0].name = path.join(directory, 'test/extra.test.ts')
    },
    result => {
      result.testResults[0].assertionResults = []
    },
    result => {
      result.testResults[0].assertionResults[0].status = 'pending'
    }
  ]) {
    const rows = batchEvidence()
    mutate(rows[0].results)
    assert.throws(() => mergeCoverageBatchResults(rows, identity, batchSelected))
  }
})
