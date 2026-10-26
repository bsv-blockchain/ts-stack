import assert from 'node:assert/strict'
import { test } from 'node:test'

import { comparePerformanceReports } from './compare-performance-reports.mjs'

function report(first, second = first) {
  return {
    benchmark: 'example',
    payloadBytes: 1024,
    measurements: {
      first: { medianMs: first },
      second: { medianMs: second }
    }
  }
}

test('performance comparison accepts exact parity and per-case improvements', () => {
  assert.equal(comparePerformanceReports(report(10), report(10)).violations.length, 0)
  assert.equal(comparePerformanceReports(report(10), report(9)).violations.length, 0)
})

test('performance comparison keeps measurement identity in code-unit order', () => {
  const names = ['z', 'ä', 'A']
  const expected = [...names].sort()
  const measurements = {}
  for (const name of names) measurements[name] = { medianMs: 1 }
  const report = { benchmark: 'example', payloadBytes: 1, measurements }
  const originalSort = Array.prototype.sort
  Array.prototype.sort = function (compareFn) {
    if (typeof compareFn !== 'function') {
      throw new Error('Array.prototype.sort was called without a comparator')
    }
    return originalSort.call(this, compareFn)
  }
  try {
    const comparison = comparePerformanceReports(report, report)
    assert.deepEqual(
      comparison.rows.map(row => row.name),
      expected
    )
    assert.equal(comparison.violations.length, 0)
  } finally {
    Array.prototype.sort = originalSort
  }
})

test('performance comparison rejects one slower case and aggregate growth', () => {
  const comparison = comparePerformanceReports(report(10, 10), report(10, 11))
  assert.deepEqual(
    comparison.violations.map(({ name }) => name),
    ['second', '<aggregate>']
  )
})
