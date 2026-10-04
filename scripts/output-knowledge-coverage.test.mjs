import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import coverageLibrary from 'istanbul-lib-coverage'
import {
  enforceGlobalCoverage,
  mergeCoverage,
  validateShardUnion
} from './output-knowledge-coverage.mjs'

const directory = fileURLToPath(
  new URL('../packages/application/output-knowledge/', import.meta.url)
)
const identity = { sha: 'a'.repeat(40), run: '1', attempt: '1', configuration: 'b'.repeat(64) }
const expected = ['test/a.test.ts', 'test/b.test.ts']
const { createCoverageMap } = coverageLibrary

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

function coverage(hits) {
  const location = line => ({ start: { line, column: 0 }, end: { line, column: 1 } })
  return {
    '/fixture.ts': {
      path: '/fixture.ts',
      statementMap: { 0: location(1), 1: location(2) },
      fnMap: {
        0: { name: 'first', decl: location(1), loc: location(1), line: 1 },
        1: { name: 'second', decl: location(2), loc: location(2), line: 2 }
      },
      branchMap: {
        0: { type: 'if', loc: location(1), line: 1, locations: [location(1), location(2)] }
      },
      s: { 0: hits[0], 1: hits[1] },
      f: { 0: hits[0], 1: hits[1] },
      b: { 0: hits }
    }
  }
}

test('the full merged map must pass every original global metric, including uncovered counts', () => {
  const thresholds = { global: { branches: 80, functions: 80, lines: 85, statements: 85 } }
  assert.throws(() => enforceGlobalCoverage(createCoverageMap(coverage([1, 0])), thresholds))
  const map = mergeCoverage([{ coverage: coverage([1, 0]) }, { coverage: coverage([0, 1]) }])
  const summary = enforceGlobalCoverage(map, thresholds)
  for (const metric of Object.keys(thresholds.global)) assert.equal(summary[metric].pct, 100)
  assert.throws(() => enforceGlobalCoverage(createCoverageMap({}), thresholds))
  assert.throws(() => enforceGlobalCoverage(map, { global: thresholds.global, './other': {} }))
  assert.throws(() => enforceGlobalCoverage(map, { global: { ...thresholds.global, lines: NaN } }))
  assert.doesNotThrow(() =>
    enforceGlobalCoverage(map, { global: { ...thresholds.global, lines: -1 } })
  )
  assert.throws(() =>
    enforceGlobalCoverage(createCoverageMap(coverage([0, 0])), {
      global: { ...thresholds.global, lines: -1 }
    })
  )
  assert.throws(() => mergeCoverage([{ coverage: {} }, { coverage: {} }]))
  assert.throws(() => mergeCoverage([{ coverage: coverage([1, 0]) }, { coverage: {} }]))
})
