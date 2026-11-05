import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  comparePilotReports,
  requirePilotParts,
  requireDeclaredProperty
} from './mutation-pilot.mjs'

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

test('coverage identities survive ID renumbering and distinguish duplicate test definitions', () => {
  const baseline = report()
  const candidate = report('Killed', true)
  candidate.testFiles['test/full.test.ts'].tests[0].id = '99'
  candidate.files['src/owner.ts'].mutants[0].coveredBy = ['99']
  assert.equal(comparePilotReports(baseline, candidate).noWeaker, true)
  for (const value of [baseline, candidate]) {
    const file = value.testFiles['test/full.test.ts']
    file.tests.push({ ...structuredClone(file.tests[0]), id: 'different-case' })
  }
  // Same name/location can describe distinct test.each cases. Swapping the
  // covering case must not be mistaken for a harmless global ID renumbering.
  candidate.files['src/owner.ts'].mutants[0].coveredBy = ['different-case']
  assert.throws(() => comparePilotReports(baseline, candidate), /coverage changed/)
})

test('the whole buyer scope rejects a newly added or missing canonical part', () => {
  assert.equal(
    requirePilotParts('lookup-buyer', ['buyer', 'payment']).target,
    'private-lookup-buyer'
  )
  assert.throws(() => requirePilotParts('lookup-buyer', ['buyer']), /partition moved/)
  assert.throws(
    () => requirePilotParts('lookup-buyer', ['buyer', 'payment', 'unexecuted']),
    /omits a canonical part/
  )
  assert.throws(() => requirePilotParts('unknown', []), /Unknown pilot case/)
  assert.equal(
    requirePilotParts('native-clock', ['progress-8', 'other-explicitly-unmeasured']).target,
    'private-purchase-native-clock'
  )
})

function explicitProjectSelectsProperty(root, target, config) {
  const directory = config.rootDir ?? path.join(root, target.packageDirectory)
  const chosen = new Set()
  for (const specification of config.testMatch ?? []) {
    const negate = specification.startsWith('!')
    const pattern = (negate ? specification.slice(1) : specification).replaceAll(
      '<rootDir>',
      directory
    )
    const relative = path.relative(directory, pattern).split(path.sep).join('/')
    for (const file of fs.globSync(relative, { cwd: directory })) {
      const resolved = fs.realpathSync(path.resolve(directory, file))
      if (negate) chosen.delete(resolved)
      else chosen.add(resolved)
    }
  }
  return chosen.has(fs.realpathSync(path.join(root, target.propertyTest)))
}

test('every explicit Jest mutation selector includes its declared property file', () => {
  // Necessary selector check, not a substitute for real runner discovery:
  // package defaults, Vitest and ignore-pattern semantics are not inferred.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const targets = buildMutationTargets(root)
  for (const [id, target] of Object.entries(targets)) {
    const config = target.runnerOptions.jest?.config
    const explicit = (config?.projects ?? [config]).filter(project => project?.testMatch)
    if (explicit.length)
      assert(
        explicit.some(project => explicitProjectSelectsProperty(root, target, project)),
        id
      )
  }
  const buyer = structuredClone(targets['private-lookup-buyer'])
  buyer.runnerOptions.jest.config.testMatch = buyer.runnerOptions.jest.config.testMatch.filter(
    pattern => !pattern.includes('private-lookup-buyer.property')
  )
  assert.equal(explicitProjectSelectsProperty(root, buyer, buyer.runnerOptions.jest.config), false)
})

test('a declared property must appear with its actual source and runnable tests', () => {
  requireDeclaredProperty(report(), 'test/full.test.ts', 'real assertion')
  assert.throws(
    () => requireDeclaredProperty(report(), 'test/omitted.property.test.ts', 'real assertion'),
    /absent from actual runner/
  )
  assert.throws(
    () => requireDeclaredProperty(report(), 'test/full.test.ts', 'different source'),
    /source differs/
  )
  const empty = report()
  empty.testFiles['test/full.test.ts'].tests = []
  assert.throws(
    () => requireDeclaredProperty(empty, 'test/full.test.ts', 'real assertion'),
    /absent from actual runner/
  )
})

test('runner limits remain raw reported kills but never prove an assertion counterexample', () => {
  const candidate = report('Killed', true)
  for (const [reason, kind] of [
    [
      'Error: Property interrupted after 287 tests\n{ seed: 3242026 }',
      'property-exploration-limit'
    ],
    ['Error: thrown: "Exceeded timeout of 5000 ms for a test.', 'jest-deadline']
  ]) {
    const baseline = report()
    baseline.files['src/owner.ts'].mutants[0].statusReason = reason
    const result = comparePilotReports(baseline, candidate)
    assert.equal(baseline.files['src/owner.ts'].mutants[0].status, 'Killed')
    assert.equal(result.baseline.counts.Killed, 1)
    assert.equal(result.noWeaker, true)
    assert.equal(result.requiresAdjudication, true)
    assert.equal(result.harnessLimitedKills[0].arm, 'baseline')
    assert.equal(result.harnessLimitedKills[0].kind, kind)
  }
  const realFailure = report()
  realFailure.files['src/owner.ts'].mutants[0].statusReason =
    'Error: Property failed after 1 tests\nCounterexample: ["wrong owner"]'
  assert.equal(comparePilotReports(realFailure, candidate).requiresAdjudication, false)
})
