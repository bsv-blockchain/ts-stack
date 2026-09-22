import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareSizeReports } from './compare-size-reports.mjs'

function reports(raw, gzip = raw, brotli = raw) {
  return new Map([
    [
      '@bsv/example',
      {
        values: new Map([
          ['vite.raw', raw],
          ['vite.gzip', gzip],
          ['vite.brotli', brotli]
        ])
      }
    ]
  ])
}

test('size comparison accepts exact parity and reductions', () => {
  assert.equal(compareSizeReports(reports(10), reports(10)).violations.length, 0)
  assert.equal(compareSizeReports(reports(10), reports(9)).violations.length, 0)
})

test('size comparison keeps package and metric identity in code-unit order', () => {
  const packages = ['z', 'ä', 'A']
  const metrics = ['z.raw', 'ä.raw', 'A.raw']
  const expectedPackages = [...packages].sort()
  const expectedMetrics = [...metrics].sort()
  const reports = new Map(
    packages.map(packageName => [
      packageName,
      { values: new Map(metrics.map(metric => [metric, 4])) }
    ])
  )
  const originalSort = Array.prototype.sort
  Array.prototype.sort = function (compareFn) {
    if (typeof compareFn !== 'function') {
      throw new Error('Array.prototype.sort was called without a comparator')
    }
    return originalSort.call(this, compareFn)
  }
  try {
    const result = compareSizeReports(reports, reports)
    assert.deepEqual(
      result.rows.map(row => [row.package, row.metric]),
      expectedPackages.flatMap(packageName => expectedMetrics.map(metric => [packageName, metric]))
    )
    assert.equal(result.violations.length, 0)
  } finally {
    Array.prototype.sort = originalSort
  }
})

test('size comparison rejects a single metric and aggregate regression', () => {
  const result = compareSizeReports(reports(10, 10, 10), reports(10, 11, 10))
  assert.deepEqual(
    result.violations.map(({ package: packageName, metric }) => [packageName, metric]),
    [
      ['@bsv/example', 'vite.gzip'],
      ['<aggregate>', 'all']
    ]
  )
})
