import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  assert.equal(result.summary.propertySuites, 37)
  assert.equal(result.summary.propertyPackages, 31)
  assert.equal(result.summary.propertyExcludedPackages, 5)
  assert.equal(result.summary.propertyClassifiedPackages, 36)
  assert.equal(result.summary.mutationTargets, 37)
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

test('every elapsed test review deadline is advisory, including inherited property dates', () => {
  const result = evaluateTestGovernance({ today: '2099-01-01' })
  assert.deepEqual(result.errors, [])
  for (const label of [
    'property testing policy',
    'property suite ',
    'property exclusion ',
    'mutation testing policy',
    'manual policy ',
    'wallet manual suite inventory',
    'required skip ',
    'conformance skip group '
  ]) {
    assert.ok(
      result.warnings.some(item => item.startsWith(label)),
      label
    )
  }
  const expected =
    3 +
    policy.propertyTesting.suites.length +
    policy.propertyTesting.exclusions.length +
    policy.manualPolicies.length +
    policy.requiredSkips.length +
    policy.conformanceSkipGroups.length
  assert.equal(result.warnings.length, expected)
})

test('wallet inventory review warns only after its date and retains structural failures', () => {
  const onDate = evaluateTestGovernance({ today: walletManualSuiteInventory.reviewBy })
  assert.ok(!onDate.warnings.some(item => item.startsWith('wallet manual suite inventory')))
  const expiredInventory = { ...walletManualSuiteInventory, reviewBy: '2026-10-08' }
  const expired = evaluateTestGovernance({
    walletManualSuiteInventory: expiredInventory,
    today: '2026-10-09'
  })
  assert.deepEqual(expired.errors, [])
  assert.ok(expired.warnings.includes('wallet manual suite inventory expired on 2026-10-08'))

  const invalid = structuredClone(walletManualSuiteInventory)
  invalid.owner = 'unknown-owner'
  invalid.reviewBy = 'invalid-date'
  invalid.suites.pop()
  const result = evaluateTestGovernance({
    walletManualSuiteInventory: invalid,
    today: '2099-01-01'
  })
  assert.match(result.errors.join('\n'), /references unknown owner/)
  assert.match(result.errors.join('\n'), /must declare reviewBy as YYYY-MM-DD/)
  assert.match(result.errors.join('\n'), /lacks an exact wallet manual suite disposition/)
  assert.ok(result.warnings.length > 0)
})

test('the real governance and health CLIs succeed with expired records', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stack-expiry-cli-'))
  try {
    const clock = path.join(temporaryDirectory, 'clock.mjs')
    fs.writeFileSync(
      clock,
      `
      const RealDate = Date
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2099-01-01T00:00:00Z'])) }
        static now() { return new RealDate('2099-01-01T00:00:00Z').getTime() }
      }
    `
    )
    const run = (script, ...args) =>
      spawnSync(process.execPath, ['--import', clock, script, ...args], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8'
      })
    const success = run('scripts/test-governance.mjs')
    assert.equal(success.status, 0, success.stderr || success.stdout)
    assert.ok(
      success.stderr.includes(
        `MAINTENANCE wallet manual suite inventory expired on ${walletManualSuiteInventory.reviewBy}`
      )
    )
    assert.match(success.stdout, /Test governance passed:/)

    // Exercise the shared health entrypoint with the same expired clock.
    const health = run('scripts/repository-health.mjs')
    assert.equal(health.status, 0, health.stderr || health.stdout)
    assert.match(health.stdout, /MAINTENANCE .*expired on/)
    const maintenance = run('scripts/repository-health.mjs', '--maintenance', '--strict')
    assert.equal(maintenance.status, 0, maintenance.stderr || maintenance.stdout)
    assert.match(maintenance.stdout, /MAINTENANCE .*expired on/)
    const fullDocs = run('scripts/documentation-policy.mjs', '--all')
    assert.equal(fullDocs.status, 0, fullDocs.stderr || fullDocs.stdout)
    assert.match(fullDocs.stderr, /MAINTENANCE .*verification expired/)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('PR workflows keep strict maintenance audits outside their aggregate gates', () => {
  const directory = path.join(REPOSITORY_ROOT, '.github/workflows')
  let checked = 0
  for (const file of fs.readdirSync(directory)) {
    if (!/\.ya?ml$/.test(file)) continue
    const workflow = fs.readFileSync(path.join(directory, file), 'utf8')
    if (!/pull_request(?:_target)?:/.test(workflow.split('\njobs:')[0])) continue
    checked++
    assert.doesNotMatch(workflow, /repository-health\.mjs[^\n]*--maintenance/, file)
    assert.doesNotMatch(workflow, /documentation-policy\.mjs[^\n]*--all/, file)
    assert.doesNotMatch(workflow, /test-governance\.mjs[^\n]*\|/, file)
  }
  assert.ok(checked > 0)
})
