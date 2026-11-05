import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { comparePilotReports } from './mutation-pilot.mjs'

const require = createRequire(import.meta.url)
const Sequencer = require('../governance/mutation-testing/fast-failure-sequencer.cjs')
const rootDir = '/repo/package'
const entry = name => ({ path: `${rootDir}/test/${name}`, context: { config: { rootDir } } })

test('focused files precede properties without dropping or modifying any selected file', () => {
  const original = [
    entry('a.property.test.ts'),
    entry('z.test.ts'),
    entry('b.property.test.ts'),
    entry('a.test.ts')
  ]
  const snapshot = structuredClone(original)
  const result = new Sequencer().sort(original)
  assert.deepEqual(original, snapshot)
  assert.deepEqual(
    result.map(value => value.path.split('/').at(-1)),
    ['a.test.ts', 'z.test.ts', 'a.property.test.ts', 'b.property.test.ts']
  )
  assert.equal(result.length, original.length)
  for (const value of original) assert.equal(result.filter(item => item === value).length, 1)
  assert.deepEqual(new Sequencer().sort([...original].reverse()), result)
})

test('empty and repeated entries remain exhaustive and failed-file input is unchanged', () => {
  const sequencer = new Sequencer()
  assert.deepEqual(sequencer.sort([]), [])
  const file = entry('a.test.ts')
  const repeated = [file, file]
  assert.deepEqual(sequencer.sort(repeated), repeated)
  assert.equal(sequencer.allFailedTests(repeated), repeated)
  assert.equal(sequencer.cacheResults(), undefined)
})

function report(status = 'Killed', candidate = false) {
  return {
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '10.1.1' },
    config: {
      concurrency: 4,
      timeoutMS: 2000,
      timeoutFactor: 3,
      jsonReporter: { fileName: candidate ? '/candidate/report.json' : '/baseline/report.json' },
      jest: {
        config: {
          testMatch: ['test/full.test.ts', 'test/full.property.test.ts'],
          ...(candidate
            ? { testSequencer: '/repo/governance/mutation-testing/fast-failure-sequencer.cjs' }
            : {})
        }
      }
    },
    testFiles: {
      'test/full.test.ts': {
        source: 'real assertion',
        tests: [
          { id: '0', name: 'refuses another owner', location: { start: { line: 1, column: 1 } } }
        ]
      }
    },
    files: {
      'src/owner.ts': {
        source: 'owner === caller',
        mutants: [
          {
            id: '0',
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 17 } },
            mutatorName: 'EqualityOperator',
            replacement: 'owner !== caller',
            status,
            coveredBy: ['0'],
            testsCompleted: 1
          }
        ]
      }
    }
  }
}

test('pilot compares complete mutant/test identities and never grants publication credit', () => {
  const result = comparePilotReports(report(), report('Killed', true))
  assert.equal(result.noWeaker, true)
  assert.equal(result.canonicalSites, 1)
  assert.equal(result.selectedTests, 1)
  assert.equal(result.publicationQualification, false)
  for (const status of ['Survived', 'Timeout', 'NoCoverage', 'RuntimeError', 'Ignored'])
    assert.equal(comparePilotReports(report(), report(status, true)).noWeaker, false, status)
  assert.equal(comparePilotReports(report('Survived'), report('Killed', true)).noWeaker, false)
  // Existing survivors are still reported as survivors, not silently qualified.
  const failure = comparePilotReports(report('Survived'), report('Survived', true))
  assert.equal(failure.noWeaker, true)
  assert.equal(failure.candidate.score, 0)
  const unexecuted = report('Survived', true)
  unexecuted.files['src/owner.ts'].mutants[0].testsCompleted = 0
  assert.equal(comparePilotReports(report('Survived'), unexecuted).noWeaker, false)
})

test('pilot rejects omitted sites, changed code/tests, relaxed settings and an arbitrary sequencer', () => {
  const changes = [
    value => {
      value.files['src/owner.ts'].mutants = []
    },
    value => {
      value.files['src/owner.ts'].source = 'changed production'
    },
    value => {
      value.testFiles['test/full.test.ts'].source = 'weakened assertion'
    },
    value => {
      value.files['src/owner.ts'].mutants[0].coveredBy = []
    },
    value => {
      value.config.timeoutFactor = 10
    },
    value => {
      value.config.jest.config.testMatch.pop()
    },
    value => {
      value.config.jest.config.testSequencer = '/skip-tests.cjs'
    }
  ]
  for (const change of changes) {
    const candidate = report('Killed', true)
    change(candidate)
    assert.throws(() => comparePilotReports(report(), candidate))
  }
})
