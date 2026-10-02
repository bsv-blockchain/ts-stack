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
  assert.equal(Object.keys(configured).length, 122)
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
    'src/storage/actionRecovery/ActionRecoveryJSON.ts'
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
    'src/private/NodeProtectedPayloadCodec.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/protected-payload.test.ts',
    '<rootDir>/test/protected-ledger-codec.test.ts',
    '<rootDir>/test/protected-ledger-integrity.test.ts',
    '<rootDir>/test/protected-ledger-boundaries.test.ts',
    '<rootDir>/test/protected-ledger-enumeration.test.ts',
    '<rootDir>/test/protected-ledger.test.ts',
    '<rootDir>/test/protected-ledger-batch.test.ts',
    '<rootDir>/test/protected-ledger.property.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.ok(target.additionalInputs.includes('src/storage/**'))
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
    '<rootDir>/test/private-publication-availability.test.ts'
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
    '<rootDir>/test/root-eviction*.test.ts'
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
    '<rootDir>/test/private-publication-availability.test.ts'
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
    )
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
    'pnpm --filter @bsv/wallet-toolbox build && pnpm build'
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
    '<rootDir>/src/__tests__/PrivatePublication*.test.ts'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.equal(
    target.runnerOptions.buildCommand,
    'pnpm --filter @bsv/wallet-toolbox build && pnpm --filter @bsv/output-knowledge build && pnpm build'
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
    '<rootDir>/test/protected-payload.test.ts'
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
    '<rootDir>/test/private-buyer-payment.test.ts'
  ])
  assert.equal(
    buyer.runnerOptions.buildCommand,
    'pnpm --filter @bsv/wallet-toolbox build && pnpm build'
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
    'src/overlayAcquisitionPolicy.ts',
    'src/overlayAcquisitionTerms.ts',
    'src/overlayAcquisitionAuthority.ts',
    'src/overlayAcquisitionSettlement.ts',
    'src/overlayAcquisitionCustody.ts',
    'src/overlayAcquisitionEntitlement.ts',
    'src/overlayAcquisitionPaid.ts',
    'src/overlayAcquisitionSeller.ts',
    'src/overlayAcquisitionVerification.ts'
  ])
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/test/overlay-acquisition*.test.ts'
  ])
  assert.equal(
    target.propertyTest,
    'packages/content/lch/test/overlay-acquisition-codec.property.test.ts'
  )
  assert.ok(target.additionalInputs.includes('../../application/output-knowledge/src/**'))
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
    assert.notEqual(ordinary.cacheDirectory, privateProject.cacheDirectory)
    assert.deepEqual(ordinary.testMatch, options.testMatch)
    assert.deepEqual(privateProject.testMatch, options.testMatch)
    assert.deepEqual(ordinary.extensionsToTreatAsEsm, [])
    assert.deepEqual(privateProject.extensionsToTreatAsEsm, ['.ts', '.tsx'])
    assert.deepEqual(target.runnerOptions.testRunnerNodeArgs, ['--experimental-vm-modules'])
    const legacy = '/fixture/src/__tests__/OverlayExpress.test.ts',
      privatePath = '/fixture/src/__tests__/PrivateBuyerHTTP.integration.test.ts',
      ignores = (project, file) =>
        project.testPathIgnorePatterns.some(pattern => new RegExp(pattern).test(file))
    assert.equal(ignores(ordinary, legacy), false)
    assert.equal(ignores(privateProject, legacy), true)
    assert.equal(ignores(ordinary, privatePath), true)
    assert.equal(ignores(privateProject, privatePath), false)
    assert.ok(target.additionalInputs.includes('jest.projects.mjs'))
  }
})
