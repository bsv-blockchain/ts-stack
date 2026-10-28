import { readFileSync } from 'node:fs'

import { execFileSync } from 'node:child_process'

import { matchesGlob, resolve } from 'node:path'

import assert from 'node:assert/strict'

import test from 'node:test'

import { walletJournalSuites } from './wallet-journal-ci.mjs'

import {
  composedNativeTestFile,
  nativePairTestFile,
  nativeMergeTestFile,
  nativeAuthenticatedMergeTestFile,
  nativeReadTestFile,
  nativeUserTestFile,
  nativeIntegrityTestFile
} from './wallet-composed-native-ci.mjs'

import {
  applyWalletComponentTests,
  buildMutationTargets
} from '../governance/mutation-testing/targets.mjs'

import { createOverlayTestProjects } from '../packages/overlays/overlay-express/jest-projects.config.mjs'

import {
  calculateMutationMetrics,
  mutationTargetModule,
  evaluateMutationReport,
  parseArguments,
  REPOSITORY_ROOT,
  selectAffectedMutationTargets,
  strykerEnvironment,
  targetsForUnresolvedMutationRange
} from './mutation-testing.mjs'

const nativeFunctionalFiles = [
  composedNativeTestFile,
  nativePairTestFile,
  nativeMergeTestFile,
  nativeAuthenticatedMergeTestFile,
  nativeReadTestFile,
  nativeUserTestFile,
  nativeIntegrityTestFile
].map(file => file.slice('packages/wallet/wallet-toolbox/'.length))

const targets = {
  one: { packageDirectory: 'packages/one' },
  two: { packageDirectory: 'packages/two' }
}

test('each batch execution control selects every original canonical mutation target', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  for (const control of [
    'scripts/mutation-execution-batches.mjs',
    '.github/workflows/mutation-execution.yml'
  ])
    assert.deepEqual(
      selectAffectedMutationTargets(configured, [control]),
      Object.keys(configured),
      control
    )
})

test('every core overlay profile fingerprints its canonical and native fixture inputs', () => {
  for (const target of Object.values(buildMutationTargets(REPOSITORY_ROOT))) {
    if (target.packageDirectory !== 'packages/overlays/overlay') continue
    for (const input of ['jest.config.js', 'jest-projects.config.mjs'])
      assert.ok(target.additionalInputs.includes(input), `${target.propertyTest}: ${input}`)
    for (const input of [
      'src/__tests/mongo/**',
      'src/__tests/*Fixture.ts',
      'src/__tests/admission/**'
    ])
      assert.ok(
        target.additionalInputs.includes(input) || target.additionalInputs.includes('src/**'),
        `${target.propertyTest}: ${input}`
      )
  }
})

test('proposal client and core qualify complete modules and retain cross-layer expiry coverage', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(Object.keys(configured).length, 216)
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

test('current-channel query and projection register complete source modules and generated histories', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const query = configured['proposal-current-query']
  const projection = configured['proposal-current-projection']
  assert.deepEqual(query.mutate, [
    'src/proposals/ProposalChannelHeadsQuery.ts',
    'src/proposals/ProposalChannelHeadsContract.ts',
    'src/proposals/ProposalChannelHeadsSource.ts'
  ])
  assert.deepEqual(projection.mutate, [
    'src/proposals/ProposalCurrentChannels.ts',
    'src/SourceMembership.ts'
  ])
  for (const target of [query, projection]) {
    assert.equal(
      target.propertyTest,
      `packages/application/output-knowledge/test/proposal-${target === query ? 'channel' : 'current'}.property.test.ts`
    )
    for (const pattern of [
      'proposal-channel*',
      'proposal-current*',
      'proposal-knowledge-order',
      'source-generation-state',
      'membership'
    ])
      assert.ok(
        target.runnerOptions.jest.config.testMatch.includes(`<rootDir>/test/${pattern}.test.ts`)
      )
  }
  const selected = selectAffectedMutationTargets(configured, [
    'packages/application/output-knowledge/src/SourceMembership.ts',
    'packages/application/output-knowledge/src/proposals/ProposalChannelHeadsSource.ts'
  ])
  assert.ok(selected.includes('proposal-current-query'))
  assert.ok(selected.includes('proposal-current-projection'))
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
  assert.equal(metrics.unexecuted, 0)
})

test('mutation metrics count survivors whose runner executed no tests', () => {
  const metrics = calculateMutationMetrics([
    { status: 'Survived', testsCompleted: 0, coveredBy: ['0'] },
    { status: 'Survived', testsCompleted: 2, coveredBy: ['0'] },
    { status: 'Killed', testsCompleted: 0 },
    { status: 'NoCoverage', testsCompleted: 0 }
  ])

  assert.equal(metrics.unexecuted, 1)
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
        unexecuted: 1,
        counts: { Killed: 3, Survived: 1, NoCoverage: 1, RuntimeError: 1 }
      },
      policy
    ),
    [
      'one mutation score 74.99 is below 75',
      'one has 1 no-coverage mutants; maximum is 0',
      'one has 1 survived mutants that ran no tests; the test runner selected nothing, so the score is not evidence',
      'one has 1 invalid mutants; maximum is 0'
    ]
  )
})

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
  assert.equal(new Set(files.map(file => file.replace(/:\d+-\d+$/, ''))).size, 24)
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
    'src/storage/SQLiteTransactionDomain.ts',
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

test('compound proposal storage preserves all native implementations and canonical property input', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['proposal-channel-storage']
  assert.deepEqual(target.mutate, [
    'src/proposals/SQLiteProposalChannelStore.ts',
    'src/lookup/SQLiteLookupSessionBootstrap.ts',
    'src/proposals/SQLiteProposalFeedWriter.ts',
    'src/proposals/SQLiteProposalFeedInventory.ts',
    'src/proposals/ProposalChannelFeedCapacity.ts',
    'src/proposals/ProposalChannelFeedRecords.ts',
    'src/proposals/ProposalFeedPrivacy.ts',
    'src/proposals/AuthorDocumentPolicy.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/proposal-storage-channel.property.test.ts'
  )
  assert.ok(
    target.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/proposal-storage-channel*.test.ts'
    )
  )
  assert.ok(
    target.runnerOptions.jest.config.testMatch.includes('<rootDir>/test/lookup-native-send.test.ts')
  )
})

test('wallet recovery encoding covers every extracted implementation with the original canonical tests', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['wallet-recovery-encoding']
  assert.deepEqual(target.mutate, [
    'src/storage/actionRecovery/ActionRecoveryEncoding.ts',
    'src/storage/actionRecovery/ActionRecoveryEncodingLimits.ts',
    'src/storage/actionRecovery/ActionRecoveryJSON.ts',
    'src/storage/actionRecovery/ActionRecoveryJSONOwnership.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/storage/actionRecovery/__test/*.test.ts',
    '<rootDir>/src/signer/actionRecovery/__test/*.test.ts',
    '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
    '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
    '<rootDir>/src/signer/methods/__tests/completeSignedTransaction*.test.ts',
    '<rootDir>/src/utility/__tests__/ScriptTemplateBRC29.test.ts'
  ])
})

test('proposal signature qualification retains current policy and bounded-cache regressions', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['proposal-client-verification']
  assert.ok(target.mutate.includes('src/proposals/ProposalPolicyRegistry.ts'))
  assert.ok(
    target.runnerOptions.jest.config.testMatch.includes('<rootDir>/test/proposal-policy.test.ts')
  )
  assert.ok(
    target.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/proposal-signature-cache.test.ts'
    )
  )
})

test('compound mutation execution recycles workers without changing canonical work', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(targets['proposal-channel-storage'].runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(targets['proposal-client-verification'].runnerOptions.maxTestRunnerReuse, undefined)
  assert.equal(targets['wallet-recovery-encoding'].runnerOptions.maxTestRunnerReuse, undefined)
})

test('protected ledger retains complete storage and custody source with native canonical qualification', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['protected-ledger']
  assert.deepEqual(target.mutate, [
    'src/private/SQLiteProtectedLedger.ts',
    'src/private/ProtectedLedgerCodec.ts',
    'src/private/NodeProtectedPayloadCodec.ts',
    'src/private/NativeOutputBytes.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/protected-payload.test.ts',
    '<rootDir>/test/protected-payload-serialized.test.ts',
    '<rootDir>/test/protected-ledger-codec.test.ts',
    '<rootDir>/test/protected-ledger-integrity.test.ts',
    '<rootDir>/test/protected-ledger-boundaries.test.ts',
    '<rootDir>/test/protected-ledger-enumeration.test.ts',
    '<rootDir>/test/protected-ledger.test.ts',
    '<rootDir>/test/protected-ledger-batch.test.ts',
    '<rootDir>/test/protected-ledger.property.test.ts',
    '<rootDir>/test/protected-ledger-prepared.test.ts',
    '<rootDir>/test/private-purchase-native-clock.test.ts',
    '<rootDir>/test/private-purchase-native-clock.property.test.ts',
    '<rootDir>/test/private-purchase-state.property.test.ts',
    '<rootDir>/test/private-publication-lookup.test.ts',
    '<rootDir>/test/private-publication-lookup.property.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.ok(target.additionalInputs.includes('src/storage/**'))
  for (const input of [
    'test/private-purchase-store.fixture.ts',
    'test/private-purchase-progress.fixture.ts',
    'test/private-purchase-contract.fixture.ts',
    '../../sdk/src/**',
    '../../sdk/package.json'
  ])
    assert.ok(target.additionalInputs.includes(input))
})

test('lineage graph execution recycles workers without changing other application or wallet targets', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(targets['revenue-lineage-graph'].runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(targets['revenue-lineage-traversal'].runnerOptions.maxTestRunnerReuse, undefined)
  assert.equal(targets['wallet-recovery-encoding'].runnerOptions.maxTestRunnerReuse, undefined)
  assert.equal(targets['proposal-channel-storage'].runnerOptions.maxTestRunnerReuse, 8)
})

test('private publication retains every complete implementation and native restart selection', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['private-publication-state']
  assert.deepEqual(target.mutate, [
    'src/private/SQLitePrivatePublicationStore.ts',
    'src/private/PrivateServiceIdentity.ts',
    'src/private/PrivateServiceDomain.ts',
    'src/private/PrivatePublicationRecords.ts',
    'src/private/PrivatePublicationProgress.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-identity.test.ts',
    '<rootDir>/test/private-domain.test.ts',
    '<rootDir>/test/private-publication-records.test.ts',
    '<rootDir>/test/private-publication-progress.test.ts',
    '<rootDir>/test/private-publication-store.test.ts',
    '<rootDir>/test/private-publication.property.test.ts',
    '<rootDir>/test/private-publication-exclusion.test.ts',
    '<rootDir>/test/private-verified-publication-store.test.ts',
    '<rootDir>/test/private-verified-publication.property.test.ts',
    '<rootDir>/test/private-publication-availability.test.ts',
    '<rootDir>/test/private-publication-lookup.test.ts',
    '<rootDir>/test/private-publication-lookup.property.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.ok(target.additionalInputs.includes('test/private-publication-fixture.ts'))
})

test('measured root targets recycle workers while retaining complete canonical source and tests', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const selected = targets['root-eviction-coordination']
  assert.equal(selected.runnerOptions.maxTestRunnerReuse, 8)
  assert.deepEqual(selected.mutate, [
    'src/root-eviction/RootEvictionContractRecords.ts',
    'src/root-eviction/RootEvictionCoordinatedStorage.ts',
    'src/root-eviction/RootEvictionRecoveryStorage.ts'
  ])
  assert.deepEqual(selected.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/root-eviction*.test.ts',
    resolve(
      REPOSITORY_ROOT,
      'packages/overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts'
    )
  ])
  const recycled = new Set([
    'root-eviction-coordination',
    'root-eviction-journal',
    'root-eviction-records',
    'root-eviction-codec',
    'root-eviction-storage'
  ])
  for (const [id, target] of Object.entries(targets)) {
    if (id.startsWith('root-eviction-')) {
      assert.equal(target.runnerOptions.maxTestRunnerReuse, recycled.has(id) ? 8 : undefined, id)
      if (recycled.has(id))
        assert.deepEqual(
          target.runnerOptions.jest.config.testMatch,
          selected.runnerOptions.jest.config.testMatch
        )
    }
  }
  assert.equal(targets['wallet-recovery-encoding'].runnerOptions.maxTestRunnerReuse, undefined)
})

test('verified private service retains every complete source and all canonical native evidence', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['private-publication-service']
  assert.deepEqual(target.mutate, [
    'src/private/SDKPrivatePublicationEvidence.ts',
    'src/private/PrivatePublicationContracts.ts',
    'src/private/PrivatePublicationContractRecord.ts',
    'src/private/PrivateLookupBinding.ts',
    'src/private/PrivatePublicationServiceRecords.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-identity.test.ts',
    '<rootDir>/test/private-domain.test.ts',
    '<rootDir>/test/private-publication-records.test.ts',
    '<rootDir>/test/private-publication-progress.test.ts',
    '<rootDir>/test/private-publication-store.test.ts',
    '<rootDir>/test/private-publication.property.test.ts',
    '<rootDir>/test/private-publication-exclusion.test.ts',
    '<rootDir>/test/private-verified-publication-store.test.ts',
    '<rootDir>/test/private-verified-publication.property.test.ts',
    '<rootDir>/test/private-publication-evidence.test.ts',
    '<rootDir>/test/private-publication-contract.test.ts',
    '<rootDir>/test/private-lookup-binding.test.ts',
    '<rootDir>/test/private-publication-service-records.test.ts',
    '<rootDir>/test/private-publication-availability.test.ts',
    '<rootDir>/test/private-publication-lookup.test.ts',
    '<rootDir>/test/private-publication-lookup.property.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.ok(target.additionalInputs.includes('test/fixtures/**'))
})

test('private publication composition retains its complete sources and canonical native integrations', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const coordination = targets['private-publication-coordination']
  assert.deepEqual(coordination.mutate, [
    'src/private/PrivatePublicationVerificationLeases.ts',
    'src/private/PrivatePublicationAccess.ts',
    'src/private/PrivatePublicationPorts.ts',
    'src/private/PrivatePublicationCoordinator.ts',
    'src/private/PrivatePublicationDisclosure.ts',
    'src/private/PrivatePublicationWork.ts',
    'src/private/PrivatePublicationReconciler.ts'
  ])
  assert.deepEqual(coordination.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-identity.test.ts',
    '<rootDir>/test/private-domain.test.ts',
    '<rootDir>/test/private-publication-records.test.ts',
    '<rootDir>/test/private-publication-progress.test.ts',
    '<rootDir>/test/private-publication-store.test.ts',
    '<rootDir>/test/private-publication.property.test.ts',
    '<rootDir>/test/private-publication-exclusion.test.ts',
    '<rootDir>/test/private-verified-publication-store.test.ts',
    '<rootDir>/test/private-verified-publication.property.test.ts',
    '<rootDir>/test/private-publication-evidence.test.ts',
    '<rootDir>/test/private-publication-contract.test.ts',
    '<rootDir>/test/private-lookup-binding.test.ts',
    '<rootDir>/test/private-publication-service-records.test.ts',
    '<rootDir>/test/private-publication-availability.test.ts',
    '<rootDir>/test/private-publication-access.test.ts',
    '<rootDir>/test/private-publication-coordination.property.test.ts',
    '<rootDir>/test/private-publication-coordinator.test.ts',
    '<rootDir>/test/private-publication-disclosure.test.ts',
    '<rootDir>/test/private-publication-reconciler.test.ts',
    '<rootDir>/test/private-publication-verification-leases.test.ts',
    resolve(
      REPOSITORY_ROOT,
      'packages/overlays/overlay-express/src/__tests__/PrivatePublication*.integration.test.ts'
    ),
    '<rootDir>/test/private-publication-lookup.test.ts',
    '<rootDir>/test/private-publication-lookup.property.test.ts'
  ])
  const http = targets['private-publication-http']
  assert.deepEqual(http.mutate, [
    'src/PrivatePublicationHTTPPorts.ts',
    'src/PrivatePublicationHTTPPolicy.ts',
    'src/PrivatePublicationResponseGuard.ts',
    'src/PrivatePublicationRoutes.ts'
  ])
  assert.deepEqual(http.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests__/PrivatePublication*.test.ts'
  ])
  for (const id of ['private-publication-coordination', 'private-publication-http'])
    assert.equal(targets[id].runnerOptions.maxTestRunnerReuse, 8)
})

test('acquisition foundations retain five complete modules and native recovery/funding inputs', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['private-acquisition-foundation']
  assert.deepEqual(target.mutate, [
    'src/private/PrivateAcquisitionProgress.ts',
    'src/private/PrivateAcquisitionResult.ts',
    'src/private/PrivateAcquisitionFundingIndex.ts',
    'src/private/PrivateAcquisitionContracts.ts',
    'src/private/SDKPrivateAcquisitionFunding.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-acquisition-progress.test.ts',
    '<rootDir>/test/private-acquisition-result.test.ts',
    '<rootDir>/test/private-acquisition-funding-index.test.ts',
    '<rootDir>/test/private-acquisition-contracts.test.ts',
    '<rootDir>/test/private-acquisition-funding-evidence.test.ts',
    '<rootDir>/test/private-acquisition.property.test.ts',
    '<rootDir>/test/private-domain.test.ts',
    '<rootDir>/test/private-identity.test.ts',
    '<rootDir>/test/protected-ledger-codec.test.ts',
    '<rootDir>/test/protected-ledger-integrity.test.ts',
    '<rootDir>/test/protected-ledger-boundaries.test.ts',
    '<rootDir>/test/protected-ledger-enumeration.test.ts',
    '<rootDir>/test/protected-ledger.test.ts',
    '<rootDir>/test/protected-ledger-batch.test.ts',
    '<rootDir>/test/protected-ledger.property.test.ts'
  ])
  assert.ok(target.additionalInputs.includes('test/fixtures/**'))
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/private-acquisition.property.test.ts'
  )
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
})

test('proposal and lookup bounded recycling changes only the selected runner entries', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of ['proposal-journal-send', 'overlay-proposal-http', 'output-lookup-sessions'])
    assert.equal(targets[id].runnerOptions.maxTestRunnerReuse, 8)
  for (const id of [
    'output-lookup-index',
    'output-lookup-index-records',
    'output-lookup-session-records',
    'output-lookup-session-payloads'
  ])
    assert.equal(targets[id].runnerOptions.maxTestRunnerReuse, undefined)
})

test('acquisition state owns all four whole modules and preserves complete native canonical tests', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    target = targets['private-acquisition-state']
  assert.deepEqual(target.mutate, [
    'src/private/PrivateAcquisitionPayloads.ts',
    'src/private/PrivateAcquisitionRecords.ts',
    'src/private/PrivateAcquisitionState.ts',
    'src/private/SQLitePrivateAcquisitionStore.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-acquisition-payloads.test.ts',
    '<rootDir>/test/private-acquisition-records.test.ts',
    '<rootDir>/test/private-acquisition-state.test.ts',
    '<rootDir>/test/private-acquisition-store.test.ts',
    '<rootDir>/test/private-acquisition-process.test.ts',
    '<rootDir>/test/private-acquisition-state.property.test.ts',
    '<rootDir>/test/protected-payload.test.ts',
    '<rootDir>/test/protected-payload-serialized.test.ts',
    ...targets['private-acquisition-foundation'].runnerOptions.jest.config.testMatch
  ])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/private-acquisition-state.property.test.ts'
  )
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  for (const name of [
    'private-acquisition-records.fixture.ts',
    'private-acquisition-store.fixture.ts'
  ])
    assert.ok(target.additionalInputs.includes(`test/${name}`))
  assert.ok(target.additionalInputs.includes('test/fixtures/**'))
  assert.ok(
    targets['protected-ledger'].runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/protected-ledger-batch.test.ts'
    )
  )
})

test('acquisition coordination preserves every source, canonical state test and native wallet build input', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    target = targets['private-acquisition-coordination']
  assert.deepEqual(target.mutate, [
    'src/private/PrivateAcquisitionAccess.ts',
    'src/private/PrivateAcquisitionPorts.ts',
    'src/private/PrivateAcquisitionWallet.ts',
    'src/private/WalletToolboxAcquisitionFunding.ts',
    'src/private/SDKPrivateReleaseEvidence.ts',
    'src/private/PrivateAcquisitionCoordinator.ts',
    'src/private/PrivateAcquisitionDisclosure.ts',
    'src/private/PrivateAcquisitionWork.ts',
    'src/private/PrivateAcquisitionReconciler.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-acquisition-access.test.ts',
    '<rootDir>/test/private-acquisition-preparation.test.ts',
    '<rootDir>/test/private-acquisition-wallet.test.ts',
    '<rootDir>/test/private-acquisition-wallet-native.test.ts',
    '<rootDir>/test/private-release-evidence.test.ts',
    '<rootDir>/test/private-acquisition-coordinator.test.ts',
    '<rootDir>/test/private-acquisition-disclosure.test.ts',
    '<rootDir>/test/private-acquisition-recovery.test.ts',
    '<rootDir>/test/private-acquisition-coordination.property.test.ts',
    ...targets['private-acquisition-state'].runnerOptions.jest.config.testMatch
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(
    target.runnerOptions.buildCommand,
    `node ${resolve(REPOSITORY_ROOT, 'scripts/mutation-build.mjs').replaceAll(' ', '\\ ')} --dependency @bsv/wallet-toolbox`
  )
  for (const input of [
    '../../wallet/wallet-toolbox/src/**',
    '../../wallet/wallet-toolbox/package.json',
    '../../wallet/wallet-toolbox/tsconfig*.json',
    'test/private-acquisition-wallet.fixture.ts'
  ])
    assert.ok(target.additionalInputs.includes(input))
})

test('acquisition HTTP retains complete modules, native dependencies and every publication compatibility suite', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['private-acquisition-http']
  assert.deepEqual(target.mutate, [
    'src/PrivateAcquisitionHTTPPorts.ts',
    'src/PrivateAcquisitionHTTPPolicy.ts',
    'src/PrivateAcquisitionResponseGuard.ts',
    'src/PrivateAcquisitionRoutes.ts',
    'src/PrivateOverlayHost.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/__tests__/PrivateAcquisition*.test.ts',
    '<rootDir>/src/__tests__/PrivateOverlayHost*.test.ts',
    '<rootDir>/src/__tests__/PrivatePurchase*.test.ts',
    '<rootDir>/src/__tests__/PrivatePublication*.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(
    target.runnerOptions.buildCommand,
    `node ${resolve(REPOSITORY_ROOT, 'scripts/mutation-build.mjs').replaceAll(' ', '\\ ')} --dependency @bsv/wallet-toolbox --dependency @bsv/output-knowledge`
  )
  for (const input of [
    'src/OverlayExpress.ts',
    '../../wallet/wallet-toolbox/src/**',
    '../../wallet/wallet-toolbox/package.json',
    '../../wallet/wallet-toolbox/tsconfig*.json',
    '../../application/output-knowledge/src/**'
  ])
    assert.ok(target.additionalInputs.includes(input))
})

test('paid lookup and protected state retain whole-source and complete compatibility selections', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const paid = targets['sdk-paid-lookup-http']
  assert.deepEqual(paid.mutate, [
    'src/overlay-tools/OutputPaidLookupTransport.ts',
    'src/overlay-tools/internal/OutputFiniteHTTP.ts'
  ])
  for (const name of [
    'OutputPaidLookupTransport*.test.ts',
    'OutputPaidLookupFunding*.test.ts',
    'OutputProposalTransport*.test.ts',
    'OutputRootEvictionTransport*.test.ts',
    'OutputLookupTransport.test.ts'
  ])
    assert.ok(
      paid.runnerOptions.jest.config.testMatch.includes(
        `<rootDir>/src/overlay-tools/__tests/${name}`
      )
    )
  for (const id of ['sdk-auth-http', 'sdk-root-eviction-http', 'output-proposal-http'])
    assert.ok(
      targets[id].runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts'
      )
    )
  const protectedState = targets['protected-operation-state']
  assert.deepEqual(protectedState.mutate, [
    'src/operations/ProtectedOperationPayload.ts',
    'src/operations/WalletProtectedOperationPayload.ts',
    'src/operations/ProtectedOperationStateStore.ts'
  ])
  assert.deepEqual(protectedState.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/protected-operation*.test.ts',
    '<rootDir>/test/operation-state*.test.ts'
  ])
  assert.ok(
    protectedState.additionalInputs.includes('test/fixtures/protected-operation-worker.mjs')
  )
  assert.equal(protectedState.runnerOptions.buildCommand, 'pnpm build')
  const recovery = targets['wallet-recovery-controller']
  assert.deepEqual(recovery.mutate, [
    'src/signer/actionRecovery/RecoverableActionController.ts',
    'src/signer/methods/completeSignedTransaction.ts'
  ])
  assert.ok(
    recovery.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/signer/methods/__tests/completeSignedTransaction*.test.ts'
    )
  )
  assert.ok(
    recovery.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/utility/__tests__/ScriptTemplateBRC29.test.ts'
    )
  )
})

const currentAliasRegressionTests = [
  '<rootDir>/test/private-purchase-alias-owner.test.ts',
  '<rootDir>/test/private-purchase-alias-owner.property.test.ts',
  '<rootDir>/test/private-purchase-alias-currentness.test.ts',
  '<rootDir>/test/private-purchase-alias-currentness.property.test.ts',
  '<rootDir>/test/private-purchase-alias-coordinator.test.ts',
  '<rootDir>/test/private-purchase-alias-coordinator.property.test.ts',
  '<rootDir>/test/private-purchase-alias-disclosure.test.ts',
  '<rootDir>/test/private-purchase-alias-disclosure.property.test.ts',
  '<rootDir>/test/private-purchase-buyer-alias.test.ts',
  '<rootDir>/test/private-purchase-buyer-alias.property.test.ts'
]

test('immutable operation objects qualify all native/browser modules and complete retained compatibility', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    objects = configured['protected-operation-objects']
  assert.deepEqual(objects.mutate, [
    'src/operations/ProtectedOperationObjectStore.ts',
    'src/operations/ProtectedOperationObjectPlan.ts',
    'src/operations/SQLiteProtectedOperationObjectStore.ts',
    'src/operations/ProtectedOperationObjectCipher.ts',
    'src/operations/IndexedDBProtectedOperationObjectStore.ts'
  ])
  assert.deepEqual(objects.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/protected-operation*.test.ts',
    '<rootDir>/test/operation-state*.test.ts',
    '<rootDir>/test/protected-ledger*.test.ts',
    '<rootDir>/test/protected-payload.test.ts',
    '<rootDir>/test/protected-payload-serialized.test.ts',
    ...currentAliasRegressionTests
  ])
  assert.equal(objects.runnerOptions.buildCommand, 'pnpm build')
  assert.equal(objects.runnerOptions.maxTestRunnerReuse, 8)
  for (const id of ['protected-operation-objects', 'protected-operation-state'])
    for (const input of [
      'test/fixtures/protected-operation-object-worker.mjs',
      'test/protected-operation-object.fixture.ts',
      'src/private/**'
    ])
      assert.ok(configured[id].additionalInputs.includes(input))
})

test('durable buyer qualifies every complete owner and retains native one-action recovery evidence', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    buyer = configured['private-lookup-buyer']
  assert.deepEqual(buyer.mutate, [
    'src/private/PrivateLookupBuyer.ts',
    'src/private/PrivateLookupBuyerPorts.ts',
    'src/private/WalletToolboxBuyerPayment.ts',
    'src/private/buyer.ts'
  ])
  assert.deepEqual(buyer.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-lookup-buyer.test.ts',
    '<rootDir>/test/private-buyer-payment.test.ts',
    '<rootDir>/test/private-purchase-buyer*.test.ts',
    '<rootDir>/test/private-purchase-wallet-native*.test.ts'
  ])
  assert.equal(
    buyer.runnerOptions.buildCommand,
    `node ${resolve(REPOSITORY_ROOT, 'scripts/mutation-build.mjs').replaceAll(' ', '\\ ')} --dependency @bsv/wallet-toolbox`
  )
  assert.equal(buyer.runnerOptions.maxTestRunnerReuse, 8)
  for (const input of [
    'src/operations/**',
    '../../wallet/wallet-toolbox/src/**',
    '../../sdk/src/auth/**'
  ])
    assert.ok(buyer.additionalInputs.includes(input))
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/wallet/wallet-toolbox/src/signer/actionRecovery/RecoverableActionController.ts'
    ]).includes('private-lookup-buyer')
  )
})

test('optional LCH acquisition qualifies every whole module and its complete cryptographic test union', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['lch-overlay-acquisition']
  assert.deepEqual(target.mutate, [
    'src/overlayAcquisition.ts',
    'src/overlayAcquisitionCodec.ts',
    'src/overlayAcquisitionCollectorProfile.ts',
    'src/overlayAcquisitionPolicy.ts',
    'src/overlayAcquisitionTerms.ts',
    'src/overlayAcquisitionConsent.ts',
    'src/overlayAcquisitionAuthority.ts',
    'src/overlayAcquisitionSettlement.ts',
    'src/overlayAcquisitionCustody.ts',
    'src/overlayAcquisitionEntitlement.ts',
    'src/overlayAcquisitionPaid.ts',
    'src/overlayAcquisitionSeller.ts',
    'src/overlayAcquisitionVerification.ts',
    'src/overlayAcquisitionLicense.ts',
    'src/keyRecovery.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts',
    '<rootDir>/test/key-delivery.test.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-codec.property.test.ts'
  )
  assert.ok(target.additionalInputs.includes('../../application/output-knowledge/src/**'))
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
  assert.equal(
    JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, target.manifest), 'utf8')).scripts[
      'build:mutation'
    ],
    'pnpm --filter @bsv/output-knowledge build && pnpm build'
  )
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/content/lch/src/overlayAcquisitionPaid.ts'
    ]).includes('lch-overlay-acquisition')
  )
})

test('host qualification preserves complete selected unions in disjoint legacy and private module environments', () => {
  for (const target of Object.values(buildMutationTargets(REPOSITORY_ROOT))) {
    if (target.packageDirectory !== 'packages/overlays/overlay-express') continue
    const options = target.runnerOptions.jest.config,
      projects = options.projects,
      ordinary = projects.find(project => project.displayName === 'legacy-commonjs'),
      privateProject = projects.find(project => project.displayName === 'private-esm')
    assert.equal(projects.length, 2)
    assert.equal(ordinary.cacheDirectory, undefined)
    assert.equal(privateProject.cacheDirectory, undefined)
    assert.deepEqual(ordinary.testMatch, options.testMatch)
    assert.deepEqual(privateProject.testMatch, options.testMatch)
    assert.deepEqual(ordinary.extensionsToTreatAsEsm, [])
    assert.deepEqual(privateProject.extensionsToTreatAsEsm, ['.ts', '.tsx'])
    const transform = project => project.transform['^.+\\.tsx?$'][1]
    assert.equal(transform(ordinary).useESM, false)
    assert.equal(transform(ordinary).tsconfig, 'tsconfig.cjs.json')
    const legacyConfiguration = JSON.parse(
      readFileSync(
        resolve(REPOSITORY_ROOT, 'packages/overlays/overlay-express/tsconfig.cjs.json'),
        'utf8'
      )
    )
    assert.equal(legacyConfiguration.compilerOptions.module, 'commonjs')
    assert.equal(transform(privateProject).useESM, true)
    assert.equal(transform(privateProject).tsconfig.module, 'ESNext')
    for (const project of projects) {
      for (const [pattern, replacement] of Object.entries(options.moduleNameMapper ?? {}))
        assert.equal(project.moduleNameMapper[pattern], replacement)
      assert.equal(project.moduleNameMapper['^(\\.{1,2}/.*)\\.js$'], '$1')
      assert.equal(project.moduleNameMapper['^uuid$'], '<rootDir>/node_modules/uuid/dist/index.js')
    }
    assert.deepEqual(target.runnerOptions.testRunnerNodeArgs, ['--experimental-vm-modules'])
    const legacy = '/fixture/src/__tests__/OverlayExpress.test.ts',
      privatePath = '/fixture/src/__tests__/PrivateBuyerHTTP.integration.test.ts',
      ignores = (project, file) =>
        project.testPathIgnorePatterns.some(pattern => new RegExp(pattern).test(file))
    assert.equal(ignores(ordinary, legacy), false)
    assert.equal(ignores(privateProject, legacy), true)
    assert.equal(ignores(ordinary, privatePath), true)
    assert.equal(ignores(privateProject, privatePath), false)
    assert.ok(target.additionalInputs.includes('jest-projects.config.mjs'))
  }
})

test('overlay project options reach both complete partitions without changing module semantics', () => {
  const match = ['<rootDir>/src/__tests__/*.test.ts'],
    projects = createOverlayTestProjects(match, {
      testTimeout: 17000,
      moduleNameMapper: { '^fixture-owner$': '<rootDir>/src/__tests__/Owner.fixture.ts' }
    })
  for (const project of projects) {
    assert.deepEqual(project.testMatch, match)
    assert.equal(project.testTimeout, 17000)
    assert.equal(
      project.moduleNameMapper['^fixture-owner$'],
      '<rootDir>/src/__tests__/Owner.fixture.ts'
    )
    assert.equal(project.moduleNameMapper['^(\\.{1,2}/.*)\\.js$'], '$1')
    assert.equal(project.moduleNameMapper['^uuid$'], '<rootDir>/node_modules/uuid/dist/index.js')
  }
  assert.deepEqual(projects[0].extensionsToTreatAsEsm, [])
  assert.deepEqual(projects[1].extensionsToTreatAsEsm, ['.ts', '.tsx'])
})

test('relocated LCH overlay tests retain their independent application dependency and original local fallback', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const dependency = '../../../application/output-knowledge/src/private/PrivatePurchaseContracts.js'
  for (const id of [
    'lch-overlay-acquisition',
    'lch-overlay-covenant-terms',
    'lch-overlay-covenant-settlement',
    'lch-overlay-license',
    'lch-overlay-covenant-seller',
    'lch-overlay-covenant'
  ]) {
    const target = configured[id],
      mappings = Object.entries(target.runnerOptions.jest.config.moduleNameMapper)
    assert.equal(target.packageDirectory, 'packages/content/lch')
    assert.ok(target.additionalInputs.includes('../../application/output-knowledge/src/**'))
    assert.ok(target.additionalInputs.includes('test/overlay-acquisition*.ts'))
    assert.ok(
      target.additionalInputs.includes(
        '../../application/output-knowledge/test/revenue-profile.fixture.ts'
      )
    )
    for (const source of [
      'RevenueListingProfile.ts',
      'RevenueListingKeys.ts',
      'RevenueListingProfileSpend.ts'
    ])
      assert.ok(target.additionalInputs.includes(`../../sdk/src/script/templates/${source}`))
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/test/overlay-acquisition*.test.ts'
      )
    )
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes('<rootDir>/test/key-delivery.test.ts')
    )
    assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
    assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
    assert.deepEqual(target.runnerOptions.testRunnerNodeArgs, ['--experimental-vm-modules'])
    assert.equal(mappings.length, 2)
    assert.equal(
      dependency.replace(new RegExp(mappings[0][0]), mappings[0][1]),
      resolve(
        REPOSITORY_ROOT,
        'packages/application/output-knowledge/src/private/PrivatePurchaseContracts.ts'
      )
    )
    assert.equal(mappings[1][0], String.raw`^(\.{1,2}/.*)\.js$`)
    assert.equal(mappings[1][1], '$1')
    assert.equal(
      '../src/overlayAcquisition.js'.replace(new RegExp(mappings[1][0]), mappings[1][1]),
      '../src/overlayAcquisition'
    )
    assert.equal(new RegExp(mappings[0][0]).test('../src/overlayAcquisition.js'), false)
  }
  assert.equal(Object.keys(configured).length, 216)
})

test('compound private builds retain every dependency and append the sequential helper input', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    helper = resolve(REPOSITORY_ROOT, 'scripts/mutation-build.mjs').replaceAll(' ', '\\ '),
    expected = {
      'private-purchase-http': ['@bsv/wallet-toolbox', '@bsv/output-knowledge'],
      'private-acquisition-http': ['@bsv/wallet-toolbox', '@bsv/output-knowledge'],
      'private-acquisition-coordination': ['@bsv/wallet-toolbox'],
      'private-lookup-buyer': ['@bsv/wallet-toolbox'],
      'wallet-purchase-payment': ['@bsv/wallet-toolbox'],
      'private-purchase-buyer': ['@bsv/wallet-toolbox']
    }
  const changed = Object.entries(configured)
    .filter(([, target]) => target.runnerOptions?.buildCommand?.startsWith('node ' + helper))
    .map(([id]) => id)
  assert.deepEqual(changed.sort(), Object.keys(expected).sort())
  for (const [id, dependencies] of Object.entries(expected)) {
    const target = configured[id]
    assert.equal(
      target.runnerOptions.buildCommand,
      ['node', helper, ...dependencies.flatMap(name => ['--dependency', name])].join(' ')
    )
    assert.equal(
      target.additionalInputs.filter(input => input === '../../../scripts/mutation-build.mjs')
        .length,
      1
    )
  }
  assert.deepEqual(
    selectAffectedMutationTargets(configured, ['scripts/mutation-build.mjs']),
    Object.keys(configured)
  )
})

test('prepared purchases qualify the complete verifier and full association suite without a source partition', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['revenue-listing-purchase']
  assert.deepEqual(target.mutate, ['src/revenue-listing/RevenueListingPurchaseVerifier.ts'])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/revenue-purchase.test.ts',
    '<rootDir>/test/revenue-purchase.property.test.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/revenue-purchase.property.test.ts'
  )
  for (const input of [
    'test/revenue-purchase*.ts',
    'test/revenue-lineage-fixture.ts',
    'test/revenue-authority-fixture.ts',
    'test/fixtures/revenue-listing/**'
  ])
    assert.ok(target.additionalInputs.includes(input))
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/application/output-knowledge/test/revenue-purchase.fixture.ts'
    ]).includes('revenue-listing-purchase')
  )
})

test('private purchase preparation and native state retain complete qualification unions', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const contract = configured['private-purchase-contract']
  assert.deepEqual(contract.mutate, ['src/private/PrivatePurchaseContracts.ts'])
  assert.deepEqual(contract.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-purchase-contract.test.ts',
    '<rootDir>/test/private-purchase-contract.property.test.ts'
  ])
  const state = configured['private-purchase-state']
  for (const input of [
    'test/protected-ledger-fixture.ts',
    'test/protected-ledger-restoration-fixture.ts'
  ])
    assert.ok(state.additionalInputs.includes(input))
  assert.deepEqual(state.mutate, [
    'src/private/PrivatePurchaseProgress.ts',
    'src/private/SQLitePrivatePurchaseStore.ts'
  ])
  assert.deepEqual(state.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/private-purchase-progress.test.ts',
    '<rootDir>/test/private-purchase-store.test.ts',
    '<rootDir>/test/private-purchase-progress-commitment.test.ts',
    '<rootDir>/test/private-purchase-store-commitment.test.ts',
    '<rootDir>/test/private-purchase-state.property.test.ts',
    '<rootDir>/test/protected-ledger-prepared.test.ts',
    '<rootDir>/test/private-purchase-native-clock.test.ts',
    '<rootDir>/test/private-purchase-native-clock.property.test.ts',
    ...currentAliasRegressionTests
  ])
  for (const path of [
    'test/private-purchase-progress-commitment.test.ts',
    'test/private-purchase-store-commitment.test.ts'
  ]) {
    assert.ok(state.additionalInputs.includes(path))
    assert.ok(configured['private-purchase-native-clock'].additionalInputs.includes(path))
    assert.ok(
      configured['private-purchase-native-clock'].runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/' + path
      )
    )
  }
  assert.ok(
    configured['private-purchase-coordination'].runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/private-purchase-coordinator-commitment.test.ts'
    )
  )
  assert.equal(
    state.propertyTest,
    'packages/application/output-knowledge/test/private-purchase-state.property.test.ts'
  )
  for (const fixture of [
    'test/revenue-purchase.fixture.ts',
    'test/revenue-lineage-fixture.ts',
    'test/revenue-authority-fixture.ts'
  ])
    assert.ok(configured['private-acquisition-coordination'].additionalInputs.includes(fixture))
})

test('standing covenant terms retain complete modes, consent and prior cryptographic qualification', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['lch-overlay-covenant-terms']
  assert.deepEqual(target.mutate, [
    'src/overlayAcquisitionCovenantTerms.ts',
    'src/overlayAcquisitionCovenantTermsCore.ts',
    'src/overlayAcquisitionCovenantProfileTerms.ts',
    'src/overlayAcquisitionConsent.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts',
    '<rootDir>/test/key-delivery.test.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-covenant-terms.property.test.ts'
  )
  assert.deepEqual(target.additionalInputs, configured['lch-overlay-acquisition'].additionalInputs)
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/content/lch/src/overlayAcquisitionConsent.ts'
    ]).includes('lch-overlay-covenant-terms')
  )
})

test('covenant settlement retains complete evidence and prior cryptographic qualification', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['lch-overlay-covenant-settlement']
  assert.deepEqual(target.mutate, [
    'src/overlayAcquisitionCovenantSettlement.ts',
    'src/overlayAcquisitionCovenantSettlementCore.ts',
    'src/overlayAcquisitionCovenantProfileSettlement.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts',
    '<rootDir>/test/key-delivery.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, configured['lch-overlay-acquisition'].additionalInputs)
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-covenant-settlement.property.test.ts'
  )
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/content/lch/src/overlayAcquisitionCovenantSettlement.ts'
    ]).includes('lch-overlay-covenant-settlement')
  )
})

test('common acquisition License retains both modes and every prior qualification module', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['lch-overlay-license']
  assert.deepEqual(target.mutate, ['src/overlayAcquisitionLicense.ts'])
  assert.ok(
    configured['lch-overlay-acquisition'].mutate.includes('src/overlayAcquisitionLicense.ts')
  )
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts',
    '<rootDir>/test/key-delivery.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, configured['lch-overlay-acquisition'].additionalInputs)
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-license.property.test.ts'
  )
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
})

test('complete covenant buyer retains native fixture closure and the prior complete unions', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['lch-overlay-covenant']
  assert.deepEqual(target.mutate, [
    'src/overlayAcquisitionCovenant.ts',
    'src/overlayAcquisitionCovenantCore.ts',
    'src/overlayAcquisitionCovenantProfile.ts',
    'src/overlayAcquisitionCovenantProof.ts',
    'src/overlayAcquisitionCovenantEntitlement.ts',
    'src/overlayAcquisitionEntitlement.ts',
    'src/keyRecovery.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts',
    '<rootDir>/test/key-delivery.test.ts'
  ])
  assert.deepEqual(target.additionalInputs, configured['lch-overlay-acquisition'].additionalInputs)
  assert.ok(
    configured['lch-overlay-acquisition'].mutate.includes('src/overlayAcquisitionEntitlement.ts')
  )
  for (const input of [
    '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
    '../../application/output-knowledge/test/fixtures/revenue-listing/**'
  ])
    assert.ok(target.additionalInputs.includes(input))
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-covenant.property.test.ts'
  )
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
  assert.ok(
    selectAffectedMutationTargets(configured, [
      'packages/application/output-knowledge/test/fixtures/revenue-listing/lineage-package.json.gz'
    ]).includes('lch-overlay-covenant')
  )
})

test('complete covenant seller retains independent verification and every inherited fixture input', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const target = configured['lch-overlay-covenant-seller']
  assert.deepEqual(target.mutate, [
    'src/overlayAcquisitionCovenantSeller.ts',
    'src/overlayAcquisitionCovenantSellerCore.ts',
    'src/overlayAcquisitionCovenantProfileSeller.ts'
  ])
  assert.deepEqual(
    target.runnerOptions.jest.config.testMatch,
    configured['lch-overlay-covenant'].runnerOptions.jest.config.testMatch
  )
  assert.deepEqual(target.additionalInputs, configured['lch-overlay-covenant'].additionalInputs)
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-covenant-seller.property.test.ts'
  )
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build:mutation')
})

test('purchase HTTP retains the full shared finite source and all prior transport suites', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  const target = configured['sdk-purchase-http']
  assert.deepEqual(target.mutate, [
    'src/overlay-tools/OutputPurchaseTransport.ts',
    'src/overlay-tools/internal/OutputFiniteHTTP.ts'
  ])
  assert.deepEqual(
    target.runnerOptions.jest.config.testMatch,
    configured['sdk-paid-lookup-http'].runnerOptions.jest.config.testMatch
  )
  for (const retained of Object.values(configured)) {
    if (retained.mutate.includes('src/overlay-tools/internal/OutputFiniteHTTP.ts'))
      assert.ok(
        retained.runnerOptions.jest.config.testMatch.includes(
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        )
      )
  }
})

test('covenant buyer and native payment retain whole entries and complete original recovery unions', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  assert.deepEqual(configured['private-purchase-buyer'].mutate, [
    'src/private/PrivatePurchaseBuyer.ts',
    'src/private/PrivatePurchaseBuyerPorts.ts',
    'src/private/purchase-buyer.ts'
  ])
  assert.deepEqual(configured['wallet-purchase-payment'].mutate, [
    'src/private/WalletToolboxPurchasePayment.ts',
    'src/private/purchase-wallet.ts',
    'src/private/WalletToolboxPurchasePaymentCore.ts',
    'src/private/WalletToolboxProfilePurchasePayment.ts'
  ])
  for (const id of ['private-purchase-buyer', 'wallet-purchase-payment']) {
    const target = configured[id]
    for (const pattern of [
      '<rootDir>/test/private-lookup-buyer*.test.ts',
      '<rootDir>/test/private-buyer-payment.test.ts',
      '<rootDir>/test/private-purchase-buyer*.test.ts',
      '<rootDir>/test/private-purchase-wallet-native*.test.ts',
      '<rootDir>/test/private-purchase-wallet-routes.test.ts',
      '<rootDir>/test/private-purchase-wallet-profile-routes.test.ts'
    ])
      assert.ok(target.runnerOptions.jest.config.testMatch.includes(pattern))
    for (const pattern of [
      'src/operations/**',
      'src/revenue-listing/**',
      'test/private-purchase-wallet*.ts',
      'test/fixtures/revenue-listing/**',
      '../../wallet/wallet-toolbox/src/**',
      '../../sdk/src/script/**',
      '../../sdk/src/transaction/**',
      '../../sdk/src/auth/**'
    ])
      assert.ok(target.additionalInputs.includes(pattern))
    assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
    assert.equal(
      target.runnerOptions.buildCommand,
      `node ${resolve(REPOSITORY_ROOT, 'scripts/mutation-build.mjs').replaceAll(' ', '\\ ')} --dependency @bsv/wallet-toolbox`
    )
  }
})

test('cumulative purchase proof owns full modules and retains every original lifecycle suite', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    proof = configured['private-purchase-evidence']
  assert.deepEqual(proof.mutate, [
    'src/private/PrivatePurchaseEvidence.ts',
    'src/private/SQLitePrivatePurchaseEvidence.ts'
  ])
  for (const name of [
    'contract',
    'contract.property',
    'progress',
    'store',
    'state.property',
    'coordinator',
    'coordination.property',
    'disclosure',
    'disclosure.property',
    'evidence',
    'evidence.property'
  ])
    assert.ok(
      proof.runnerOptions.jest.config.testMatch.includes(
        `<rootDir>/test/private-purchase-${name}.test.ts`
      )
    )
  for (const target of Object.values(configured).filter(
    target =>
      target.packageDirectory === proof.packageDirectory &&
      target.mutate.includes('src/private/PrivatePurchaseCoordinator.ts')
  )) {
    for (const name of ['evidence', 'evidence.property'])
      assert.ok(
        target.runnerOptions.jest.config.testMatch.includes(
          `<rootDir>/test/private-purchase-${name}.test.ts`
        )
      )
    for (const file of proof.mutate) assert.ok(target.additionalInputs.includes(file))
    assert.ok(target.additionalInputs.includes('test/private-purchase-evidence.fixture.ts'))
  }
})

test('native observation profile governs whole modules and all previous ledger/purchase checks', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT),
    target = configured['private-purchase-native-clock']
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/private-purchase-native-clock.property.test.ts'
  )
  assert.deepEqual(target.mutate, [
    'src/private/SQLiteProtectedLedger.ts',
    'src/private/SQLitePrivatePurchaseStore.ts',
    'src/private/PrivatePurchaseProgress.ts'
  ])
  for (const parent of ['protected-ledger', 'private-purchase-state']) {
    for (const selection of configured[parent].runnerOptions.jest.config.testMatch)
      assert.ok(target.runnerOptions.jest.config.testMatch.includes(selection))
    for (const input of configured[parent].additionalInputs)
      assert.ok(target.additionalInputs.includes(input))
  }
  assert.equal(target.runnerOptions.buildCommand, 'pnpm build')
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
})

test('private lookup and root serving retain complete sources and original native test unions', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const lookup = targets['private-publication-lookup']
  assert.deepEqual(lookup.mutate, ['src/private/PrivatePublicationLookupContext.ts'])
  assert.equal(
    lookup.propertyTest,
    'packages/application/output-knowledge/test/private-publication-lookup.property.test.ts'
  )
  assert.equal(lookup.runnerOptions.maxTestRunnerReuse, 8)
  assert.deepEqual(
    lookup.runnerOptions.jest.config.testMatch,
    targets['private-publication-coordination'].runnerOptions.jest.config.testMatch
  )
  for (const id of [
    'private-publication-state',
    'private-publication-service',
    'private-publication-coordination',
    'protected-ledger',
    'private-purchase-native-clock'
  ]) {
    const target = targets[id]
    assert.ok(
      target.additionalInputs.includes('src/private/PrivatePublicationLookupContext.ts'),
      id
    )
    assert.ok(target.additionalInputs.includes('test/private-publication-lookup.fixture.ts'), id)
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/test/private-publication-lookup.test.ts'
      ),
      id
    )
    assert.ok(
      target.runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/test/private-publication-lookup.property.test.ts'
      ),
      id
    )
  }
  const root = targets['root-eviction-journal']
  assert.deepEqual(root.mutate, [
    'src/root-eviction/SQLiteRootEvictionStore.ts',
    'src/root-eviction/RootAdvertisementServing.ts',
    'src/root-eviction/RootLookupServingDisclosure.ts'
  ])
  assert.deepEqual(root.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/root-eviction*.test.ts',
    resolve(
      REPOSITORY_ROOT,
      'packages/overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts'
    )
  ])
  assert.ok(root.additionalInputs.includes('test/root-advertisement-fixture.ts'))
  assert.ok(root.additionalInputs.includes('../../sdk/src/**'))
})

test('native root and original purchase signature fixtures remain in every dependent complete selection', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    native = resolve(
      REPOSITORY_ROOT,
      'packages/overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts'
    )
  for (const [id, target] of Object.entries(targets)) {
    if (target.packageDirectory !== 'packages/application/output-knowledge') continue
    if (target.additionalInputs?.includes('test/private-purchase-contract.fixture.ts'))
      assert.ok(target.additionalInputs.includes('test/private-purchase-signing.fixture.ts'), id)
    if (
      target.additionalInputs?.includes(
        '../../overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.fixture.ts'
      )
    ) {
      assert.ok(target.runnerOptions.jest.config.testMatch.includes(native), id)
      assert.ok(
        target.runnerOptions.jest.config.testMatch.includes(
          '<rootDir>/test/root-eviction*.test.ts'
        ),
        id
      )
      assert.ok(
        target.runnerOptions.jest.config.roots.includes(
          resolve(REPOSITORY_ROOT, 'packages/overlays/overlay-express/src/__tests__')
        ),
        id
      )
      assert.equal(
        target.runnerOptions.jest.config.moduleNameMapper[
          String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`
        ],
        '<rootDir>/$1.ts',
        id
      )
    }
  }
})

test('additional package-relative fixture inputs select their target without replacing existing inputs', () => {
  const target = {
    packageDirectory: 'packages/one',
    propertyTest: 'packages/one/test/value.property.test.ts',
    mutate: ['src/value.ts:10-20'],
    additionalInputs: ['./test/fixtures/source.ts'],
    runnerOptions: {
      jest: {
        configFile: 'jest.config.cjs',
        config: { testMatch: ['<rootDir>/test/value*.test.ts'] }
      }
    }
  }
  const precise = {
    one: target,
    two: {
      ...target,
      packageDirectory: 'packages/two',
      propertyTest: 'packages/two/test/value.property.test.ts'
    }
  }
  for (const input of [
    'src/value.ts',
    'test/value.property.test.ts',
    'jest.config.cjs',
    'test/value.test.ts',
    'test/fixtures/source.ts'
  ]) {
    assert.deepEqual(selectAffectedMutationTargets(precise, [`packages/one/${input}`]), ['one'])
    assert.deepEqual(selectAffectedMutationTargets(precise, [`packages/two/${input}`]), ['two'])
  }
  for (const input of [
    'test/fixtures/other.ts',
    'test/fixtures/source.ts.extra',
    'src/other.ts',
    'packages/one/test/fixtures/source.ts'
  ]) {
    assert.deepEqual(selectAffectedMutationTargets(precise, [`packages/one/${input}`]), [])
  }
  assert.deepEqual(selectAffectedMutationTargets(precise, ['test/fixtures/source.ts']), [])
  assert.deepEqual(
    selectAffectedMutationTargets(precise, ['packages/one/test/fixtures/source.ts'], {
      changedTargetIds: ['two']
    }),
    ['one', 'two']
  )

  const canonical = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(Object.keys(canonical).length, 216)
  assert.deepEqual(canonical['wallet-retained-snapshot'].additionalInputs, [
    'test/utils/snapshotRelationFixtures.ts',
    'test/utils/snapshotCertificateFixtures.ts',
    'test/utils/snapshotGlobalFixtures.ts',
    'test/utils/snapshotHistoricalMigrations.ts',
    'test/utils/snapshotSqliteFixtures.ts',
    'test/utils/snapshotSqliteIdentityFixture.ts',
    'test/utils/snapshotSqliteMaintenanceFixture.ts',
    'test/storage/snapshotHistoricalMigrations.cjs',
    'test/storage/snapshotSqliteGenerationCrash.cjs'
  ])
  assert.deepEqual(
    selectAffectedMutationTargets(canonical, [
      'packages/wallet/wallet-toolbox/test/utils/snapshotRelationFixtures.ts'
    ]),
    [
      'private-lookup-buyer',
      'private-purchase-buyer',
      'wallet-purchase-payment',
      'wallet-retained-snapshot'
    ]
  )
  for (const input of [
    'src/storage/schema/snapshotCertificateIndexMigration.ts',
    'src/storage/schema/snapshotGlobalIndexMigration.ts',
    'src/storage/schema/snapshotGlobalIndexTriggers.ts',
    'test/utils/snapshotCertificateFixtures.ts',
    'test/utils/snapshotGlobalFixtures.ts',
    'src/storage/schema/snapshotRelationIndexMigration.ts',
    'src/storage/schema/snapshotProfileIndexMigration.ts',
    'src/storage/snapshot/RetainedReadSnapshot.property.test.ts'
  ]) {
    assert.ok(
      selectAffectedMutationTargets(canonical, [
        `packages/wallet/wallet-toolbox/${input}`
      ]).includes('wallet-retained-snapshot')
    )
  }
})

test('retained snapshot mutation execution recycles workers while other wallet defaults remain intact', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(targets['wallet-retained-snapshot'].runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(targets['wallet-snapshot-archive'].runnerOptions.maxTestRunnerReuse, undefined)
  assert.equal(targets['wallet-snapshot-remote-http'].runnerOptions.maxTestRunnerReuse, undefined)
})

test('journal mutation registration retains its complete source, canonical tests and fixture ownership', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-journal']
  assert.deepEqual(target.mutate, [
    'src/storage/snapshot/journal/SnapshotJournalRevision.ts',
    'src/storage/snapshot/journal/SnapshotJournalRevisionSql.ts',
    'src/storage/snapshot/journal/SnapshotJournalPage.ts',
    'src/storage/snapshot/journal/SnapshotJournalSqliteClock.ts',
    'src/storage/snapshot/journal/SnapshotJournalMysqlClock.ts',
    'src/storage/snapshot/journal/SnapshotJournalSqliteObservers.ts',
    'src/storage/snapshot/journal/SnapshotJournalMysqlObservers.ts',
    'src/storage/snapshot/journal/SnapshotJournalBootstrap.ts',
    'src/storage/snapshot/journal/SnapshotJournalHighWater.ts',
    'src/storage/snapshot/journal/SnapshotJournalMysqlSource.ts',
    'src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.ts',
    'src/storage/snapshot/journal/SnapshotJournalMysqlIntent.ts',
    'src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.ts',
    'src/storage/snapshot/journal/SnapshotJournalReceipt.ts',
    'src/storage/snapshot/journal/SnapshotJournalCaptureFence.ts',
    'src/storage/snapshot/journal/SnapshotJournalConnections.ts',
    'src/storage/snapshot/journal/SnapshotJournalCaptureBackend.ts',
    'src/storage/snapshot/journal/SnapshotJournalCapture.ts',
    'src/storage/snapshot/journal/SnapshotJournalCollection.ts',
    'src/storage/snapshot/journal/SnapshotJournalMaintenance.ts',
    'src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.ts',
    'src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.ts',
    'src/storage/snapshot/journal/SnapshotJournalContentRevision.ts',
    'src/storage/snapshot/journal/SnapshotJournalCurrentContentRevision.ts',
    'src/storage/snapshot/journal/SnapshotJournalReceiptData.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldReferences.ts',
    'src/storage/snapshot/journal/captureSnapshotJournalFieldArchiveSource.ts'
  ])
  assert.deepEqual(target.additionalInputs, [
    'test/fixtures/snapshotJournal/mysql-generation-ddl-fixture.json',
    'test/fixtures/snapshotJournal/mysql-generation-metadata-fixture.json',
    'test/fixtures/snapshotJournal/mysql-generation-state-fixture.json',
    'test/fixtures/snapshotJournal/mysql-intent-metadata-fixture.json',
    'test/fixtures/snapshotJournal/mysql-source-metadata-fixture.json',
    'test/utils/snapshotArchiveFixtures.ts',
    'test/utils/snapshotSqliteFixtures.ts',
    'test/utils/snapshotHistoricalMigrations.ts',
    'test/storage/snapshotJournalNativeFixture.cjs',
    'test/storage/snapshotJournalMysqlConnection.cjs',
    'test/storage/snapshotJournalMysql.cjs',
    'test/storage/snapshotJournalMysqlServerCrash.cjs',
    'test/storage/snapshotJournalReceiptMysql.cjs',
    'test/storage/snapshotJournalCaptureMysql.cjs',
    'test/storage/snapshotJournalCaptureMysqlChild.cjs',
    'test/storage/snapshotJournalCaptureProcessLoss.cjs',
    'test/storage/snapshotJournalCaptureSqlite.cjs',
    'test/storage/snapshotJournalRetentionChild.cjs',
    'test/storage/snapshotJournalRetentionCuts.cjs',
    'test/storage/snapshotJournalRetentionMysql.cjs',
    'test/storage/snapshotJournalRetentionMysqlRc.cjs',
    'test/storage/snapshotJournalRetentionMysqlRr.cjs',
    'test/storage/snapshotJournalRetentionProcessLoss.cjs',
    'test/storage/snapshotJournalRetentionSqlite.cjs',
    'test/storage/snapshotJournalMaintenanceFixture.cjs',
    'test/storage/snapshotJournalMaintenanceCuts.cjs',
    'test/storage/snapshotJournalMaintenanceChild.cjs',
    'test/storage/snapshotJournalMaintenanceProcessLoss.cjs',
    'test/storage/snapshotJournalMaintenanceWal.cjs',
    'test/storage/snapshotJournalMaintenanceMysqlRc.cjs',
    'test/storage/snapshotJournalMaintenanceMysqlRr.cjs',
    'test/storage/snapshotJournalSqliteCrash.cjs',
    'test/storage/runSnapshotJournalMysql.cjs',
    'test/storage/snapshotArchiveDocker.cjs',
    'test/utils/snapshotJournalArchiveFixture.ts',
    'test/utils/snapshotJournalDataManagerFixture.ts',
    'test/utils/snapshotArchiveHttpFixtures.ts',
    'test/utils/snapshotContentReceiptHistoricalFixture.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldTypes.ts',
    'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
    'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts',
    'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
    'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/storage/snapshot/journal/*.test.ts',
    '<rootDir>/src/storage/schema/snapshotSyncReceiptMigration.test.ts',
    '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLocalContent.test.ts'
  ])
  for (const input of target.additionalInputs)
    assert.ok(
      selectAffectedMutationTargets(buildMutationTargets(REPOSITORY_ROOT), [
        'packages/wallet/wallet-toolbox/' + input
      ]).includes('wallet-snapshot-journal')
    )
})

test('every inherited snapshot-sync target keeps the complete journal tests for owned provider ranges', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const name of [
    'wallet-snapshot-sync',
    'wallet-snapshot-sync-destination',
    'wallet-snapshot-sync-rows'
  ]) {
    assert.ok(
      targets[name].runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/src/storage/snapshot/journal/*.test.ts'
      )
    )
    assert.ok(
      targets[name].runnerOptions.jest.config.testMatch.includes(
        '<rootDir>/src/storage/snapshot/SnapshotSync*.test.ts'
      )
    )
  }
})

test('adaptive paging owns its complete controller without removing the existing snapshot caller target', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const target = targets['wallet-adaptive-sync-budget']
  assert.deepEqual(target.mutate, ['src/storage/sync/SyncPageBudget.ts'])
  assert.deepEqual(target.additionalInputs, ['src/storage/snapshot/runSnapshotSyncSession.ts'])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/storage/sync/SyncPageBudget.test.ts',
    '<rootDir>/src/storage/sync/SyncPageBudget.property.test.ts',
    '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts'
  ])
  assert.ok(
    targets['wallet-snapshot-sync'].mutate.includes(
      'src/storage/snapshot/runSnapshotSyncSession.ts'
    )
  )
  assert.deepEqual(
    selectAffectedMutationTargets(targets, [
      'packages/wallet/wallet-toolbox/src/storage/sync/SyncPageBudget.ts'
    ]),
    [
      'private-purchase-http',
      'private-acquisition-http',
      'private-acquisition-coordination',
      'private-lookup-buyer',
      'private-purchase-buyer',
      'wallet-purchase-payment',
      'wallet-adaptive-sync-budget'
    ]
  )
  const affected = selectAffectedMutationTargets(targets, [
    'packages/wallet/wallet-toolbox/src/storage/snapshot/runSnapshotSyncSession.ts'
  ])
  assert.ok(affected.includes('wallet-adaptive-sync-budget'))
  assert.ok(affected.includes('wallet-snapshot-sync'))
})

test('portable streaming keeps every complete source module and original behavioral suite', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const modules = [
    ['wallet-portable-canonical-chunks', 'CanonicalPortableChunks'],
    ['wallet-portable-packed-row', 'Brc38PackedRow'],
    ['wallet-portable-source-stream', 'Brc38Stream'],
    ['wallet-portable-knex-source', 'Brc38KnexSource'],
    ['wallet-portable-json-stream', 'Brc38JsonStream'],
    ['wallet-portable-brc39-frame', 'Brc39Frame'],
    ['wallet-portable-brc39-node', 'Brc39StreamNode'],
    ['wallet-portable-private-file', 'Brc39PrivateFileNode']
  ]
  const originalSuites = [
    'Brc38JsonStream.property.test.ts',
    'Brc38JsonStream.test.ts',
    'Brc38KnexSource.test.ts',
    'Brc38PackedRow.test.ts',
    'Brc38Stream.test.ts',
    'Brc39Frame.property.test.ts',
    'Brc39Frame.test.ts',
    'Brc39PrivateFileNode.test.ts',
    'Brc39StreamNode.test.ts',
    'CanonicalPortableChunks.property.test.ts',
    'CanonicalPortableChunks.test.ts'
  ].map(name => `<rootDir>/src/storage/portable/${name}`)
  for (const [id, source] of modules) {
    const target = targets[id]
    const helpers =
      id === 'wallet-portable-canonical-chunks'
        ? ['src/utility/promiseFromSync.ts', 'src/utility/utf16CodeUnitAt.ts']
        : []
    const helperTests = helpers.map(file => file.replace('.ts', '.test.ts'))
    assert.deepEqual(target.mutate, [
      `src/storage/portable/${source}.ts`,
      ...helpers,
      ...(id === 'wallet-portable-canonical-chunks'
        ? ['CanonicalPortableBounds', 'CanonicalPortableValue', 'CanonicalPortableParts'].map(
            name => `src/storage/portable/${name}.ts`
          )
        : [])
    ])
    const selectedSuites = target.runnerOptions.jest.config.testMatch
    assert.deepEqual(selectedSuites.slice(0, originalSuites.length), originalSuites)
    assert.deepEqual(selectedSuites.slice(originalSuites.length), [
      '<rootDir>/src/storage/portable/EntryPoints.test.ts',
      ...helperTests.map(file => `<rootDir>/${file}`)
    ])
    assert.deepEqual(target.additionalInputs, [
      'src/storage/portable/index.ts',
      'src/storage/portable/stream.ts',
      'src/storage/portable/node.ts',
      ...helperTests,
      ...(id === 'wallet-portable-canonical-chunks'
        ? ['test/utils/canonicalPortableChunkOracle.ts']
        : [])
    ])
    assert.ok(
      selectAffectedMutationTargets(targets, [
        `packages/wallet/wallet-toolbox/src/storage/portable/${source}.ts`
      ]).includes(id)
    )
    assert.ok(
      selectAffectedMutationTargets(targets, [
        'packages/wallet/wallet-toolbox/src/storage/portable/EntryPoints.test.ts'
      ]).includes(id)
    )
  }
})

test('snapshot sync owns every inherited manager region and complete primary selection', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-sync']
  const file = 'src/storage/WalletStorageManager.ts'
  const lines = readFileSync(
    `${REPOSITORY_ROOT}/packages/wallet/wallet-toolbox/${file}`,
    'utf8'
  ).split('\n')
  const expected = [
    ['private runSnapshotCopy(', 'async syncFromReader('],
    ['async syncFromReader(', '    let inserts = 0'],
    ['async syncFromReaderResumable(', '    const generation ='],
    ['async syncToWriterResumable(', 'async syncToWriter('],
    ['async syncToWriter(', '    let inserts = 0'],
    ['async updateBackups(', 'async setActive('],
    ['async setActive(', 'getStoreEndpointURL('],
    ['private async withAccess<R>(', 'runAsWriter<R>(']
  ].map(([startMarker, endMarker]) => {
    const start = lines.findIndex(line => line.includes(startMarker))
    const end = lines.findIndex((line, index) => index > start && line.includes(endMarker))
    assert.ok(start >= 0 && end > start)
    return `${file}:${start + 1}-${end}`
  })
  assert.deepEqual(
    target.mutate.filter(specification => specification.startsWith(`${file}:`)),
    expected
  )
})

test('Stryker runs cannot append per-mutant test reports to the job summary', () => {
  const environment = strykerEnvironment(
    { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '/tmp/summary', PATH: '/bin' },
    { TS_STACK_MUTATION_TARGET: 'one' }
  )
  assert.equal(environment.GITHUB_STEP_SUMMARY, undefined)
  assert.equal(environment.PATH, '/bin')
  assert.equal(environment.TS_STACK_MUTATION_TARGET, 'one')
})

test('private HTTP qualification fingerprints every original native fixture and acquisition dependency', () => {
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of [
    'private-publication-http',
    'private-purchase-http',
    'private-acquisition-http'
  ]) {
    assert.ok(
      configured[id].additionalInputs.includes(
        '../../application/output-knowledge/test/*fixture.ts'
      ),
      id
    )
    assert.ok(
      configured[id].additionalInputs.includes(
        '../../application/output-knowledge/test/private-*.ts'
      ),
      id
    )
    assert.ok(
      configured[id].additionalInputs.includes(
        '../../application/output-knowledge/test/fixtures/**'
      ),
      id
    )
  }
  for (const input of [
    '../../content/lch/src/**',
    '../../content/lch/test/overlay-acquisition*.ts',
    '../../content/lch/package.json',
    '../../content/lch/tsconfig*.json'
  ]) {
    assert.ok(configured['private-acquisition-http'].additionalInputs.includes(input), input)
    assert.ok(configured['private-purchase-http'].additionalInputs.includes(input), input)
  }
})

test('current immutable listing qualification adds complete sources without changing historical campaigns', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['revenue-listing-profile']
  assert.deepEqual(target.mutate, [
    'src/revenue-listing/LineagePackage.ts',
    'src/revenue-listing/ProfileLineagePackage.ts',
    'src/revenue-listing/ProfileLineageGraph.ts',
    'src/revenue-listing/RevenueListingProfileLineageVerifier.ts',
    'src/revenue-listing/RevenueListingProfilePurchaseVerifier.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/application/output-knowledge/test/revenue-profile.property.test.ts'
  )
  assert.equal(target.runnerOptions.jest.enableFindRelatedTests, false)
  assert.ok(
    target.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/test/revenue-profile-work.test.ts'
    )
  )
})

test('listing public-arithmetic mutations include the bounded-retention regressions and original independent properties', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['sdk-revenue-listing']
  const selection = target.runnerOptions.jest.config.testMatch
  for (const file of [
    'RevenueListing.test.ts',
    'RevenueListingKeys.test.ts',
    'RevenueListingProfile.test.ts',
    'RevenueListing.property.test.ts'
  ]) {
    assert.ok(selection.includes(`<rootDir>/src/script/templates/__tests/${file}`))
    assert.ok(
      readFileSync(
        resolve(REPOSITORY_ROOT, 'packages/sdk/src/script/templates/__tests', file),
        'utf8'
      ).length > 0
    )
  }
  assert.equal(
    target.propertyTest,
    'packages/sdk/src/script/templates/__tests/RevenueListing.property.test.ts'
  )
  assert.ok(target.mutate.includes('src/script/templates/RevenueListingKeys.ts'))
})

test('complete alias regression initial-suite allowances retain their exact fourteen-target scope', () => {
  const allowances = new Map([
    ['private-purchase-alias-state', 15],
    ['private-purchase-alias-custody', 15],
    ['private-purchase-state', 15],
    ['private-purchase-native-clock', 15],
    ['private-purchase-coordination', 15],
    ['private-purchase-evidence', 15],
    ['private-purchase-disclosure', 15],
    ['private-purchase-buyer', 30],
    ['protected-operation-objects', 15],
    ['private-purchase-alias-owner', 15],
    ['private-purchase-alias-currentness', 15],
    ['private-purchase-alias-coordinator', 15],
    ['private-purchase-alias-disclosure', 15],
    ['private-purchase-buyer-alias', 15]
  ])
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  for (const [id, target] of Object.entries(configured)) {
    assert.equal(target.runnerOptions.dryRunTimeoutMinutes, allowances.get(id), id)
    if (allowances.has(id))
      for (const selector of currentAliasRegressionTests)
        assert.ok(target.runnerOptions.jest.config.testMatch.includes(selector), id)
  }
  for (const id of allowances.keys()) assert.ok(Object.hasOwn(configured, id), id)
})

test('wallet functional routing recognizes globs and preserves every other actual Jest selection', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT),
    target = canonical['wallet-retained-snapshot'],
    functional = [
      'src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
      'src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts'
    ],
    wallet = resolve(REPOSITORY_ROOT, target.packageDirectory)
  for (const file of functional) assert.ok(target.requiredFunctionalTests?.includes(file))
  const getConfig = (await import('../packages/wallet/wallet-toolbox/jest.config.cjs')).default,
    base = await getConfig(),
    routed = { ...base, ...target.runnerOptions.jest.config, rootDir: wallet }
  for (const original of base.testPathIgnorePatterns)
    assert.ok(routed.testPathIgnorePatterns.includes(original))
  const list = config =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve(wallet, 'node_modules/jest/bin/jest.js'),
          '--listTests',
          '--json',
          '--runInBand',
          '--config',
          JSON.stringify(config)
        ],
        { cwd: wallet, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 }
      )
    ).sort()
  const before = list({ ...routed, testPathIgnorePatterns: base.testPathIgnorePatterns }),
    after = list(routed),
    original = functional.map(file => resolve(wallet, file)).sort()
  assert.ok(original.every(file => before.includes(file)))
  assert.ok(original.every(file => !after.includes(file)))
  assert.deepEqual(
    before.filter(file => !after.includes(file)),
    original
  )
  assert.deepEqual(
    after.filter(file => !before.includes(file)),
    []
  )
  assert.ok(
    after.includes(resolve(wallet, target.propertyTest.slice(target.packageDirectory.length + 1)))
  )
  assert.ok(
    selectAffectedMutationTargets(
      canonical,
      functional.map(file => target.packageDirectory + '/' + file)
    ).includes('wallet-retained-snapshot')
  )
})

test('full native and ordinary journal functional files retain affected-target ownership outside mutation baselines', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)
  const files = [
    ...nativeFunctionalFiles,
    walletJournalSuites[0].file.slice('packages/wallet/wallet-toolbox/'.length)
  ]
  const routed = Object.entries(canonical).filter(
    ([, target]) => target.requiredFunctionalTests?.length
  )
  assert.ok(routed.length >= 19)
  for (const file of nativeFunctionalFiles)
    assert.ok(routed.some(([, target]) => target.requiredFunctionalTests.includes(file)))
  for (const [id, target] of routed) {
    assert.equal(target.packageDirectory, 'packages/wallet/wallet-toolbox')
    const cases = target.runnerOptions.jest.config.testMatch
    assert.ok(cases.length > 0)
    assert.ok(cases.every(file => !files.some(original => file === '<rootDir>/' + original)))
    assert.ok(
      cases.some(pattern =>
        matchesGlob(
          '<rootDir>/' + target.propertyTest.slice(target.packageDirectory.length + 1),
          pattern
        )
      )
    )
    for (const file of target.requiredFunctionalTests) {
      assert.ok(files.includes(file))
      assert.ok(
        selectAffectedMutationTargets(canonical, [target.packageDirectory + '/' + file]).includes(
          id
        )
      )
    }
  }
  const precise = {
    selected: {
      packageDirectory: 'packages/example',
      mutate: ['src/component.ts'],
      requiredFunctionalTests: ['test/full.test.ts'],
      runnerOptions: { jest: { config: { testMatch: ['<rootDir>/test/component.test.ts'] } } }
    },
    other: {
      packageDirectory: 'packages/other',
      mutate: ['src/component.ts'],
      requiredFunctionalTests: ['test/full.test.ts'],
      runnerOptions: { jest: { config: { testMatch: ['<rootDir>/test/component.test.ts'] } } }
    }
  }
  assert.deepEqual(selectAffectedMutationTargets(precise, ['packages/example/test/full.test.ts']), [
    'selected'
  ])
  assert.deepEqual(
    selectAffectedMutationTargets(precise, ['packages/example/test/full.test.ts.extra']),
    []
  )
})

test('native integrity mutation routing keeps mandatory full-case admission and removes only its duplicate execution', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)
  const id = 'wallet-current-brc38-native-catalog-node'
  const target = canonical[id]
  const file = nativeIntegrityTestFile.slice(target.packageDirectory.length + 1)
  assert.ok(target.requiredFunctionalTests.includes(file))
  const wallet = resolve(REPOSITORY_ROOT, target.packageDirectory)
  const base = await (await import('../packages/wallet/wallet-toolbox/jest.config.cjs')).default()
  const config = { ...base, ...target.runnerOptions.jest.config, rootDir: wallet }
  const escaped = '<rootDir>/' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
  const before = {
    ...config,
    testMatch: [...config.testMatch, '<rootDir>/' + file],
    testPathIgnorePatterns: config.testPathIgnorePatterns.filter(value => value !== escaped)
  }
  const discover = selection =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve(wallet, 'node_modules/jest/bin/jest.js'),
          '--listTests',
          '--json',
          '--runInBand',
          '--watchman=false',
          '--config',
          JSON.stringify(selection)
        ],
        { cwd: wallet, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 }
      )
    ).sort()
  const original = discover(before),
    routed = discover(config)
  assert.deepEqual(
    original.filter(value => !routed.includes(value)),
    [resolve(wallet, file)]
  )
  assert.deepEqual(
    routed.filter(value => !original.includes(value)),
    []
  )
  assert.ok(
    routed.includes(resolve(wallet, target.propertyTest.slice(target.packageDirectory.length + 1)))
  )
  for (const input of [
    nativeIntegrityTestFile,
    'scripts/wallet-composed-native-ci.mjs',
    '.github/workflows/ci.yml'
  ])
    assert.ok(selectAffectedMutationTargets(canonical, [input]).includes(id))
})

test('reviewed component routing preserves properties, broader input ownership and native browser coverage', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)
  const current = Object.fromEntries(
    Object.entries(canonical).filter(([id]) => id.startsWith('wallet-current-'))
  )
  const registryPath = 'governance/mutation-testing/wallet-component-tests.json'
  const selections = JSON.parse(readFileSync(`${REPOSITORY_ROOT}/${registryPath}`, 'utf8'))
  assert.equal(Object.keys(current).length, 40)
  assert.deepEqual(
    selectAffectedMutationTargets(canonical, [registryPath]).sort(),
    Object.keys(current).sort()
  )
  assert.deepEqual(selectAffectedMutationTargets(canonical, [registryPath + '.extra']), [])
  for (const [id, target] of Object.entries(current)) {
    const selected = target.runnerOptions.jest.config.testMatch.map(file =>
      file.replace(/^<rootDir>\//, '')
    )
    assert.deepEqual(selected, selections[id])
    assert.ok(selected.includes(target.propertyTest.slice(target.packageDirectory.length + 1)))
    assert.ok(selected.every(file => target.componentTestUniverse.includes(file)))
    for (const file of target.componentTestUniverse) {
      assert.ok(
        selectAffectedMutationTargets({ [id]: target }, [
          target.packageDirectory + '/' + file
        ]).includes(id)
      )
    }
    if (target.mutate.some(file => file.includes('Idb') || file.includes('Browser'))) {
      assert.ok(selected.includes('src/storage/portable/Brc38NativeBrowserComponents.test.cjs'))
      assert.ok(
        selectAffectedMutationTargets({ [id]: target }, [
          target.packageDirectory + '/src/storage/portable/Brc38PrivateIdbStage.browser.case.ts'
        ]).includes(id)
      )
    }
  }
})

test('identity retirement mutation selects complete existing shared and compact SQLite source oracles', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)
  const target = canonical['wallet-current-snapshot-journal-identity-retirements']
  for (const path of [
    'src/storage/snapshot/SnapshotSqliteSharedMembership.test.ts',
    'src/storage/snapshot/SnapshotSqliteCompactMembership.test.ts'
  ]) {
    assert.ok(target.runnerOptions.jest.config.testMatch.includes('<rootDir>/' + path))
    assert.ok(target.componentTestUniverse.includes(path))
    assert.ok(
      selectAffectedMutationTargets(canonical, [target.packageDirectory + '/' + path]).includes(
        'wallet-current-snapshot-journal-identity-retirements'
      )
    )
  }
  assert.ok(target.additionalInputs.includes('test/utils/snapshotSqliteMaintenanceFixture.ts'))
  assert.ok(target.additionalInputs.includes('test/utils/snapshotSqliteFixtures.ts'))
  assert.ok(target.mutate.includes('src/storage/schema/snapshotSqliteIdentity.ts'))
})

test('wallet compiler configuration changes select every owning Jest mutation target', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const wallet = Object.entries(targets)
    .filter(
      ([, target]) =>
        target.packageDirectory === 'packages/wallet/wallet-toolbox' && target.runnerOptions?.jest
    )
    .map(([id]) => id)
    .sort()
  assert.ok(wallet.length >= 40)
  for (const input of [
    'packages/wallet/wallet-toolbox/tsconfig.json',
    'packages/wallet/wallet-toolbox/tsconfig.jest.json',
    'config/typescript/dual-runtime.json',
    'config/typescript/strict.json',
    'scripts/wallet-jest-config.test.mjs'
  ]) {
    const dependents = input.startsWith('packages/wallet/wallet-toolbox/')
      ? [
          'private-purchase-http',
          'private-acquisition-http',
          'private-acquisition-coordination',
          'private-lookup-buyer',
          'private-purchase-buyer',
          'wallet-purchase-payment'
        ]
      : []
    assert.deepEqual(
      selectAffectedMutationTargets(targets, [input]).sort(),
      [...wallet, ...dependents].sort()
    )
    assert.deepEqual(selectAffectedMutationTargets(targets, [input + '.extra']), [])
  }
})

test('component registries reject missing targets, duplicate tests, removed properties and undeclared substitutes', () => {
  const all = buildMutationTargets(REPOSITORY_ROOT)
  const current = Object.fromEntries(
    Object.entries(all).filter(([id]) => id.startsWith('wallet-current-'))
  )
  const registry = JSON.parse(
    readFileSync(
      `${REPOSITORY_ROOT}/governance/mutation-testing/wallet-component-tests.json`,
      'utf8'
    )
  )
  const id = Object.keys(current)[0]
  const check = (change, message) => {
    const selected = structuredClone(registry)
    change(selected)
    assert.throws(() => applyWalletComponentTests(structuredClone(current), selected), message)
  }
  check(selected => {
    delete selected[id]
  }, /every exact/)
  check(selected => {
    selected.unknown = []
  }, /every exact/)
  check(selected => selected[id].push(selected[id][0]), /Invalid/)
  check(selected => {
    selected[id] = selected[id].filter(
      file => !file.endsWith('Brc38AuthenticatedPrivateStageNode.property.test.ts')
    )
  }, /registered property/)
  check(selected => selected[id].push('src/storage/portable/Imaginary.test.ts'), /Invalid/)
  check(
    selected => selected[id].push('src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts'),
    /Invalid/
  )
  check(selected => {
    selected[id] = selected[id].filter(
      file => !file.endsWith('Brc38NativeBrowserComponents.test.cjs')
    )
  }, /genuine native browser/)
  check(selected => {
    selected[id] = selected[id].filter(
      file => !file.endsWith('BrowserArgon2idWorker.native.test.cjs')
    )
  }, /genuine native worker/)
})

test('native component bridge delegates all original browser cases without replacing their oracles', () => {
  const wallet = `${REPOSITORY_ROOT}/packages/wallet/wallet-toolbox`
  const catalog = readFileSync(`${wallet}/client/test/portable-program-browser.ts`, 'utf8')
  const wrapper = readFileSync(
    `${wallet}/src/storage/portable/Brc38NativeBrowserComponents.test.cjs`,
    'utf8'
  )
  const original = [...catalog.matchAll(/id: '([^']+)',\s+source: '([^']+)'/g)].map(match => [
    match[1],
    match[2]
  ])
  const selected = [...wrapper.matchAll(/\[\s*'([^']+)',\s*'([^']+)'\s*\]/g)].map(match => [
    match[1],
    match[2]
  ])
  const baseline = original.filter(([id]) => id !== 'verifyPackedIdbSnapshotContentReceipts')
  assert.equal(baseline.length, 60)
  assert.equal(new Set(baseline.map(([, source]) => source)).size, 19)
  assert.deepEqual(
    original.filter(([id]) => id === 'verifyPackedIdbSnapshotContentReceipts'),
    [
      [
        'verifyPackedIdbSnapshotContentReceipts',
        'src/storage/snapshot/IdbSnapshotSyncContent.browser.case.ts'
      ]
    ]
  )
  assert.equal(original.length, 61)
  assert.equal(new Set(original.map(([, source]) => source)).size, 20)
  assert.deepEqual(selected, original)
  assert.match(wrapper, /await runPortableBrowserCase\(id\)/)
  assert.match(wrapper, /completeCatalogueRun\)\.toBe\(false\)/)
  assert.match(wrapper, /processTreeQualified\)\.toBe\(false\)/)
})

test('narrow execution retains the original native controller inputs of the broader component universe', () => {
  const id = 'wallet-current-brc38-import-merge-checkpoint-node'
  const target = buildMutationTargets(REPOSITORY_ROOT)[id]
  const original = 'src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts'
  assert.ok(target.componentTestUniverse.includes(original))
  assert.ok(!target.runnerOptions.jest.config.testMatch.includes('<rootDir>/' + original))
  for (const file of [
    'client/test/native-browser-budgets.cjs',
    'client/test/native-browser-driver.cjs',
    'client/test/native-browser-session.cjs',
    'client/test/portable-program-browser.cjs'
  ]) {
    assert.ok(target.additionalInputs.includes(file))
    assert.deepEqual(
      selectAffectedMutationTargets({ [id]: target }, [target.packageDirectory + '/' + file]),
      [id]
    )
  }
})

test('every reviewed component selection names an exact tracked path on case-sensitive workers', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim().split('\n')
  )
  const selections = JSON.parse(
    readFileSync(
      `${REPOSITORY_ROOT}/governance/mutation-testing/wallet-component-tests.json`,
      'utf8'
    )
  )
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const [id, files] of Object.entries(selections)) {
    for (const file of [...files, ...targets[id].componentTestUniverse])
      assert.ok(tracked.has('packages/wallet/wallet-toolbox/' + file), id + ': ' + file)
  }
})

test('native browser delivery controls select genuine browser execution without expanding node-only campaigns', () => {
  const browser = {
    packageDirectory: 'packages/wallet/wallet-toolbox',
    testRunner: 'jest',
    mutate: ['src/value.ts'],
    runnerOptions: {
      jest: {
        config: {
          testMatch: ['<rootDir>/src/storage/portable/Brc38NativeBrowserComponents.test.cjs']
        }
      }
    }
  }
  const node = {
    ...browser,
    runnerOptions: { jest: { config: { testMatch: ['<rootDir>/src/value.test.ts'] } } }
  }
  const glob = {
    ...browser,
    runnerOptions: { jest: { config: { testMatch: ['<rootDir>/src/**/*.test.{ts,cjs}'] } } }
  }
  const targets = { browser, glob, node }
  for (const file of [
    'scripts/provision-wallet-native-browser.mjs',
    'scripts/wallet-native-browser.json'
  ]) {
    assert.deepEqual(selectAffectedMutationTargets(targets, [file]), ['browser', 'glob'])
    assert.deepEqual(selectAffectedMutationTargets(targets, [file + '.extra']), [])
  }
})

test('field remote upload retains the existing mutation owner and owns every new runtime boundary', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const owner = targets['wallet-snapshot-remote-http']
  for (const name of [
    'KnexSnapshotJournalFieldRpc',
    'RemoteSnapshotJournalFieldDestination',
    'SnapshotJournalFieldRpcProtocol',
    'SnapshotJournalFieldUploadRequest',
    'openStoredSnapshotJournalFieldArchive'
  ]) {
    const path = `src/storage/snapshot/journal/${name}.ts`
    assert.ok(owner.mutate.includes(path))
    assert.ok(
      selectAffectedMutationTargets(targets, [`packages/wallet/wallet-toolbox/${path}`]).includes(
        'wallet-snapshot-remote-http'
      )
    )
  }
  assert.ok(
    owner.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts'
    )
  )
  assert.ok(
    owner.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts'
    )
  )
})

test('active SQL writer fences retain a canonical owner with actual role-change regression cases', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['wallet-current-knex-brc38-staging-store']
  for (const source of [
    'src/storage/KnexActiveWriteFence.ts',
    'src/storage/StorageReqWrite.ts',
    'src/storage/KnexPrimaryHandoffControl.ts',
    'src/storage/KnexPrimaryHandoffAdmission.ts',
    'src/storage/KnexPrimaryHandoffCopies.ts',
    'src/storage/KnexPrimaryHandoffCopyMetadata.ts',
    'src/storage/KnexWalletWriteAdmission.ts',
    'src/storage/PrimaryHandoffPlan.ts',
    'src/storage/PrimaryHandoffProgram.ts',
    'src/storage/remoting/PrimaryHandoffProtocol.ts',
    'src/storage/schema/entities/EntityUser.ts',
    'src/storage/schema/primaryHandoffMigration.ts',
    'src/monitor/tasks/WalletMonitorTask.ts',
    'src/monitor/tasks/TaskSendWaiting.ts',
    'src/monitor/tasks/TaskReconcilePendingTransactions.ts',
    'src/monitor/tasks/TaskReviewStatus.ts',
    'src/monitor/tasks/TaskReviewUtxos.ts',
    'src/monitor/tasks/TaskReviewDoubleSpends.ts',
    'src/monitor/tasks/TaskNoSendExpiry.ts',
    'src/monitor/tasks/TaskCleanupActionBatches.ts',
    'src/storage/methods/noSendExpiryLifecycle.ts',
    'src/storage/methods/reviewUtxoOutputs.ts',
    'src/storage/methods/ListOutputsSpecOp.ts',
    'src/monitor/tasks/TaskFailAbandoned.ts',
    'src/storage/methods/reviewStatus.ts',
    'src/monitor/tasks/TaskCheckForProofs.ts',
    'src/monitor/tasks/TaskArcSSE.ts',
    'src/monitor/tasks/TaskUnFail.ts',
    'src/storage/methods/processAction.ts',
    'src/storage/methods/attemptToPostReqsToNetwork.ts',
    'src/storage/methods/reconcileFailedTransactionInputs.ts',
    'src/storage/methods/createAction.ts',
    'src/storage/methods/internalizeAction.ts',
    'src/storage/methods/actionBatch.ts',
    'src/storage/methods/actionBatchBlobs.ts',
    'src/storage/methods/noSendExpiry.ts'
  ])
    assert.ok(target.mutate.includes(source))
  assert.ok(target.mutate.some(path => path.startsWith('src/storage/WalletStorageManager.ts:')))
  assert.ok(target.additionalInputs.includes('src/storage/StorageActiveWrite.ts'))
  assert.ok(target.additionalInputs.includes('src/storage/PrimaryHandoffControl.ts'))
  assert.ok(target.mutate.some(path => path.startsWith('src/storage/schema/KnexMigrations.ts:')))
  assert.ok(JSON.stringify(target).includes('KnexPrimaryHandoffControl.test.ts'))
  assert.ok(JSON.stringify(target).includes('StorageKnexActiveWriteFence.test.ts'))
})

test('wallet mutation runners serialize the shared physical Worker and fixture lifecycle', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.equal(targets['wallet-portable-canonical-chunks'].runnerOptions.maxTestRunnerReuse, 20)
  for (const target of Object.values(targets)) {
    if (target.packageDirectory === 'packages/wallet/wallet-toolbox' && target.runnerOptions?.jest)
      assert.equal(target.runnerOptions.concurrency, 1)
  }
})

test('historical registry comparison preserves module-relative environment metadata', async () => {
  const root = resolve(new URL('..', import.meta.url).pathname)
  const source = readFileSync(resolve(root, 'governance/mutation-testing/targets.mjs'), 'utf8')
  const historical = (await mutationTargetModule(source, root)).buildMutationTargets(root)
  assert.deepEqual(historical, buildMutationTargets(root))
})

test('shared scheduling and active-mutant controls select the complete original registry', () => {
  const root = resolve(new URL('..', import.meta.url).pathname)
  const targets = buildMutationTargets(root)
  for (const file of [
    'governance/mutation-testing/stop-on-kill-environment.cjs',
    'governance/mutation-testing/durations.json',
    'governance/mutation-testing/execution-partitions.json',
    'scripts/mutation-partitions.mjs'
  ])
    assert.deepEqual(selectAffectedMutationTargets(targets, [file]), Object.keys(targets))
})
