import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveGovernedTest } from './run-governed-test.mjs'
import {
  REPOSITORY_ROOT,
  classifyManualFile,
  evaluateTestGovernance,
  findDirectSkips,
  findEmptyTests,
  findUnboundedLoops
} from './test-governance.mjs'

const policyPath = path.join(REPOSITORY_ROOT, 'governance/test-quality/policy.json')
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
const walletManualSuiteInventoryPath = path.join(
  REPOSITORY_ROOT,
  'governance/test-quality/wallet-toolbox-manual-suites.json'
)
const walletManualSuiteInventory = JSON.parse(
  fs.readFileSync(walletManualSuiteInventoryPath, 'utf8')
)

test('current required, manual, live, resource, and conformance tests are governed', () => {
  const result = evaluateTestGovernance({
    policy,
    today: '2026-07-31'
  })

  assert.deepEqual(result.errors, [])
  assert.equal(result.summary.requiredDirectSkips, 2)
  assert.equal(result.summary.propertySuites, 28)
  assert.equal(result.summary.propertyPackages, 28)
  assert.equal(result.summary.propertyExcludedPackages, 6)
  assert.equal(result.summary.propertyClassifiedPackages, 34)
  assert.equal(result.summary.mutationTargets, 28)
  assert.equal(result.summary.manualAndLiveFiles, 32)
  assert.equal(result.summary.walletManualSuites, 30)
  assert.equal(result.summary.conformanceSkipFiles, 19)
  assert.equal(result.summary.conformanceSkips, 211)
})

test('every property suite must retain an exact mutation-quality target', () => {
  const mutationPolicyPath = path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json')
  const mutationPolicy = JSON.parse(fs.readFileSync(mutationPolicyPath, 'utf8'))
  mutationPolicy.targets.pop()
  const result = evaluateTestGovernance({
    policy,
    mutationPolicy,
    today: '2026-07-31'
  })

  assert.match(result.errors.join('\n'), /lacks mutation validation/)
  assert.match(result.errors.join('\n'), /executable mutation target .* is unregistered/)
})

test('an unregistered required skip fails the exact inventory', () => {
  const changedPolicy = structuredClone(policy)
  changedPolicy.requiredSkips.pop()
  const result = evaluateTestGovernance({
    policy: changedPolicy,
    today: '2026-07-31'
  })

  assert.match(result.errors.join('\n'), /has unregistered skip/)
})

test('direct skip parsing ignores prose and captures executable declarations', () => {
  const source = [
    '// test.skip if the external service is unavailable',
    "test.skip('registered gap', async () => {})",
    "describe.todo('future suite', () => {})",
    "xit('legacy alias', () => {})"
  ].join('\n')

  assert.deepEqual(findDirectSkips(source), [
    { title: 'registered gap', line: 2 },
    { title: 'future suite', line: 3 },
    { title: 'legacy alias', line: 4 }
  ])
})

test('assertion-free empty test bodies are rejected without flagging real bodies', () => {
  const source = [
    "test('empty sync', () => {})",
    "it('empty async', async () => {  })",
    "test('asserted', () => { expect(true).toBe(true) })"
  ].join('\n')

  assert.deepEqual(findEmptyTests(source), [
    { title: 'empty sync', line: 1 },
    { title: 'empty async', line: 2 }
  ])
})

test('unbounded-loop detection ignores comments and accepts bounded loops', () => {
  const source = [
    '// for (;;) {}',
    '/* while (true) {} */',
    '"for (;;) {}"',
    "'while (true) {}'",
    '`for (;;) {}`',
    'for (; index < limit; index++) {}',
    'while (remaining > 0) { remaining-- }',
    'for (;;) { await work() }',
    'while (true) { await work() }'
  ].join('\n')

  assert.deepEqual(findUnboundedLoops(source), [8, 9])
})

test('manual classification requires one matching policy rule', () => {
  const file = 'packages/wallet/wallet-toolbox/test/Wallet/example.man.test.ts'
  assert.deepEqual(
    classifyManualFile(file, policy.manualRules).map(rule => rule.policy),
    ['wallet-operator']
  )
})

test('every Wallet Toolbox manual suite has an exact disposition', () => {
  const changedInventory = structuredClone(walletManualSuiteInventory)
  changedInventory.suites.pop()
  const result = evaluateTestGovernance({
    policy,
    walletManualSuiteInventory: changedInventory,
    today: '2026-07-29'
  })
  assert.match(result.errors.join('\n'), /lacks an exact wallet manual suite disposition/)
})

test('governed test runner rejects traversal and wrong test modes', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-governed-test-'))
  try {
    const testDirectory = path.join(temporaryDirectory, 'tests')
    fs.mkdirSync(testDirectory)
    fs.writeFileSync(path.join(testDirectory, 'example.man.test.ts'), '')

    assert.equal(
      resolveGovernedTest(temporaryDirectory, 'manual', 'tests/example.man.test.ts'),
      'tests/example.man.test.ts'
    )
    assert.throws(
      () => resolveGovernedTest(temporaryDirectory, 'live', 'tests/example.man.test.ts'),
      /must end with \.live\.test\.ts/
    )
    assert.throws(
      () => resolveGovernedTest(temporaryDirectory, 'manual', '../outside.man.test.ts'),
      /escapes the workspace/
    )
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})
