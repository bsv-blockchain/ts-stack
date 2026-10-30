import assert from 'node:assert/strict'
import test from 'node:test'

import { jestArguments, mergeCoverage, projectNames } from './jest-project-coverage.mjs'

const location = (line, start, end) => ({
  start: { line, column: start },
  end: { line, column: end }
})

// One file as two Jest projects report it after their own source maps: the
// same source locations, numbered differently, with different code exercised.
function fileCoverage(order, hits) {
  const statements = [location(3, 2, 20), location(5, 4, 30)]
  const ordered = order.map(index => statements[index])
  return {
    '/pkg/src/example.ts': {
      path: '/pkg/src/example.ts',
      statementMap: Object.fromEntries(ordered.map((loc, index) => [String(index), loc])),
      s: Object.fromEntries(hits.map((count, index) => [String(index), count])),
      fnMap: {},
      f: {},
      branchMap: {
        0: {
          loc: location(5, 4, 30),
          type: 'if',
          locations: [location(5, 4, 30), location(5, 4, 30)]
        }
      },
      b: { 0: order[0] === 0 ? [1, 0] : [0, 2] }
    }
  }
}

test('project coverage runs every named project in the Jest config', () => {
  assert.deepEqual(
    projectNames({
      projects: [
        { displayName: 'legacy-commonjs' },
        { displayName: { name: 'private-esm', color: 'blue' } }
      ]
    }),
    ['legacy-commonjs', 'private-esm']
  )
  assert.throws(() => projectNames({}), /must define projects/)
  assert.throws(() => projectNames({ projects: [] }), /must define projects/)
  assert.throws(() => projectNames({ projects: [{}] }), /needs a displayName/)
  assert.throws(() => projectNames({ projects: [{ displayName: 'a;b' }] }), /needs a displayName/)
  assert.throws(
    () => projectNames({ projects: [{ displayName: 'esm' }, { displayName: 'esm' }] }),
    /must be unique/
  )
})

test('each project runs alone with JSON coverage in its own directory', () => {
  assert.deepEqual(jestArguments('private-esm', '/pkg/coverage/projects/private-esm'), [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--coverage',
    '--runInBand',
    '--watchman=false',
    '--selectProjects=private-esm',
    '--coverageReporters=json',
    '--coverageDirectory=/pkg/coverage/projects/private-esm'
  ])
})

test('project coverage merges by source location, not by counter number', () => {
  const merged = mergeCoverage([fileCoverage([0, 1], [4, 0]), fileCoverage([1, 0], [3, 0])])
  const file = merged.fileCoverageFor('/pkg/src/example.ts')
  assert.deepEqual({ ...file.getLineCoverage() }, { 3: 4, 5: 3 })
  assert.deepEqual(Object.values(file.b), [[1, 2]])
  assert.equal(file.toSummary().lines.pct, 100)
})
