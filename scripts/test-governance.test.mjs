import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
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
  assert.equal(result.summary.propertySuites, 139)
  assert.equal(result.summary.propertyPackages, 32)
  assert.equal(result.summary.propertyExcludedPackages, 5)
  assert.equal(result.summary.propertyClassifiedPackages, 37)
  assert.equal(result.summary.mutationTargets, 139)
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

test('wallet discovery excludes generated children without hiding a mutation test root', async () => {
  const { default: getConfig } = await import('../packages/wallet/wallet-toolbox/jest.config.cjs')
  const config = await getConfig()
  for (const root of ['/wallet', '/wallet/.stryker-tmp/sandbox-one']) {
    const patterns = config.testPathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    const ignored = file => patterns.some(pattern => pattern.test(`${root}/${file}`))
    assert.equal(ignored('src/storage/actionRecovery/__test/ActionRecoveryPlan.test.ts'), false)
    assert.equal(ignored('src/storage/snapshot/SnapshotSync.property.test.ts'), false)
    assert.equal(ignored('test/wallet/action.test.ts'), false)
    assert.equal(ignored('node_modules/dependency/example.test.ts'), true)
    assert.equal(ignored('.stryker-tmp/sandbox-two/src/action.test.ts'), true)
    assert.equal(ignored('xstryker-tmp/src/action.test.ts'), false)
    const modules = config.modulePathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    assert.equal(
      modules.some(pattern => pattern.test(`${root}/src/action.test.ts`)),
      false
    )
    assert.equal(
      modules.some(pattern => pattern.test(`${root}/.stryker-tmp/nested/src/action.test.ts`)),
      true
    )
  }
})

test('SDK discovery preserves authored tests when the root is a mutation sandbox', async () => {
  const { default: config } = await import('../packages/sdk/jest.config.js')
  for (const root of ['/sdk', '/sdk/.stryker-tmp/sandbox-one']) {
    const patterns = config.modulePathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    assert.equal(
      patterns.some(pattern =>
        pattern.test(`${root}/src/overlay-tools/__tests/OutputPurchaseProtocol.test.ts`)
      ),
      false
    )
    assert.equal(
      patterns.some(pattern => pattern.test(`${root}/.stryker-tmp/nested/src/example.test.ts`)),
      true
    )
    assert.equal(
      patterns.some(pattern => pattern.test(`${root}/dist/src/example.test.ts`)),
      true
    )
  }
})

test('auth discovery excludes generated children while preserving its own mutation root', async () => {
  const { default: config } =
    await import('../packages/middleware/auth-express-middleware/jest.config.js')
  for (const root of ['/auth', '/auth/.stryker-tmp/sandbox-one']) {
    for (const selected of [config.testPathIgnorePatterns, config.modulePathIgnorePatterns]) {
      const patterns = selected.map(
        pattern =>
          new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      )
      const ignored = file => patterns.some(pattern => pattern.test(`${root}/${file}`))
      assert.equal(ignored('src/__tests/testCertificaterequests.test.ts'), false)
      assert.equal(ignored('src/__tests/authenticatedResponseQueue.property.test.ts'), false)
      assert.equal(ignored('.stryker-tmp/sandbox-two/package.json'), true)
      assert.equal(ignored('.stryker-tmp/sandbox-two/src/__tests/example.test.ts'), true)
      assert.equal(ignored('dist/src/__tests/example.test.ts'), true)
      assert.equal(ignored('xstryker-tmp/src/__tests/example.test.ts'), false)
    }
    const tests = config.testPathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    assert.equal(
      tests.some(pattern => pattern.test(`${root}/node_modules/dependency/example.test.ts`)),
      true
    )
  }
})

test('overlay discovery excludes generated children while preserving its own mutation root', async () => {
  const { default: config } = await import('../packages/overlays/overlay-express/jest.config.js')
  for (const root of ['/overlay', '/overlay/.stryker-tmp/sandbox-one']) {
    for (const selected of [config.testPathIgnorePatterns, config.modulePathIgnorePatterns]) {
      const patterns = selected.map(
        pattern =>
          new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      )
      const ignored = file => patterns.some(pattern => pattern.test(`${root}/${file}`))
      assert.equal(ignored('src/__tests__/OverlayExpress.test.ts'), false)
      assert.equal(ignored('src/__tests__/RootEvictionResponseGuard.property.test.ts'), false)
      assert.equal(ignored('.stryker-tmp/sandbox-two/package.json'), true)
      assert.equal(ignored('.stryker-tmp/sandbox-two/src/__tests/example.test.ts'), true)
      assert.equal(ignored('dist/src/__tests/example.test.ts'), true)
      assert.equal(ignored('xstryker-tmp/src/__tests/example.test.ts'), false)
    }
    const tests = config.testPathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    assert.equal(
      tests.some(pattern => pattern.test(`${root}/node_modules/dependency/example.test.ts`)),
      true
    )
  }
})

test('overlay Engine discovery excludes generated children while preserving its own mutation root', async () => {
  const { default: config } = await import('../packages/overlays/overlay/jest.config.js')
  for (const root of ['/overlay', '/overlay/.stryker-tmp/sandbox-one']) {
    for (const selected of [config.testPathIgnorePatterns, config.modulePathIgnorePatterns]) {
      const patterns = selected.map(
        pattern =>
          new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      )
      const ignored = file => patterns.some(pattern => pattern.test(`${root}/${file}`))
      assert.equal(ignored('src/__tests/Engine.test.ts'), false)
      assert.equal(ignored('src/__tests/PrivatePublicationAdmission.property.test.ts'), false)
      assert.equal(ignored('.stryker-tmp/sandbox-two/package.json'), true)
      assert.equal(ignored('.stryker-tmp/sandbox-two/src/__tests/example.test.ts'), true)
      assert.equal(ignored('dist/src/__tests/example.test.ts'), true)
      assert.equal(ignored('xstryker-tmp/src/__tests/example.test.ts'), false)
    }
    const tests = config.testPathIgnorePatterns.map(
      pattern =>
        new RegExp(pattern.replace('<rootDir>', root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    )
    assert.equal(
      tests.some(pattern => pattern.test(`${root}/node_modules/dependency/example.test.ts`)),
      true
    )
  }
})

test('wallet recovery mutations clean only their own randomly named SQLite fixtures', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const name of ['codec', 'encoding', 'store', 'controller', 'plan']) {
    const target = targets[`wallet-recovery-${name}`]
    assert.ok(Object.hasOwn(target.runnerOptions.jest.config, 'globalSetup'))
    assert.equal(target.runnerOptions.jest.config.globalSetup, null)
    assert.ok(Object.hasOwn(target.runnerOptions.jest.config, 'globalTeardown'))
    assert.equal(target.runnerOptions.jest.config.globalTeardown, null)
    assert.deepEqual(target.runnerOptions.jest.config.setupFilesAfterEnv, [
      '<rootDir>/src/storage/actionRecovery/__test/fixtures/mutationDatabases.cjs'
    ])
    assert.equal(
      target.runnerOptions.jest.config.moduleNameMapper['^@bsv/sdk$'],
      path.resolve(REPOSITORY_ROOT, 'packages/sdk/mod.ts')
    )
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/src/signer/actionRecovery/__test/*.test.ts'
      )
    )
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts'
      )
    )
  }
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

test('revenue spend partitions cover every source line once with the complete suite and thresholds', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const names = [
    'sdk-revenue-listing-funding',
    'sdk-revenue-listing-unlock',
    'sdk-revenue-listing-spend'
  ]
  const source = 'src/script/templates/RevenueListingSpend.ts'
  let nextLine = 1
  for (const name of names) {
    const definition = targets[name]
    const [scope] = definition.mutate
    const [file, range] = scope.split(':')
    const [start, end] = range.split('-').map(Number)
    assert.equal(file, source)
    assert.equal(start, nextLine)
    assert.ok(end >= start)
    nextLine = end + 1
    assert.deepEqual(
      definition.runnerOptions.jest.config.testMatch,
      targets[names[0]].runnerOptions.jest.config.testMatch
    )
    const registration = policy.targets.find(target => target.id === name)
    assert.equal(registration.minimumScore, 90)
    assert.equal(registration.maximumInvalid, 0)
    assert.equal(registration.maximumNoCoverage, 0)
  }
  assert.equal(
    nextLine - 1,
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'packages/sdk', source), 'utf8').split('\n').length
  )
})

test('action store partitions retain every source line, test and independent critical gate', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const names = [
    'wallet-recovery-installation',
    'wallet-recovery-store',
    'wallet-recovery-transitions'
  ]
  const source = 'src/storage/actionRecovery/SQLiteActionRecoveryStore.ts'
  let nextLine = 1
  for (const name of names) {
    const definition = targets[name]
    assert.equal(definition.mutate.length, 1)
    const [file, range] = definition.mutate[0].split(':')
    const [start, end] = range.split('-').map(Number)
    assert.equal(file, source)
    assert.equal(start, nextLine)
    assert.ok(end >= start)
    nextLine = end + 1
    assert.deepEqual(definition.runnerOptions, targets[names[0]].runnerOptions)
    assert.deepEqual(definition.additionalInputs, targets[names[0]].additionalInputs)
    const registration = policy.targets.find(target => target.id === name)
    assert.equal(registration.minimumScore, 90)
    assert.equal(registration.maximumInvalid, 0)
    assert.equal(registration.maximumNoCoverage, 0)
  }
  assert.equal(
    nextLine - 1,
    fs
      .readFileSync(path.join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox', source), 'utf8')
      .split('\n').length
  )
})

test('root eviction partitions retain the complete source set, tests and independent critical gates', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const names = [
    'root-eviction-journal',
    'root-eviction-records',
    'root-eviction-storage',
    'root-eviction-coordination',
    'root-eviction-maintenance',
    'root-eviction-codec',
    'root-eviction-service'
  ]
  const files = names.flatMap(name => targets[name].mutate)
  assert.equal(new Set(files).size, files.length)
  assert.deepEqual(
    files.toSorted(),
    [
      'RootEvictionService',
      'RootEvictionCodec',
      'RootEvictionContractRecords',
      'RootEvictionCoordinatedStorage',
      'RootEvictionRecoveryStorage',
      'RootEvictionMaintenanceStorage',
      'SQLiteRootEvictionMaintenance',
      'RootEvictionRequests',
      'RootEvictionServingRecords',
      'RootEvictionStorage',
      'SQLiteRootEvictionDatabase',
      'SQLiteRootEvictionStore'
    ]
      .map(name => `src/root-eviction/${name}.ts`)
      .toSorted()
  )
  const { maxTestRunnerReuse: rootReuse, ...canonicalRunner } = targets[names[0]].runnerOptions
  assert.equal(rootReuse, 8)
  assert.equal(new Set(names.map(name => targets[name].propertyTest)).size, names.length)
  for (const name of names) {
    const definition = targets[name]
    assert.deepEqual(definition.runnerOptions, {
      ...canonicalRunner,
      ...([
        'root-eviction-coordination',
        'root-eviction-journal',
        'root-eviction-records',
        'root-eviction-codec',
        'root-eviction-storage'
      ].includes(name)
        ? { maxTestRunnerReuse: 8 }
        : {})
    })
    assert.deepEqual(definition.additionalInputs, targets[names[0]].additionalInputs)
    assert.deepEqual(definition.runnerOptions.jest.config.testMatch, [
      '<rootDir>/test/root-eviction*.test.ts'
    ])
    const registration = policy.targets.find(target => target.id === name)
    assert.equal(registration.minimumScore, 90)
    assert.equal(registration.maximumInvalid, 0)
    assert.equal(registration.maximumNoCoverage, 0)
  }
})

test('wallet recovery encoding and descriptors retain complete modules and the same full test selection', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const registry = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const names = ['wallet-recovery-codec', 'wallet-recovery-encoding']
  assert.deepEqual(names.flatMap(name => targets[name].mutate).toSorted(), [
    'src/storage/actionRecovery/ActionRecoveryCodec.ts',
    'src/storage/actionRecovery/ActionRecoveryEncoding.ts',
    'src/storage/actionRecovery/ActionRecoveryEncodingLimits.ts',
    'src/storage/actionRecovery/ActionRecoveryJSON.ts'
  ])
  for (const name of names) {
    assert.deepEqual(targets[name].runnerOptions, targets[names[0]].runnerOptions)
    assert.deepEqual(targets[name].additionalInputs, targets[names[0]].additionalInputs)
    assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, targets[name].propertyTest)))
    const entry = registry.targets.find(entry => entry.id === name)
    assert.equal(entry.minimumScore, 90)
    assert.equal(entry.maximumNoCoverage, 0)
    assert.equal(entry.maximumInvalid, 0)
  }
})

test('lookup work extraction retains the full legacy service selection and the complete shared helper', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['output-lookup-service']
  assert.deepEqual(target.mutate, [
    'src/lookup/LookupProviderService.ts',
    'src/lookup/LookupProviderContracts.ts',
    'src/lookup/LookupProviderWork.ts',
    'src/internal/BoundedOutputWork.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/lookup-provider.test.ts',
    '<rootDir>/test/lookup-provider-feed.test.ts',
    '<rootDir>/test/lookup-provider-work.test.ts',
    '<rootDir>/test/lookup-session.test.ts',
    '<rootDir>/test/lookup-provider-work.test.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/lookup-provider-work.test.ts'
  )
  assert.ok(target.additionalInputs.includes('src/internal/BoundedOutputWork.ts'))
})

test('lineage layout and traversal targets cover every complete implementation with identical complete tests and gates', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const names = ['revenue-lineage-graph', 'revenue-lineage-traversal']
  const { maxTestRunnerReuse, ...canonicalRunner } = targets[names[0]].runnerOptions
  assert.equal(maxTestRunnerReuse, 8)
  const sources = names.flatMap(name => targets[name].mutate)
  assert.equal(new Set(sources).size, sources.length)
  assert.deepEqual(sources.toSorted(), [
    'src/revenue-listing/LineageGraph.ts',
    'src/revenue-listing/LineageLayout.ts',
    'src/revenue-listing/LineageTransition.ts'
  ])
  assert.deepEqual(targets['revenue-lineage-graph'].mutate, [
    'src/revenue-listing/LineageLayout.ts',
    'src/revenue-listing/LineageTransition.ts'
  ])
  assert.deepEqual(targets['revenue-lineage-traversal'].mutate, [
    'src/revenue-listing/LineageGraph.ts'
  ])
  for (const name of names) {
    const target = targets[name]
    assert.deepEqual(target.runnerOptions, {
      ...canonicalRunner,
      ...(name === 'revenue-lineage-graph' ? { maxTestRunnerReuse: 8 } : {})
    })
    assert.deepEqual(target.additionalInputs, targets[names[0]].additionalInputs)
    const gate = policy.targets.find(candidate => candidate.id === name)
    assert.equal(gate.minimumScore, 90)
    assert.equal(gate.maximumNoCoverage, 0)
    assert.equal(gate.maximumInvalid, 0)
  }
  assert.deepEqual(targets[names[0]].runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/revenue-lineage.test.ts',
    '<rootDir>/test/revenue-lineage-work.test.ts',
    '<rootDir>/test/revenue-lineage-package.test.ts',
    '<rootDir>/test/revenue-lineage-graph.test.ts',
    '<rootDir>/test/revenue-lineage.property.test.ts',
    '<rootDir>/test/revenue-lineage-package.property.test.ts',
    '<rootDir>/test/revenue-lineage-graph.property.test.ts',
    '<rootDir>/test/revenue-lineage-traversal.property.test.ts'
  ])
})

test('root HTTP target covers both full modules and its actual authentication/storage inputs', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const target = targets['overlay-root-eviction-http']
  assert.deepEqual(target.mutate, ['src/RootEvictionRoutes.ts', 'src/RootEvictionHTTPPolicy.ts'])
  for (const input of [
    'src/__tests__/RootEvictionRoutes.fixture.ts',
    'src/RootEvictionHTTPPorts.ts',
    'src/RootEvictionResponseGuard.ts',
    'src/OutputLookupHTTPPolicy.ts',
    '../../application/output-knowledge/src/root-eviction/**',
    '../../application/output-knowledge/src/internal/**',
    '../../sdk/src/**',
    '../../middleware/auth-express-middleware/src/**'
  ])
    assert.ok(target.additionalInputs.includes(input))
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests__/RootEvictionRoutes*.test.ts'
  ])
  const mutation = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = mutation.targets.find(value => value.id === 'overlay-root-eviction-http')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('finite HTTP extraction preserves existing authentication ranges and adds independent root coverage', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const shared = 'src/overlay-tools/internal/OutputFiniteHTTP.ts'
  assert.ok(targets['sdk-auth-http'].mutate.includes('src/overlay-tools/OutputLookupTransport.ts'))
  assert.ok(targets['sdk-auth-http'].mutate.includes(shared))
  assert.ok(
    targets['sdk-auth-http'].runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts'
    )
  )
  const target = targets['sdk-root-eviction-http']
  assert.deepEqual(target.mutate, ['src/overlay-tools/OutputRootEvictionTransport.ts', shared])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
  ])
  const mutation = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = mutation.targets.find(value => value.id === 'sdk-root-eviction-http')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('root scheduling retains a complete source target and generated lifecycle schedules', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['root-eviction-scheduler']
  assert.deepEqual(target.mutate, ['src/root-eviction/RootEvictionScheduler.ts'])
  assert.ok(target.additionalInputs.includes('test/root-eviction-scheduler-fixture.ts'))
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/root-eviction-scheduler*.test.ts'
  ])
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(value => value.id === 'root-eviction-scheduler')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('root local rules retain complete new sources and every prior root storage target', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const target = targets['root-eviction-local-rules']
  assert.deepEqual(target.mutate, [
    'src/root-eviction/SQLiteRootEvictionLocalRules.ts',
    'src/root-eviction/RootEvictionLocalRuleSchema.ts',
    'src/root-eviction/RootEvictionLocalRules.ts'
  ])
  assert.ok(target.additionalInputs.includes('test/fixtures/root-local-rules-worker.mjs'))
  assert.ok(
    targets['root-eviction-storage'].mutate.includes(
      'src/root-eviction/SQLiteRootEvictionDatabase.ts'
    )
  )
  assert.ok(
    targets['root-eviction-records'].mutate.includes(
      'src/root-eviction/RootEvictionServingRecords.ts'
    )
  )
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(value => value.id === 'root-eviction-local-rules')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('local advertisement verification retains the full signed-request source and test union', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['root-eviction-evidence']
  assert.deepEqual(target.mutate, [
    'src/root-eviction/SDKRootEvictionEvidence.ts',
    'src/root-eviction/SDKRootAdvertisementEvidence.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/root-advertisement-evidence*.test.ts'
  ])
  assert.ok(target.additionalInputs.includes('src/SDKEvidenceVerifier.ts'))
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(value => value.id === 'root-eviction-evidence')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('proposal admission retains its complete source and generated provenance tests', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['overlay-proposal-admission']
  assert.deepEqual(target.mutate, ['src/ProposalAdmission.ts', 'src/RetainedTopicAdmission.ts'])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests/ProposalAdmission.test.ts',
    '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, [
    'src/EngineAdmission.ts',
    'src/storage/AdmissionStorage.ts',
    'src/__tests/ProposalAdmissionFixture.ts'
  ])
  const mutationPolicy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = mutationPolicy.targets.find(
    value => value.id === 'overlay-proposal-admission'
  )
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('private publication admission retains both complete sources and original proposal regressions', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['overlay-private-publication-admission']
  assert.deepEqual(target.mutate, [
    'src/PrivatePublicationAdmission.ts',
    'src/RetainedTopicAdmission.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests/PrivatePublicationAdmission.test.ts',
    '<rootDir>/src/__tests/PrivatePublicationAdmission.property.test.ts',
    '<rootDir>/src/__tests/ProposalAdmission.test.ts',
    '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, [
    'src/EngineAdmission.ts',
    'src/storage/AdmissionStorage.ts',
    'src/ProposalAdmission.ts',
    'src/__tests/ProposalAdmissionFixture.ts',
    'src/__tests/PrivatePublicationAdmissionFixture.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(
    value => value.id === 'overlay-private-publication-admission'
  )
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, target.manifest), 'utf8'))
  assert.match(manifest.scripts['test:property'], /PrivatePublicationAdmission\.property\.test\.ts/)
  assert.deepEqual(manifest.typesVersions['*']['private-publication-admission'], [
    'dist/types/src/PrivatePublicationAdmission.d.ts'
  ])
  assert.equal(
    manifest.exports['./private-publication-admission'].import.default,
    './dist/esm/src/PrivatePublicationAdmission.js'
  )
  assert.equal(
    manifest.exports['./private-publication-admission'].require.default,
    './dist/cjs/src/PrivatePublicationAdmission.js'
  )
})

test('proposal send qualification retains the entire SQLite journal and all journal/service/send regressions', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['proposal-journal-send']
  assert.deepEqual(target.mutate, [
    'src/proposals/SQLiteProposalJournal.ts',
    'src/proposals/SQLiteProposalJournalStore.ts',
    'src/proposals/ProposalJournalState.ts',
    'src/storage/SQLiteTransactionDomain.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/proposal-journal*.test.ts',
    '<rootDir>/test/proposal-storage-channel.test.ts',
    '<rootDir>/test/proposal-feed-writer.test.ts',
    '<rootDir>/test/sqlite-transaction-domain.test.ts',
    '<rootDir>/test/proposal-service*.test.ts',
    '<rootDir>/test/proposal-send*.test.ts',
    '<rootDir>/test/proposal-open.test.ts',
    '<rootDir>/test/proposal-recovery.test.ts'
  ])
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build')
  assert.deepEqual(target.runnerOptions.testRunnerNodeArgs, ['--experimental-vm-modules'])
  const mutationPolicy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = mutationPolicy.targets.find(value => value.id === 'proposal-journal-send')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('proposal disclosure qualification retains its entire authority boundary and generated native-enqueue cases', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['proposal-response-disclosure']
  assert.deepEqual(target.mutate, ['src/proposals/ProposalResponseDisclosure.ts'])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/proposal-disclosure*.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, [
    'src/internal/asyncValues.ts',
    'src/internal/pendingWork.ts',
    'src/internal/synchronousPromise.ts',
    'src/proposals/**',
    'test/proposal-*.ts'
  ])
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(value => value.id === 'proposal-response-disclosure')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('proposal HTTP qualification retains complete transport modules and actual signed HTTP plus host integration cases', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['overlay-proposal-http']
  assert.deepEqual(target.mutate, [
    'src/ProposalRoutes.ts',
    'src/ProposalResponseGuard.ts',
    'src/ProposalHTTPPolicy.ts',
    'src/ProposalHTTPPorts.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests__/Proposal*.test.ts',
    '<rootDir>/src/__tests__/OverlayExpress.test.ts'
  ])
  assert.ok(target.additionalInputs.includes('../../application/output-knowledge/src/proposals/**'))
  assert.ok(target.additionalInputs.includes('src/OverlayExpress.ts'))
  const policy = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const registration = policy.targets.find(value => value.id === 'overlay-proposal-http')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('proposal client retains complete operation and shared finite HTTP qualification', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['output-proposal-http']
  assert.deepEqual(target.mutate, [
    'src/overlay-tools/OutputProposalTransport.ts',
    'src/overlay-tools/internal/OutputFiniteHTTP.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/overlay-tools/__tests/OutputProposalTransport*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
    '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
  ])
  const registration = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  ).targets.find(value => value.id === 'output-proposal-http')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('proposal maintenance qualifies whole inventory and scheduler modules with native and generated recovery', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['proposal-maintenance']
  assert.deepEqual(target.mutate, [
    'src/proposals/ProposalMaintenance.ts',
    'src/proposals/ProposalScheduler.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/proposal-maintenance*.test.ts',
    '<rootDir>/test/proposal-scheduler*.test.ts',
    '<rootDir>/test/proposal-recovery.test.ts',
    '<rootDir>/test/proposal-open.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, [
    'src/internal/asyncValues.ts',
    'src/internal/pendingWork.ts',
    'src/internal/synchronousPromise.ts',
    'src/proposals/**',
    'test/proposal-*.ts'
  ])
  const registration = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  ).targets.find(value => value.id === 'proposal-maintenance')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
})

test('output knowledge discovery ignores nested generated sandboxes without hiding a live mutation root', async () => {
  const { default: config } =
    await import('../packages/application/output-knowledge/jest.config.js')
  assert.deepEqual(config.testMatch, ['<rootDir>/test/**/*.test.ts'])
  assert.deepEqual(config.modulePathIgnorePatterns, [String.raw`<rootDir>/\.stryker-tmp/`])
  const owns = root =>
    new RegExp(
      config.modulePathIgnorePatterns[0].replace(
        '<rootDir>',
        root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
    )
  assert.equal(
    owns('/workspace/package').test('/workspace/package/.stryker-tmp/abandoned/package.json'),
    true
  )
  assert.equal(owns('/workspace/package').test('/workspace/package/test/current.test.ts'), false)
  assert.equal(
    owns('/workspace/package/.stryker-tmp/live').test(
      '/workspace/package/.stryker-tmp/live/test/current.test.ts'
    ),
    false
  )
  assert.equal(
    owns('/workspace/package/.stryker-tmp/live').test(
      '/workspace/package/.stryker-tmp/live/.stryker-tmp/old/package.json'
    ),
    true
  )
})

test('protected ledger has no reduced mutation or property acceptance gate', () => {
  const registration = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  ).targets.find(target => target.id === 'protected-ledger')
  assert.equal(registration.minimumScore, 90)
  assert.equal(registration.maximumNoCoverage, 0)
  assert.equal(registration.maximumInvalid, 0)
  assert.ok(policy.propertyTesting.suites.some(suite => suite.path === registration.propertyTest))
})
