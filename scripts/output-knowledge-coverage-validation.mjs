import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = fileURLToPath(
  new URL('../packages/application/output-knowledge/', import.meta.url)
)
const shardCount = 2

// Preserve ECMAScript's UTF-16 code-unit order across runner locales.
export function compareCoveragePaths(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function relativeTests(tests, directory = packageDirectory) {
  assert.ok(Array.isArray(tests) && tests.length > 0, 'empty test inventory')
  return tests
    .map(test => {
      const relative = path.relative(directory, test).split(path.sep).join('/')
      assert.ok(relative.startsWith('test/') && relative.endsWith('.test.ts'))
      assert.ok(!relative.split('/').includes('..'))
      return relative
    })
    .toSorted(compareCoveragePaths)
}

export function assertCompleteResults(results, selected, directory = packageDirectory) {
  assert.equal(results.success, true, 'Jest did not succeed')
  assert.equal(results.numFailedTests, 0)
  assert.equal(results.numFailedTestSuites, 0)
  assert.equal(results.numPendingTests, 0, 'pending tests are not qualification')
  assert.equal(results.numTodoTests, 0)
  assert.equal(results.numPendingTestSuites, 0)
  assert.ok(results.numTotalTests > 0)
  assert.equal(results.numPassedTests, results.numTotalTests)
  assert.equal(results.numTotalTestSuites, selected.length)
  assert.equal(results.numPassedTestSuites, selected.length)
  assert.deepEqual(
    relativeTests(
      results.testResults.map(test => test.name),
      directory
    ),
    selected
  )
  assert.equal(
    results.testResults.reduce((total, suite) => total + suite.assertionResults.length, 0),
    results.numTotalTests
  )
  for (const suite of results.testResults) {
    assert.equal(suite.status, 'passed')
    assert.ok(suite.assertionResults.length > 0)
    assert.ok(suite.assertionResults.every(result => result.status === 'passed'))
  }
}

export function validateShardUnion(shards, identity, expected) {
  assert.equal(shards.length, shardCount, 'both same-run shards are required')
  const selected = []
  const ids = new Set()
  for (const { manifest, results } of shards) {
    assert.deepEqual(manifest.identity, identity, 'different run, attempt, source or configuration')
    assert.equal(manifest.total, shardCount)
    assert.ok([1, 2].includes(manifest.shard) && !ids.has(manifest.shard))
    ids.add(manifest.shard)
    assert.deepEqual(manifest.allTests, expected)
    assertCompleteResults(results, manifest.selectedTests)
    selected.push(...manifest.selectedTests)
  }
  assert.equal(new Set(selected).size, selected.length, 'duplicate test execution')
  assert.deepEqual(
    selected.toSorted(compareCoveragePaths),
    expected,
    'missing or extra test execution'
  )
}

export function enforceGlobalCoverage(map, thresholds) {
  assert.deepEqual(Object.keys(thresholds), ['global'], 'unsupported coverage threshold scope')
  assert.deepEqual(Object.keys(thresholds.global).toSorted(compareCoveragePaths), [
    'branches',
    'functions',
    'lines',
    'statements'
  ])
  const summary = map.getCoverageSummary().toJSON()
  for (const [metric, minimum] of Object.entries(thresholds.global)) {
    assert.ok(['branches', 'functions', 'lines', 'statements'].includes(metric))
    assert.ok(Number.isFinite(minimum))
    const { total, covered, pct } = summary[metric]
    assert.ok(total > 0 && typeof pct === 'number', `missing ${metric} coverage`)
    assert.ok(
      minimum < 0 ? total - covered <= -minimum : pct >= minimum,
      `${metric} coverage ${pct}% fails original threshold ${minimum}`
    )
  }
  return summary
}
