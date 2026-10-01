import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

import {
  REPOSITORY_ROOT,
  calculateMutationMetrics,
  evaluateMutationReport,
  parseArguments,
  selectAffectedMutationTargets,
  targetsForUnresolvedMutationRange
} from './mutation-testing.mjs'

const targets = {
  one: { packageDirectory: 'packages/one' },
  two: { packageDirectory: 'packages/two' }
}

test('proposal client and core qualify complete modules and retain cross-layer expiry coverage', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(Object.keys(configured).length, 104)
  const client = configured['proposal-client-verification']
  assert.deepEqual(client.mutate, [
    'src/proposals/ProposalSourcePolicy.ts',
    'src/proposals/ProposalVerificationPool.ts',
    'src/proposals/ProposalLocalFrame.ts',
    'src/proposals/ProposalPolicyRegistry.ts'
  ])
  const core = configured['output-knowledge-proposal-core']
  assert.deepEqual(core.mutate, [
    'src/BitcoinKnowledge.ts',
    'src/BitcoinKnowledgeState.ts',
    'src/KnowledgeStore.ts',
    'src/proposals/ProposalLocalState.ts',
    'src/proposals/ProposalKnowledgeView.ts'
  ])
  const runtime = configured['output-knowledge-runtime']
  assert.deepEqual(runtime.mutate, ['src/OutputKnowledge.ts'])
  for (const name of ['runtime', 'runtime-publication.property', 'proposal-bitcoin-core'])
    assert.ok(
      runtime.runnerOptions.jest.config.testMatch.includes(`<rootDir>/test/${name}.test.ts`)
    )
  for (const name of [
    'bitcoin-knowledge',
    'knowledge-store',
    'local-replay-compatibility',
    'currentness',
    'runtime',
    'runtime-publication.property',
    'membership',
    'quarantine',
    'verification-ledger',
    'reconciliation',
    'proposal-bitcoin-core',
    'proposal-knowledge-view',
    'knowledge-read-window',
    'proposal-core.property'
  ])
    assert.ok(core.runnerOptions.jest.config.testMatch.includes(`<rootDir>/test/${name}.test.ts`))
  for (const target of [client, core, runtime])
    assert.ok(target.additionalInputs.includes('src/proposals/**'))
  const selected = selectAffectedMutationTargets(configured, [
    'packages/application/output-knowledge/test/proposal-bitcoin-core.test.ts'
  ])
  assert.ok(selected.includes('output-knowledge-runtime'))
  assert.ok(selected.includes('output-knowledge-proposal-core'))
})

test('mutation metrics follow Stryker valid-mutant semantics', () => {
  const metrics = calculateMutationMetrics([
    { status: 'Killed' },
    { status: 'Timeout' },
    { status: 'Survived' },
    { status: 'NoCoverage' },
    { status: 'RuntimeError' },
    { status: 'CompileError' },
    { status: 'Ignored' }
  ])

  assert.equal(metrics.detected, 2)
  assert.equal(metrics.undetected, 2)
  assert.equal(metrics.valid, 4)
  assert.equal(metrics.score, 50)
})

test('mutation command parsing rejects missing values and conflicting modes', () => {
  assert.deepEqual(parseArguments(['--target', 'one', '--target', 'two']), {
    all: false,
    list: false,
    targets: ['one', 'two'],
    affectedFile: undefined,
    base: undefined
  })
  assert.throws(() => parseArguments(['--target']), /requires an exact target ID/)
  assert.throws(() => parseArguments(['--affected-file']), /requires a path/)
  assert.throws(() => parseArguments(['--all', '--target', 'one']), /exactly one/)
})

test('affected mutation selection follows exact target inputs and changed governance entries', () => {
  const preciseTargets = {
    one: {
      packageDirectory: 'packages/one',
      manifest: 'packages/one/package.json',
      propertyTest: 'packages/one/test/value.property.test.ts',
      mutate: ['src/value.ts'],
      runnerOptions: {
        jest: {
          configFile: 'jest.config.js',
          config: { testMatch: ['<rootDir>/test/value*.test.ts'] }
        }
      }
    },
    two: {
      packageDirectory: 'packages/two',
      manifest: 'packages/two/package.json',
      mutate: ['src/other.ts'],
      runnerOptions: { jest: { configFile: 'jest.config.js' } }
    }
  }
  assert.deepEqual(selectAffectedMutationTargets(preciseTargets, ['packages/one/src/value.ts']), [
    'one'
  ])
  assert.deepEqual(
    selectAffectedMutationTargets(preciseTargets, ['packages/one/src/unrelated.ts']),
    []
  )
  assert.deepEqual(
    selectAffectedMutationTargets(preciseTargets, ['governance/mutation-testing/policy.json'], {
      changedTargetIds: ['two']
    }),
    ['two']
  )
  assert.deepEqual(
    selectAffectedMutationTargets(preciseTargets, ['pnpm-lock.yaml'], {
      changedImporters: ['packages/one']
    }),
    ['one']
  )
  assert.deepEqual(selectAffectedMutationTargets(targets, ['docs/about/contributing.md']), [])
  assert.deepEqual(selectAffectedMutationTargets(targets, ['package.json']), ['one', 'two'])
  assert.deepEqual(selectAffectedMutationTargets(targets, ['.github/workflows/ci.yml']), [])
  assert.deepEqual(selectAffectedMutationTargets(targets, ['scripts/mutation-testing.mjs']), [])
})

test('mutation selection survives source edits that invalidate previous range markers', () => {
  const rangedTargets = {
    auth: {
      mutate: ['src/auth/Transport.ts:10-20']
    },
    wallet: {
      mutate: ['src/wallet/Wallet.ts:30-40']
    }
  }

  assert.deepEqual(
    targetsForUnresolvedMutationRange(
      rangedTargets,
      new Error('Unable to resolve mutation range in src/auth/Transport.ts: old .. new')
    ),
    ['auth', 'wallet']
  )
  assert.deepEqual(
    targetsForUnresolvedMutationRange(
      rangedTargets,
      new Error('Unable to resolve mutation range in src/removed/File.ts: old .. new')
    ),
    ['auth', 'wallet']
  )
  assert.deepEqual(targetsForUnresolvedMutationRange(rangedTargets, new Error('unexpected')), [
    'auth',
    'wallet'
  ])
})

test('mutation report evaluation ratchets score, coverage, and invalid outcomes', () => {
  const policy = {
    targets: [
      {
        id: 'one',
        minimumScore: 75,
        maximumNoCoverage: 0,
        maximumInvalid: 0
      }
    ]
  }
  assert.deepEqual(
    evaluateMutationReport(
      'one',
      {
        score: 74.99,
        counts: { Killed: 3, Survived: 1, NoCoverage: 1, RuntimeError: 1 }
      },
      policy
    ),
    [
      'one mutation score 74.99 is below 75',
      'one has 1 no-coverage mutants; maximum is 0',
      'one has 1 invalid mutants; maximum is 0'
    ]
  )
})

// Each hosted campaign retains the complete regression selection; together the
// bounded jobs instrument the same six production modules exactly once.
test('live lookup mutation campaigns preserve complete source and test coverage', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const orchestration = configured['output-knowledge-live']
  const boundaries = configured['output-knowledge-live-boundaries']
  const combined = [...orchestration.mutate, ...boundaries.mutate]
  assert.equal(new Set(combined).size, combined.length)
  assert.deepEqual(
    combined.sort(),
    [
      'src/sources/LiveLookupConfiguration.ts',
      'src/sources/LiveLookupSource.ts',
      'src/sources/LookupSourceFraming.ts',
      'src/sources/LookupSourceGuard.ts',
      'src/sources/LookupSourceState.ts',
      'src/sources/LookupSourceWork.ts'
    ].sort()
  )
  assert.deepEqual(orchestration.runnerOptions, boundaries.runnerOptions)
  const selected = selectAffectedMutationTargets(configured, [
    'packages/application/output-knowledge/test/live-lookup-http.test.ts'
  ])
  assert.ok(selected.includes('output-knowledge-live'))
  assert.ok(selected.includes('output-knowledge-live-boundaries'))
})

test('provider mutation campaigns cover executable layers and follow shared fixture changes', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const names = Object.keys(configured).filter(id => id.startsWith('output-lookup-'))
  const files = names.flatMap(id => configured[id].mutate)
  assert.equal(new Set(files).size, files.length)
  assert.equal(new Set(files.map(file => file.replace(/:\d+-\d+$/, ''))).size, 23)
  assert.ok(files.includes('src/internal/BoundedOutputWork.ts'))
  const records = configured['output-lookup-session-records']
  const payloads = configured['output-lookup-session-payloads']
  assert.deepEqual(records.runnerOptions, payloads.runnerOptions)
  const recordPath = 'src/lookup/SQLiteLookupSessionRecords.ts'
  const ranges = [...records.mutate, ...payloads.mutate]
    .filter(file => file.startsWith(`${recordPath}:`))
    .map(file => file.split(':')[1].split('-').map(Number))
  assert.equal(ranges[0][0], 1)
  assert.equal(ranges[0][1] + 1, ranges[1][0])
  assert.equal(
    ranges[1][1],
    readFileSync(
      resolve(REPOSITORY_ROOT, 'packages/application/output-knowledge', recordPath),
      'utf8'
    ).split('\n').length
  )
  for (const fixture of [
    'test/lookup-provider-fixture.ts',
    'test/fixtures/lookup-session-process.mjs',
    'src/lookup/SQLiteLookupIndex.ts',
    'src/internal/BoundedOutputWork.ts'
  ]) {
    const selected = selectAffectedMutationTargets(configured, [
      `packages/application/output-knowledge/${fixture}`
    ])
    for (const name of names.filter(id => id !== 'output-lookup-codecs'))
      assert.ok(selected.includes(name), name)
  }
  assert.deepEqual(
    selectAffectedMutationTargets(configured, ['docs/guides/durable-live-lookup.md']),
    []
  )
})

test('HTTP mutation inputs follow its real provider dependency outside the package directory', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  for (const input of ['src/lookup/LookupProviderService.ts', 'test/lookup-provider-fixture.ts']) {
    const selected = selectAffectedMutationTargets(configured, [
      'packages/application/output-knowledge/' + input
    ])
    assert.ok(selected.includes('overlay-output-lookup-http'))
  }
})

test('lookup native enqueue qualification retains whole source and actual native HTTP cases', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const disclosure = configured['lookup-response-disclosure']
  assert.deepEqual(disclosure.mutate, ['src/lookup/LookupResponseDisclosure.ts'])
  assert.equal(
    disclosure.propertyTest,
    'packages/application/output-knowledge/test/lookup-send.property.test.ts'
  )
  const sessions = configured['output-lookup-sessions']
  assert.deepEqual(sessions.mutate, ['src/lookup/SQLiteLookupSessions.ts'])
  assert.ok(
    sessions.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/lookup-native-send.test.ts'
    )
  )
  assert.ok(
    sessions.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/lookup-send.property.test.ts'
    )
  )
  const http = configured['overlay-output-lookup-http']
  assert.deepEqual(http.mutate, [
    'src/OutputLookupRoutes.ts',
    'src/OutputLookupHTTPPolicy.ts',
    'src/OutputLookupResponseGuard.ts'
  ])
  for (const name of [
    'OutputLookupRoutes',
    'OutputLookupRoutes.property',
    'OutputLookupNativeSend',
    'OutputLookupResponseGuard.driver'
  ])
    assert.ok(
      http.runnerOptions.jest.config.testMatch.includes(`<rootDir>/src/__tests__/${name}.test.ts`)
    )
  const input = 'packages/application/output-knowledge/src/lookup/LookupResponseDisclosure.ts'
  const selected = selectAffectedMutationTargets(configured, [input])
  for (const name of [
    'lookup-response-disclosure',
    'output-lookup-sessions',
    'overlay-output-lookup-http'
  ])
    assert.ok(selected.includes(name))
})

test('runtime publication qualification covers the complete runtime and its public lifecycle regressions', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['output-knowledge-runtime']
  assert.deepEqual(target.mutate, ['src/OutputKnowledge.ts'])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/runtime-publication.property.test.ts'
  )
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/runtime.test.ts',
    '<rootDir>/test/runtime-publication.property.test.ts',
    '<rootDir>/test/proposal-bitcoin-core.test.ts'
  ])
  const selected = selectAffectedMutationTargets(buildMutationTargets(REPOSITORY_ROOT), [
    'packages/application/output-knowledge/src/OutputKnowledge.ts'
  ])
  assert.ok(selected.includes('output-knowledge-runtime'))
})
