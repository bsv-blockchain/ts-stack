import assert from 'node:assert/strict'
import test from 'node:test'
import coverageLibrary from 'istanbul-lib-coverage'
import { enforceGlobalCoverage, mergeCoverage } from './output-knowledge-coverage.mjs'

const { createCoverageMap } = coverageLibrary

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
