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
  assert.equal(Object.keys(canonical).length, 100)
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
    ['wallet-retained-snapshot']
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
    ['wallet-adaptive-sync-budget']
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
    assert.deepEqual(selectAffectedMutationTargets(targets, [input]).sort(), wallet)
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
