import assert from 'node:assert/strict'
import test from 'node:test'
import coverageLibrary from 'istanbul-lib-coverage'
import {
  assertCoverageArtifact,
  enforceGlobalCoverage,
  mergeCoverage,
  serializeCoverageArtifact
} from './output-knowledge-coverage.mjs'

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
  assert.throws(() =>
    enforceGlobalCoverage(map, { global: { ...thresholds.global, lines: Number.NaN } })
  )
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
test('fresh-process batches retain all instrumented files and their uncovered counters', () => {
  const first = coverage([2, 0]),
    second = coverage([0, 3])
  const map = mergeCoverage([{ coverage: first }, { coverage: second }])
  assert.deepEqual(map.toJSON()['/fixture.ts'].s, { 0: 2, 1: 3 })
  assert.deepEqual(map.toJSON()['/fixture.ts'].f, { 0: 2, 1: 3 })
  assert.deepEqual(map.toJSON()['/fixture.ts'].b, { 0: [2, 3] })
  const incomplete = { '/extra.ts': first['/fixture.ts'] }
  assert.throws(() => mergeCoverage([{ coverage: first }, { coverage: incomplete }]))
  assert.throws(() =>
    enforceGlobalCoverage(mergeCoverage([{ coverage: coverage([1, 0]) }]), {
      global: { branches: 80, functions: 80, lines: 85, statements: 85 }
    })
  )
})

test('artifact comparison preserves every serialized field across Istanbul class instances', () => {
  const sourceMap = {
    version: 3,
    sources: ['fixture.ts'],
    names: [],
    mappings: 'AAAA',
    sourcesContent: ['export const fixture = true']
  }
  const first = coverage([2, 0]),
    second = coverage([0, 3]),
    expected = coverage([2, 3])
  for (const value of [first, second, expected]) value['/fixture.ts'].inputSourceMap = sourceMap
  const recomputed = mergeCoverage([{ coverage: first }, { coverage: second }]).toJSON()
  assert.notDeepEqual(expected, recomputed)
  assert.deepEqual(JSON.parse(serializeCoverageArtifact(recomputed)), expected)
  assert.doesNotThrow(() => assertCoverageArtifact(expected, recomputed))
  assert.notDeepEqual(expected, recomputed)
  for (const mutate of [
    value => {
      value['/fixture.ts'].s[0]++
    },
    value => {
      value['/fixture.ts'].f[0]++
    },
    value => {
      value['/fixture.ts'].b[0][0]++
    },
    value => {
      value['/fixture.ts'].statementMap[0].start.line++
    },
    value => {
      value['/fixture.ts'].fnMap[0].loc.end.line++
    },
    value => {
      value['/fixture.ts'].inputSourceMap.sourcesContent[0] = 'changed'
    },
    value => {
      delete value['/fixture.ts']
    },
    value => {
      value['/extra.ts'] = structuredClone(value['/fixture.ts'])
    }
  ]) {
    const changed = structuredClone(expected)
    mutate(changed)
    assert.throws(() => assertCoverageArtifact(changed, recomputed), /merged coverage differs/)
  }
})

test('rejected coverage produces a bounded error without dumping report contents', () => {
  const expected = coverage([1, 1]),
    changed = coverage([0, 1])
  changed['/fixture.ts'].inputSourceMap = { sourcesContent: ['private-source-marker'.repeat(5000)] }
  assert.throws(
    () => assertCoverageArtifact(changed, expected),
    error =>
      error.code === 'ERR_ASSERTION' &&
      error.message === 'merged coverage differs from raw batches' &&
      !error.stack.includes('private-source-marker') &&
      error.stack.length < 4096
  )
})
