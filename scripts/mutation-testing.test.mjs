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
  assert.equal(Object.keys(canonical).length, 46)
  assert.deepEqual(canonical['wallet-retained-snapshot'].additionalInputs, [
    'test/utils/snapshotRelationFixtures.ts'
  ])
  assert.deepEqual(
    selectAffectedMutationTargets(canonical, [
      'packages/wallet/wallet-toolbox/test/utils/snapshotRelationFixtures.ts'
    ]),
    ['wallet-retained-snapshot']
  )
  for (const input of [
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
