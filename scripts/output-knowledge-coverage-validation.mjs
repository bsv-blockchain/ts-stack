import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = fileURLToPath(
  new URL('../packages/application/output-knowledge/', import.meta.url)
)
export const APPLICATION_COVERAGE_SHARDS = 4
const shardCount = APPLICATION_COVERAGE_SHARDS

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
  assert.equal(shards.length, shardCount, 'all same-run shards are required')
  const selected = []
  const ids = new Set()
  for (const { manifest, results } of shards) {
    assert.deepEqual(manifest.identity, identity, 'different run, attempt, source or configuration')
    assert.equal(manifest.total, shardCount)
    assert.ok(
      Number.isSafeInteger(manifest.shard) &&
        manifest.shard >= 1 &&
        manifest.shard <= shardCount &&
        !ids.has(manifest.shard)
    )
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

// The two independently observed native histories run in fresh serial Jest
// processes. This list changes execution placement only, never discovery.
const isolatedCoverageTests = Object.freeze([
  'test/private-purchase-alias-coordinator.property.test.ts',
  'test/private-purchase-alias-disclosure.property.test.ts'
])

export function applicationCoverageBatches(selected) {
  assert.ok(Array.isArray(selected) && selected.length > 0, 'empty selected test inventory')
  for (const file of selected) {
    assert.ok(typeof file === 'string' && file.startsWith('test/') && file.endsWith('.test.ts'))
    assert.ok(file.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
  }
  assert.equal(new Set(selected).size, selected.length, 'duplicate selected suite')
  assert.deepEqual(
    selected,
    selected.toSorted(compareCoveragePaths),
    'unordered selected inventory'
  )
  const batches = isolatedCoverageTests
    .filter(file => selected.includes(file))
    .map(file => ({
      id: file.slice(5, -8),
      selectedTests: [file],
      runInBand: true
    }))
  const ordinary = selected.filter(file => !isolatedCoverageTests.includes(file))
  if (ordinary.length > 0)
    batches.push({ id: 'ordinary', selectedTests: ordinary, runInBand: false })
  assert.deepEqual(
    batches.flatMap(batch => batch.selectedTests).toSorted(compareCoveragePaths),
    selected
  )
  return batches
}

/** Reconcile retained raw successful receipts; no missing, repeated, relabeled,
 * skipped or other-source execution can supply the merged shard result. */
export function mergeCoverageBatchResults(batches, identity, selected) {
  const plan = applicationCoverageBatches(selected)
  assert.ok(Array.isArray(batches))
  assert.equal(batches.length, plan.length, 'all execution batches are required')
  const ids = new Set()
  for (const batch of batches) {
    const expected = plan.find(item => item.id === batch.manifest.id)
    assert.ok(expected && !ids.has(expected.id), 'unknown or repeated execution batch')
    ids.add(expected.id)
    assert.deepEqual(
      batch.manifest,
      { identity, ...expected },
      'changed batch identity or selection'
    )
    assertCompleteResults(batch.results, expected.selectedTests)
  }
  const ordered = plan.map(item => batches.find(batch => batch.manifest.id === item.id))
  const count = key => ordered.reduce((total, batch) => total + batch.results[key], 0)
  const result = {
    success: true,
    numFailedTests: count('numFailedTests'),
    numFailedTestSuites: count('numFailedTestSuites'),
    numPendingTests: count('numPendingTests'),
    numTodoTests: count('numTodoTests'),
    numPendingTestSuites: count('numPendingTestSuites'),
    numTotalTests: count('numTotalTests'),
    numPassedTests: count('numPassedTests'),
    numTotalTestSuites: count('numTotalTestSuites'),
    numPassedTestSuites: count('numPassedTestSuites'),
    testResults: ordered.flatMap(batch => batch.results.testResults)
  }
  assertCompleteResults(result, selected)
  return result
}
