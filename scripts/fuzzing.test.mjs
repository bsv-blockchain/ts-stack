import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { buildFuzzTargets } from '../governance/fuzzing/targets.mjs'
import {
  buildJazzerArguments,
  parseArguments,
  REPOSITORY_ROOT,
  selectAffectedFuzzTargets,
  validateFuzzPolicy
} from './fuzzing.mjs'

const selectionTargets = {
  one: {
    packageDirectories: ['packages/one']
  },
  two: {
    packageDirectories: ['packages/two', 'packages/shared']
  }
}

test('fuzz command parsing validates command and execution modes', () => {
  assert.deepEqual(parseArguments(['--target', 'one', '--mode', 'fuzzing', '--seconds', '30']), {
    all: false,
    list: false,
    validate: false,
    targets: ['one'],
    affectedFile: undefined,
    mode: 'fuzzing',
    seconds: 30,
    corpusDirectory: undefined,
    coverage: false
  })
  assert.throws(() => parseArguments(['--target']), /requires a value/)
  assert.throws(() => parseArguments(['--mode', 'unknown', '--all']), /regression or fuzzing/)
  assert.throws(() => parseArguments(['--seconds', '0', '--all']), /integer from 1/)
  assert.throws(() => parseArguments(['--seconds', '1', '--all']), /only valid in fuzzing/)
  assert.throws(() => parseArguments(['--validate', '--coverage']), /Run options require/)
  assert.throws(() => parseArguments(['--all', '--target', 'one']), /exactly one/)
})

test('affected fuzz selection is package-scoped with control and SDK fan-out', () => {
  assert.deepEqual(selectAffectedFuzzTargets(selectionTargets, ['packages/one/src/index.ts']), [
    'one'
  ])
  assert.deepEqual(selectAffectedFuzzTargets(selectionTargets, ['packages/shared/src/index.ts']), [
    'two'
  ])
  assert.deepEqual(selectAffectedFuzzTargets(selectionTargets, ['docs/about/contributing.md']), [])
  assert.deepEqual(selectAffectedFuzzTargets(selectionTargets, ['fuzz/lib.mjs']), ['one', 'two'])
  assert.deepEqual(selectAffectedFuzzTargets(selectionTargets, ['packages/sdk/src/index.ts']), [
    'one',
    'two'
  ])
})

test('Jazzer arguments preserve corpus roles, instrumentation, limits, and findings', () => {
  const target = {
    id: 'one',
    targetModule: 'fuzz/targets/one.mjs',
    seedCorpus: 'fuzz/corpus/one',
    sourceIncludes: ['packages/one/dist/'],
    dictionary: 'fuzz/dictionaries/protocol.dict',
    maximumInputBytes: 1024,
    timeoutMilliseconds: 5000,
    sync: true
  }
  const regression = buildJazzerArguments({
    target,
    mode: 'regression',
    seconds: 30,
    corpusDirectory: '/tmp/cumulative',
    coverage: true
  }).arguments_
  assert.equal(regression[1], path.join(REPOSITORY_ROOT, 'fuzz/corpus/one'))
  assert.ok(!regression.includes('/tmp/cumulative/one'))
  assert.ok(regression.includes('--coverage'))
  assert.ok(regression.includes('--sync'))
  assert.ok(regression.includes('-max_len=1024'))
  assert.ok(
    regression.includes(
      `-artifact_prefix=${path.join(REPOSITORY_ROOT, 'artifacts/fuzz/one/findings')}${path.sep}`
    )
  )

  const fuzzing = buildJazzerArguments({
    target: { ...target, sync: false },
    mode: 'fuzzing',
    seconds: 30,
    corpusDirectory: '/tmp/cumulative',
    coverage: false
  }).arguments_
  assert.equal(fuzzing[1], '/tmp/cumulative/one')
  assert.equal(fuzzing[2], path.join(REPOSITORY_ROOT, 'fuzz/corpus/one'))
  assert.ok(fuzzing.includes('-max_total_time=30'))
  assert.ok(!fuzzing.includes('--sync'))
})

test('checked-in fuzz governance is internally complete and package-exhaustive', () => {
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/fuzzing/policy.json'), 'utf8')
  )
  const propertyPolicy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/test-quality/policy.json'), 'utf8')
  )
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')
  )
  assert.deepEqual(
    validateFuzzPolicy({
      policy,
      propertyPolicy,
      rootPackage,
      targets: buildFuzzTargets()
    }),
    []
  )
})
