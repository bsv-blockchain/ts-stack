import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

import {
  calculateMutationMetrics,
  evaluateMutationReport,
  parseArguments,
  REPOSITORY_ROOT,
  selectAffectedMutationTargets,
  targetsForUnresolvedMutationRange
} from './mutation-testing.mjs'

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
  assert.equal(Object.keys(canonical).length, 47)
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
    'src/storage/snapshot/journal/SnapshotJournalCapture.ts'
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
    'test/storage/snapshotJournalSqliteCrash.cjs',
    'test/storage/runSnapshotJournalMysql.cjs',
    'test/storage/snapshotArchiveDocker.cjs'
  ])
  assert.equal(target.runnerOptions.maxTestRunnerReuse, 8)
  assert.deepEqual(target.runnerOptions.jest.config.testMatch, [
    '<rootDir>/src/storage/snapshot/journal/*.test.ts'
  ])
  for (const input of target.additionalInputs)
    assert.ok(
      selectAffectedMutationTargets(buildMutationTargets(REPOSITORY_ROOT), [
        'packages/wallet/wallet-toolbox/' + input
      ]).includes('wallet-snapshot-journal')
    )
})
