import { createCoreOverlayTestProjects } from '../../packages/overlays/overlay/jest-projects.config.mjs'

import { createOverlayTestProjects } from '../../packages/overlays/overlay-express/jest-projects.config.mjs'

import { readFileSync } from 'node:fs'

import { matchesGlob, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'

const walletDataAdditions = {
  'wallet-portable-canonical-chunks': {
    mutate: [
      'src/utility/promiseFromSync.ts',
      'src/utility/utf16CodeUnitAt.ts',
      'src/storage/portable/CanonicalPortableBounds.ts',
      'src/storage/portable/CanonicalPortableValue.ts',
      'src/storage/portable/CanonicalPortableParts.ts'
    ],
    additionalInputs: [
      'src/utility/promiseFromSync.test.ts',
      'src/utility/utf16CodeUnitAt.test.ts',
      'test/utils/canonicalPortableChunkOracle.ts'
    ],
    tests: [
      '<rootDir>/src/utility/promiseFromSync.test.ts',
      '<rootDir>/src/utility/utf16CodeUnitAt.test.ts'
    ]
  },
  'wallet-snapshot-journal': {
    mutate: [
      'src/storage/snapshot/journal/SnapshotJournalContentRevision.ts',
      'src/storage/snapshot/journal/SnapshotJournalCurrentContentRevision.ts',
      'src/storage/snapshot/journal/SnapshotJournalReceiptData.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldReferences.ts',
      'src/storage/snapshot/journal/captureSnapshotJournalFieldArchiveSource.ts'
    ],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/schema/snapshotSyncReceiptMigration.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLocalContent.test.ts'
    ]
  },
  'wallet-snapshot-archive': {
    mutate: [
      'src/storage/snapshot/journal/SnapshotJournalArchiveBinding.ts',
      'src/storage/snapshot/journal/SnapshotJournalArchivePacket.ts',
      'src/storage/snapshot/journal/SnapshotJournalArchiveStorageTable.ts',
      'src/storage/snapshot/journal/captureSnapshotJournalArchiveSource.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldReferences.ts',
      'src/storage/snapshot/journal/captureSnapshotJournalFieldArchiveSource.ts'
    ],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalArchive*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveService.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveHttp.test.ts'
    ]
  },
  'wallet-snapshot-remote-directory': {
    mutate: ['src/storage/snapshot/journal/SnapshotJournalArchiveDirectory.ts'],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalArchive*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveService.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveHttp.test.ts'
    ]
  },
  'wallet-snapshot-remote-service': {
    mutate: ['src/storage/snapshot/journal/SnapshotJournalArchiveReaderRequest.ts'],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalArchive*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveService.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveHttp.test.ts'
    ]
  },
  'wallet-snapshot-remote-http': {
    mutate: [
      'src/storage/snapshot/RemoteSnapshotSyncContentProtocol.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalDataRpc.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldRpc.ts',
      'src/storage/snapshot/journal/RemoteSnapshotJournalFieldDestination.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldRpcProtocol.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldUploadRequest.ts',
      'src/storage/snapshot/journal/openStoredSnapshotJournalFieldArchive.ts',
      'src/storage/snapshot/journal/RemoteSnapshotJournalDataDestination.ts',
      'src/storage/snapshot/journal/SnapshotJournalArchiveProtocol.ts',
      'src/storage/snapshot/journal/SnapshotJournalArchiveTransport.ts',
      'src/storage/snapshot/journal/SnapshotJournalDataProtocol.ts',
      'src/storage/snapshot/journal/openRemoteSnapshotJournalArchive.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldArchiveProtocol.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldArchiveTransport.ts',
      'src/storage/snapshot/journal/openRemoteSnapshotJournalFieldArchive.ts'
    ],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalArchive*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveService.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveHttp.test.ts'
    ]
  },
  'wallet-snapshot-sync': {
    mutate: [
      'src/storage/schema/snapshotSyncReceiptMigration.ts',
      'src/storage/snapshot/KnexSnapshotSyncContentReceipts.ts',
      'src/storage/snapshot/PackedIdbSnapshotContentRevision.ts',
      'src/storage/snapshot/SnapshotSyncContentRevision.ts'
    ],
    additionalInputs: [
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
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalArchive*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalData*.test.ts',
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/schema/snapshotSyncReceiptMigration.test.ts',
      '<rootDir>/src/storage/snapshot/KnexSnapshotSyncContentReceipts.test.ts',
      '<rootDir>/src/storage/snapshot/IdbSnapshotSyncContent.test.ts',
      '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncContent.test.ts'
    ]
  },
  'wallet-current-snapshot-journal-destination-window': {
    mutate: [
      'src/storage/schema/snapshotJournalDataReceiptMigration.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalDataContentReceipts.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.ts',
      'src/storage/snapshot/journal/SnapshotJournalDataBootstrapRequiredError.ts',
      'src/storage/snapshot/journal/SnapshotJournalDataContentReceipt.ts',
      'src/storage/snapshot/journal/SnapshotJournalDataProvider.ts',
      'src/storage/snapshot/journal/runSnapshotJournalArchiveReconciliation.ts',
      'src/storage/snapshot/journal/runSnapshotJournalSourceDataReconciliation.ts',
      'src/storage/snapshot/journal/snapshotJournalDataSourceBinding.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts'
    ],
    additionalInputs: [
      'test/utils/snapshotJournalArchiveFixture.ts',
      'test/utils/snapshotJournalDataManagerFixture.ts',
      'test/utils/snapshotArchiveHttpFixtures.ts',
      'test/utils/snapshotContentReceiptHistoricalFixture.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldTypes.ts',
      'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
      'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts'
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDataManager.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDataNoChange.test.ts',
      '<rootDir>/src/storage/schema/snapshotJournalDataReceiptMigration.test.ts'
    ]
  },
  'wallet-current-snapshot-journal-delta-frame': {
    mutate: [],
    additionalInputs: [
      'src/storage/snapshot/journal/SnapshotJournalFieldTypes.ts',
      'test/utils/snapshotJournalArchiveFixture.ts',
      'test/utils/snapshotJournalDataManagerFixture.ts',
      'test/utils/snapshotArchiveHttpFixtures.ts',
      'test/utils/snapshotContentReceiptHistoricalFixture.ts',
      'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
      'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts'
    ],
    tests: ['<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts']
  },
  'wallet-current-snapshot-journal-delta-page': {
    mutate: [],
    additionalInputs: [
      'src/storage/snapshot/journal/SnapshotJournalFieldTypes.ts',
      'test/utils/snapshotJournalArchiveFixture.ts',
      'test/utils/snapshotJournalDataManagerFixture.ts',
      'test/utils/snapshotArchiveHttpFixtures.ts',
      'test/utils/snapshotContentReceiptHistoricalFixture.ts',
      'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
      'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts'
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts'
    ]
  },
  'wallet-current-snapshot-journal-source-identities': {
    mutate: [
      'src/storage/snapshot/journal/SnapshotJournalFieldReferences.ts',
      'src/storage/snapshot/journal/captureSnapshotJournalFieldArchiveSource.ts',
      'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts'
    ],
    additionalInputs: [
      'src/storage/snapshot/journal/SnapshotJournalFieldTypes.ts',
      'test/utils/snapshotJournalArchiveFixture.ts',
      'test/utils/snapshotJournalDataManagerFixture.ts',
      'test/utils/snapshotArchiveHttpFixtures.ts',
      'test/utils/snapshotContentReceiptHistoricalFixture.ts',
      'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts'
    ],
    tests: [
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldSource.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchive.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveRequest.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveService.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalFieldArchiveHttp.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalContentRevision.test.ts',
      '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLocalContent.test.ts'
    ]
  },
  'wallet-current-brc38-native-catalog-node': {
    mutate: [
      'src/storage/snapshot/journal/SnapshotJournalNativeActionMerge.ts',
      'src/storage/portable/Brc38CopiedImportDestinationNode.ts'
    ],
    additionalInputs: [
      'test/utils/snapshotJournalFieldNativeCache.ts',
      'src/storage/snapshot/preparePackedNativeSnapshotFieldNode.case.ts',
      'src/storage/snapshot/journal/SnapshotJournalOwnedRowFingerprint.ts',
      'src/storage/snapshot/journal/SnapshotJournalFieldSql.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalWindowDestination.ts',
      'src/storage/snapshot/journal/KnexSnapshotJournalFieldDestination.ts',
      'src/storage/portable/Brc38NativeTestClock.ts'
    ],
    tests: [
      '<rootDir>/src/storage/portable/Brc38CopiedImportDestinationNode.test.ts',
      '<rootDir>/src/storage/portable/Brc38NativeTestClock.test.ts'
    ]
  }
}

function sourceLineRange(repositoryRoot, packageDirectory, filePath, startMarker, endMarker) {
  const lines = readFileSync(resolve(repositoryRoot, packageDirectory, filePath), 'utf8').split(
    '\n'
  )
  const startIndex = lines.findIndex(line => line.includes(startMarker))
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.includes(endMarker))

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `Unable to resolve mutation range in ${filePath}: ${startMarker} .. ${endMarker}`
    )
  }

  return `${filePath}:${startIndex + 1}-${endIndex}`
}

const STOP_ON_KILL_ENVIRONMENT = fileURLToPath(
  new URL('./stop-on-kill-environment.cjs', import.meta.url)
)

const requiredFunctionalTests = new Set([
  '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
  '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
  '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
  '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
  '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
  '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
  '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
  '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts'
])

function jestTarget(
  configFile,
  testMatch,
  { esm = false, config = {}, findRelated = false, buildCommand, maxTestRunnerReuse } = {}
) {
  const functionalTests = testMatch?.filter(file => requiredFunctionalTests.has(file)) ?? []
  const componentTests = testMatch?.filter(file => !requiredFunctionalTests.has(file))
  if (functionalTests.length !== 0 && componentTests.length === 0)
    throw new Error(
      'Mutation target requires genuine component tests in addition to functional lanes'
    )
  return {
    ...(functionalTests.length === 0
      ? {}
      : {
          requiredFunctionalTests: functionalTests.map(file => file.replace(/^<rootDir>\//, ''))
        }),
    testRunner: 'jest',
    runnerOptions: {
      ...(buildCommand ? { buildCommand } : {}),
      ...(maxTestRunnerReuse === undefined ? {} : { maxTestRunnerReuse }),
      jest: {
        projectType: 'custom',
        configFile,
        enableFindRelatedTests: findRelated,
        config: {
          ...config,
          ...(config.projects
            ? {
                projects: config.projects.map(project => ({
                  ...project,
                  testEnvironment: STOP_ON_KILL_ENVIRONMENT
                }))
              }
            : {}),
          testEnvironment: STOP_ON_KILL_ENVIRONMENT,
          ...(testMatch === undefined ? {} : { testMatch: componentTests })
        }
      },
      ...(esm ? { testRunnerNodeArgs: ['--experimental-vm-modules'] } : {})
    }
  }
}

function overlayJestTarget(repositoryRoot, testMatch, options = {}) {
  const originalProjects = createOverlayTestProjects(testMatch, options.config)
  // Jest's serialized parent mapping takes precedence over child mappings.
  // Keep independent peer modules rooted outside the mutable sandbox, and keep
  // every original specific alias before the local mutable-module fallback.
  const moduleNameMapper = {
    [String.raw`^\.\./\.\./\.\./overlay/src/(.*)\.js$`]: resolve(
      repositoryRoot,
      'packages/overlays/overlay/src/$1.ts'
    ),
    [String.raw`^\.\./\.\./\.\./\.\./sdk/src/(.*)\.js$`]: resolve(
      repositoryRoot,
      'packages/sdk/src/$1.ts'
    ),
    [String.raw`^\.\./\.\./\.\./\.\./content/lch/(.*)\.js$`]: resolve(
      repositoryRoot,
      'packages/content/lch/$1.ts'
    ),
    ...options.config?.moduleNameMapper,
    ...originalProjects[0].moduleNameMapper
  }
  const projects = originalProjects.map(project => ({ ...project, moduleNameMapper }))
  return jestTarget('jest.config.js', testMatch, {
    ...options,
    esm: true,
    config: { ...options.config, moduleNameMapper, projects }
  })
}

function mutationBuildCommand(repositoryRoot, dependencies) {
  // Stryker uses execaCommand without a shell. Its tokenizer accepts escaped
  // spaces, and the helper executes each prerequisite with explicit argv.
  const script = resolve(repositoryRoot, 'scripts/mutation-build.mjs').replaceAll(
    ' ',
    String.raw`\ `
  )
  return ['node', script, ...dependencies.flatMap(name => ['--dependency', name])].join(' ')
}

function appendMutationBuildInputs(repositoryRoot, targets) {
  const buildHelper = resolve(repositoryRoot, 'scripts/mutation-build.mjs').replaceAll(
    ' ',
    String.raw`\ `
  )
  for (const target of Object.values(targets)) {
    if (target.runnerOptions?.buildCommand?.startsWith('node ' + buildHelper + ' ')) {
      target.additionalInputs = [
        ...(target.additionalInputs ?? []),
        '../../../scripts/mutation-build.mjs'
      ]
    }
  }
}

function portableStreamMutationTargets(repositoryRoot) {
  const definitions = [
    [
      'wallet-portable-canonical-chunks',
      'CanonicalPortableChunks',
      'CanonicalPortableChunks.property.test.ts'
    ],
    ['wallet-portable-packed-row', 'Brc38PackedRow', 'Brc38PackedRow.test.ts'],
    ['wallet-portable-source-stream', 'Brc38Stream', 'Brc38Stream.test.ts'],
    ['wallet-portable-knex-source', 'Brc38KnexSource', 'Brc38KnexSource.test.ts'],
    ['wallet-portable-json-stream', 'Brc38JsonStream', 'Brc38JsonStream.property.test.ts'],
    ['wallet-portable-brc39-frame', 'Brc39Frame', 'Brc39Frame.property.test.ts'],
    ['wallet-portable-brc39-node', 'Brc39StreamNode', 'Brc39StreamNode.test.ts'],
    ['wallet-portable-private-file', 'Brc39PrivateFileNode', 'Brc39PrivateFileNode.test.ts']
  ]
  const testMatch = [
    '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
    '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
    '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
    '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
    '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
    '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
    '<rootDir>/src/storage/portable/Brc39Frame.test.ts',
    '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
    '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
    '<rootDir>/src/storage/portable/CanonicalPortableChunks.property.test.ts',
    '<rootDir>/src/storage/portable/CanonicalPortableChunks.test.ts',
    '<rootDir>/src/storage/portable/EntryPoints.test.ts'
  ]
  return Object.fromEntries(
    definitions.map(([id, source, property]) => [
      id,
      {
        packageDirectory: 'packages/wallet/wallet-toolbox',
        manifest: 'packages/wallet/wallet-toolbox/package.json',
        propertyTest: `packages/wallet/wallet-toolbox/src/storage/portable/${property}`,
        mutate: [`src/storage/portable/${source}.ts`],
        additionalInputs: [
          'src/storage/portable/index.ts',
          'src/storage/portable/stream.ts',
          'src/storage/portable/node.ts'
        ],
        ...jestTarget('jest.config.cjs', testMatch, {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        })
      }
    ])
  )
}

const walletComponentSelectionPath = 'governance/mutation-testing/wallet-component-tests.json'

const nativeBrowserComponentTest = 'src/storage/portable/Brc38NativeBrowserComponents.test.cjs'

const nativeBrowserWorkerTest = 'src/utility/BrowserArgon2idWorker.native.test.cjs'

export function applyWalletComponentTests(targets, selections) {
  const ids = Object.keys(targets).sort((a, b) => Number(a > b) - Number(a < b))
  if (
    !selections ||
    typeof selections !== 'object' ||
    Array.isArray(selections) ||
    JSON.stringify(Object.keys(selections).sort((a, b) => Number(a > b) - Number(a < b))) !==
      JSON.stringify(ids)
  )
    throw new Error('Component selections must contain every exact current wallet target')
  for (const id of ids) {
    const target = targets[id]
    const selected = selections[id]
    const original =
      target.componentTestUniverse ??
      target.runnerOptions.jest.config.testMatch.map(file => file.replace(/^<rootDir>\//, ''))
    const browser = target.mutate.some(file => file.includes('Idb') || file.includes('Browser'))
    const worker = target.mutate.includes('src/utility/BrowserArgon2idWorker.ts')
    const allowed = new Set([
      ...original,
      ...(browser ? [nativeBrowserComponentTest] : []),
      ...(worker ? [nativeBrowserWorkerTest] : [])
    ])
    if (
      !Array.isArray(selected) ||
      selected.length === 0 ||
      new Set(selected).size !== selected.length ||
      selected.some(
        file =>
          typeof file !== 'string' ||
          !allowed.has(file) ||
          file.split('/').some(part => part === '.' || part === '..') ||
          requiredFunctionalTests.has('<rootDir>/' + file)
      )
    )
      throw new Error(`Invalid or undeclared component test selection for ${id}`)
    const property = target.propertyTest.slice(target.packageDirectory.length + 1)
    if (!selected.includes(property)) throw new Error(`Missing registered property suite for ${id}`)
    if (browser && !selected.includes(nativeBrowserComponentTest))
      throw new Error(`Missing genuine native browser components for ${id}`)
    if (worker && !selected.includes(nativeBrowserWorkerTest))
      throw new Error(`Missing genuine native worker components for ${id}`)
    target.componentTestUniverse = [...allowed]
    target.configurationInputs = [walletComponentSelectionPath]
    target.runnerOptions.jest.config.testMatch = selected.map(file => '<rootDir>/' + file)
  }
  return targets
}

function currentWalletMutationTargets(repositoryRoot) {
  const targets = {
    'wallet-current-brc38-authenticated-private-stage-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageNode.ts',
        'src/storage/portable/Brc39Argon2Worker.ts',
        'src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageBrowser.ts',
        'src/storage/portable/Brc38AuthenticatedRawTransactionNode.ts',
        'src/storage/portable/Brc38AuthenticatedSourceSealNode.ts',
        'src/storage/portable/Brc38AuthenticatedStreamStageBrowser.ts',
        'src/storage/portable/Brc38AuthenticatedStreamedProofNode.ts',
        'src/utility/BrowserArgon2idWorker.ts',
        'src/utility/installBrowserArgon2idWorker.ts'
      ],
      additionalInputs: [
        'client/argon2id-worker.ts',
        'client/build-argon2id-worker.mjs',
        'client/test/argon2id-coverage-browser.cjs',
        'client/test/argon2id-coverage-browser.ts',
        'client/test/argon2id-coverage-worker.ts',
        'client/test/native-browser-executable.cjs',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts',
        'src/utility/BrowserArgon2idWorker.browser.case.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Argon2Worker.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/utility/BrowserArgon2idWorker.native.test.cjs'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-existing-rows': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportExistingRows.ts',
        'src/storage/portable/Brc38ImportEntityMergeNode.ts',
        'src/storage/portable/Brc38ImportEntityTargets.ts',
        'src/storage/portable/Brc38ImportFieldPolicyRowsNode.ts',
        'src/storage/snapshot/SnapshotSyncFieldRows.ts',
        'src/storage/snapshot/SnapshotSyncRows.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncScalarFields.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-history': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportHistory.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportHistory.ts',
        'src/storage/portable/Brc38IdbOccupiedHistory.ts',
        'src/storage/portable/Brc38IdbRestoreHistory.ts',
        'src/storage/portable/Brc38IdbStructuredHistory.ts',
        'src/storage/portable/Brc38PrivateOccupiedHistoryNode.ts',
        'src/storage/portable/Brc38PrivateOccupiedHistoryTextNode.ts',
        'src/storage/portable/Brc38StreamedHistoryProjection.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-id-map': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportIdMap.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportIdMap.ts',
        'src/storage/portable/Brc38StreamedSyncMapProjection.ts',
        'src/storage/portable/Brc38StreamedSyncMapProjectionNode.ts',
        'src/utility/Argon2idBackend.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/mobile/test/argon2-fallback.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedBrowserKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedNodeKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/utility/__tests__/Argon2idBackend.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-journal': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportJournal.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportJournal.ts',
        'src/storage/portable/Brc38ImportJournalCore.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-journal-schema': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportJournalSchema.ts',
        'src/storage/portable/Brc38PrivateSchemaMigrationNode.ts',
        'src/storage/idbImportJournalSchema.ts',
        'src/storage/portable/Brc38NativePriorImportSchemaNode.ts',
        'src/storage/portable/Brc38PrivateIncomingIdSchemaNode.ts',
        'src/storage/portable/Brc38PrivatePriorImportSchemaNode.ts',
        'src/storage/schema/StorageIdbSchema.ts',
        'src/storage/schema/entities/EntityCertificate.ts',
        'src/storage/schema/entities/EntityCertificateField.ts',
        'src/storage/schema/entities/EntityCommission.ts',
        'src/storage/schema/entities/EntityOutput.ts',
        'src/storage/schema/entities/EntityOutputBasket.ts',
        'src/storage/schema/entities/EntityOutputTag.ts',
        'src/storage/schema/entities/EntityOutputTagMap.ts',
        'src/storage/schema/entities/EntityProvenTx.ts',
        'src/storage/schema/entities/EntityProvenTxReq.ts',
        'src/storage/schema/entities/EntityTransaction.ts',
        'src/storage/schema/entities/EntityTxLabel.ts',
        'src/storage/schema/entities/EntityTxLabelMap.ts',
        'src/storage/schema/snapshotSqliteIndexGeneration.ts',
        'src/storage/schema/snapshotSqliteIndexMigration.ts',
        'src/storage/schema/snapshotSqliteIndexState.ts',
        'src/storage/schema/snapshotSqliteSchemaObservations.ts',
        'src/storage/schema/snapshotSyncMigration.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedPage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedStorage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.syncLookup.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.postgres.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.telemetry.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexColdTransaction.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationAtomicity.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexPagedOrder.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/StorageProvider.authorization.test.ts',
          '<rootDir>/src/storage/__test/StorageProviderBatchFallbacks.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterRevivalAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterUserAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/TaskReviewUtxosLiquidity.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.test.ts',
          '<rootDir>/src/storage/__test/actionBatch.test.ts',
          '<rootDir>/src/storage/__test/allocateChangeInputTypeFilter.test.ts',
          '<rootDir>/src/storage/__test/completeAllTxidCopies.test.ts',
          '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRoots.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/getBeefForTransaction.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminFormatting.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminUtxoReview.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/__test/attemptToPostReqsToNetwork.security.test.ts',
          '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/__test/preparedBeef.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.test.ts',
          '<rootDir>/src/storage/methods/__tests__/actionBatchManifestBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/broadcastBatchBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/listOutputsPaging.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/reviewUtxoOutputs.test.ts',
          '<rootDir>/src/storage/methods/proofWork.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/remoting/SyncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.forwarding.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.inputBeef.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncRetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCertificate.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCommission.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityOutput.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityProvenTxReq.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntitySyncState.summary.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityTransaction.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateFieldTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CommissionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketMapping.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxReqTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/SyncStateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TransactionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/stampLogTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/usersTests.test.ts',
          '<rootDir>/src/storage/schema/entities/mergeSimpleMetadata.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteConnectionsNode.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/privateNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteDefinitions.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteSchemaObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSyncMigration.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncFailure.test.ts',
          '<rootDir>/src/storage/sync/syncProofHttp.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts',
          '<rootDir>/test/monitor/Monitor.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-journal-schema-body': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportJournalSchemaBody.property.test.ts',
      mutate: ['src/storage/portable/Brc38ImportJournalSchemaBody.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchemaBody.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlFieldSchemaBatch.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-merge-checkpoint-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportMergeCheckpointNode.ts',
        'src/storage/idbPackedMergeLookup.ts',
        'src/storage/portable/Brc38CheckpointSyncMap.ts',
        'src/storage/portable/Brc38ImportActionMergeNode.ts',
        'src/storage/portable/Brc38ImportProofMergeNode.ts',
        'src/storage/portable/Brc38ImportRequestMergeNode.ts',
        'src/storage/portable/Brc38ImportScalarMergeNode.ts',
        'src/storage/portable/Brc38ImportSimpleFieldMergeNode.ts',
        'src/storage/portable/Brc38PrivateCheckpointTextNode.ts',
        'src/storage/portable/Brc38PrivateMergePagesNode.ts',
        'src/storage/portable/Brc38PrivateMergeProgramNode.ts',
        'src/storage/portable/Brc38PrivateMergeRecoverySchemaNode.ts',
        'src/storage/portable/Brc38PrivateMergeTargetsNode.ts',
        'src/storage/portable/Brc38PrivateOperationalCheckpointNode.ts',
        'src/storage/portable/Brc38PrivateReconstructedCheckpointTextNode.ts',
        'src/storage/schema/entities/mergeSimpleMetadata.ts',
        'src/storage/schema/entities/mergeSyncChunkEntities.ts',
        'src/storage/sync/syncCheckpoint.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedPage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedStorage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.syncLookup.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.postgres.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.telemetry.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexColdTransaction.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationAtomicity.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexPagedOrder.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/StorageProvider.authorization.test.ts',
          '<rootDir>/src/storage/__test/StorageProviderBatchFallbacks.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterRevivalAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterUserAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/TaskReviewUtxosLiquidity.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.test.ts',
          '<rootDir>/src/storage/__test/actionBatch.test.ts',
          '<rootDir>/src/storage/__test/allocateChangeInputTypeFilter.test.ts',
          '<rootDir>/src/storage/__test/completeAllTxidCopies.test.ts',
          '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRoots.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/getBeefForTransaction.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminFormatting.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminUtxoReview.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/__test/attemptToPostReqsToNetwork.security.test.ts',
          '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/__test/preparedBeef.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.test.ts',
          '<rootDir>/src/storage/methods/__tests__/actionBatchManifestBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/broadcastBatchBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/listOutputsPaging.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/reviewUtxoOutputs.test.ts',
          '<rootDir>/src/storage/methods/proofWork.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/remoting/SyncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.forwarding.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.inputBeef.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncRetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCertificate.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCommission.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityOutput.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityProvenTxReq.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntitySyncState.summary.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityTransaction.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateFieldTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CommissionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketMapping.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxReqTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/SyncStateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TransactionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/stampLogTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/usersTests.test.ts',
          '<rootDir>/src/storage/schema/entities/mergeSimpleMetadata.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteConnectionsNode.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/privateNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteDefinitions.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteSchemaObservations.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncFailure.test.ts',
          '<rootDir>/src/storage/sync/syncProofHttp.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-page': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportPage.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportPage.ts',
        'src/storage/portable/Brc38PrivatePageIdsNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-provenance-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ImportProvenanceNode.ts',
        'src/storage/portable/Brc38ImportStreamedProvenanceNode.ts',
        'src/storage/portable/Brc38ImportStructuredProvenanceNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-import-target-indexes': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
      mutate: ['src/storage/portable/Brc38ImportTargetIndexes.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-knex-destination-fence': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38KnexDestinationFence.ts',
        'src/storage/snapshot/KnexSnapshotSyncDestination.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-native-catalog-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38NativeCatalogNode.ts',
        'src/storage/portable/Brc38AuthenticatedNativeMergeNode.ts',
        'src/storage/portable/Brc38CompletedNativeRestartNode.ts',
        'src/storage/portable/Brc38ComposedNativeCommitNode.ts',
        'src/storage/portable/Brc38ComposedNativeCutoverNode.ts',
        'src/storage/portable/Brc38CurrentNativeObserverNode.ts',
        'src/storage/portable/Brc38NativeBinaryFieldNode.ts',
        'src/storage/portable/Brc38NativeBinaryReadNode.ts',
        'src/storage/portable/Brc38NativeBlobProtocol.ts',
        'src/storage/portable/Brc38NativeIncomingIdReservationNode.ts',
        'src/storage/portable/Brc38NativeIncomingIdReservationSchemaNode.ts',
        'src/storage/portable/Brc38NativeLocalBaselineGenerationNode.ts',
        'src/storage/portable/Brc38NativeLocalBaselineSourceNode.ts',
        'src/storage/portable/Brc38NativeLocalBaselineTables.ts',
        'src/storage/portable/Brc38NativeLocalCaptureNode.ts',
        'src/storage/portable/Brc38NativeLocalEpochRecoverySchema.ts',
        'src/storage/portable/Brc38NativeLocalFieldProtocol.ts',
        'src/storage/portable/Brc38NativeLocalFieldReadNode.ts',
        'src/storage/portable/Brc38NativeLocalPackedCoordinate.ts',
        'src/storage/portable/Brc38NativeLocalPackedLayout.ts',
        'src/storage/portable/Brc38NativeLocalPackedLayoutNode.ts',
        'src/storage/portable/Brc38NativeLocalStructuredSourceNode.ts',
        'src/storage/portable/Brc38NativeManagedChangeTextNode.ts',
        'src/storage/portable/Brc38NativePackedFieldPreparationNode.ts',
        'src/storage/portable/Brc38NativePackedFieldsNode.ts',
        'src/storage/portable/Brc38NativePackedHashWindowNode.ts',
        'src/storage/portable/Brc38NativePackedSchemaNode.ts',
        'src/storage/portable/Brc38NativePackedTextFieldsNode.ts',
        'src/storage/portable/Brc38NativePackedTextPreparationNode.ts',
        'src/storage/portable/Brc38NativePackedTextSchemaNode.ts',
        'src/storage/portable/Brc38NativePackedTextSources.ts',
        'src/storage/portable/Brc38NativePreparedFieldSchemaNode.ts',
        'src/storage/portable/Brc38NativePreparedFieldsNode.ts',
        'src/storage/portable/Brc38NativeRecoveryScratchNode.ts',
        'src/storage/portable/Brc38NativeRetirementNode.ts',
        'src/storage/portable/Brc38NativeStreamedProvenanceNode.ts',
        'src/storage/portable/Brc38NativeTailLayout.ts',
        'src/storage/portable/Brc38NativeTailLayoutNode.ts',
        'src/storage/portable/Brc38NativeTextReadNode.ts',
        'src/storage/portable/Brc38PendingComposedNativeTargetError.ts',
        'src/storage/portable/Brc38PrivateNativeMergeNode.ts',
        'src/storage/portable/Brc38PrivateNativeMergeRunnerNode.ts',
        'src/storage/portable/Brc38PrivateNativeOwnershipNode.ts',
        'src/storage/portable/Brc38RetiredNativeReadNode.ts',
        'src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.ts',
        'src/storage/portable/Brc38UncommittedNativeRecoveryNode.ts',
        'src/storage/portable/Brc39ComposedNativeRecoveryNode.ts',
        'src/storage/portable/Brc39ComposedNativeRetryNode.ts',
        'src/storage/schema/ownedNativeSqliteConnectionsNode.ts',
        'src/storage/schema/ownedNativeSqliteRuntimeNode.ts',
        'src/storage/schema/privateNativeSqliteRuntimeNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncActionsCurrentNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncActionsNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncMappingSchemaNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncParentFencesNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncProofReaderNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncProvenTxReqsNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncProvenTxsNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncRequestsCurrentNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncSimpleCurrentNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncSimplePayloadNode.ts',
        'src/storage/snapshot/NativeSnapshotSyncSimpleRows.ts',
        'src/storage/snapshot/NativeSnapshotSyncStructuredWorkspaceNode.ts',
        'src/storage/snapshot/preparePackedNativeSnapshotFieldNode.ts',
        'src/storage/snapshot/verifyNativeSnapshotSyncSchemaNode.ts',
        'src/storage/snapshot/writeNativeSnapshotSyncRowNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedDatabaseImageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBlobProtocol.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalFieldProtocol.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalPackedCoordinate.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePayloadTextProtocol.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayout.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteConnectionsNode.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/privateNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-owned-import-reads': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38OwnedImportReads.property.test.ts',
      mutate: ['src/storage/portable/Brc38OwnedImportReads.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38OwnedImportReads.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38OwnedImportReads.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-portable-rows': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PortableRows.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PortableRows.ts',
        'src/storage/snapshot/archive/RemoteSnapshotRows.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38PortableRows.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotRows.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-private-chunk-pipe': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PrivateChunkPipe.property.test.ts',
      mutate: ['src/storage/portable/Brc38PrivateChunkPipe.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38PrivateChunkPipe.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateChunkPipe.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-private-destination-lease-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PrivateDestinationLeaseNode.ts',
        'src/storage/snapshot/archive/RemoteSnapshotLease.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotLease.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-private-import-journal-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PrivateImportJournalNode.ts',
        'src/storage/portable/Brc38ImportEntityRestoreNode.ts',
        'src/storage/portable/Brc38PrivateEmptyBootstrapNode.ts',
        'src/storage/portable/Brc38PrivateNativeRestoreNode.ts',
        'src/storage/portable/Brc38IdbImportJournal.ts',
        'src/storage/portable/Brc38ImportJournalContract.ts',
        'src/storage/portable/Brc38PrivateLocalCandidateJournalNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalContract.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-private-import-preview-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PrivateImportPreviewNode.ts',
        'src/storage/portable/Brc38AuthenticatedIdbPreviewBrowser.ts',
        'src/storage/portable/Brc38ImportDecodedBudget.ts',
        'src/storage/portable/Brc38ImportForms.ts',
        'src/storage/portable/Brc38ImportStreamedEntityRestoreNode.ts',
        'src/storage/portable/Brc38ImportStructuredEntityRestoreNode.ts',
        'src/storage/portable/Brc38NativePriorImportTables.ts',
        'src/storage/portable/Brc38PrivatePriorImportNode.ts',
        'src/storage/portable/Brc39ComposedNativeImportNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonAllocation.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-private-publication-copy-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PrivatePublicationCopyNode.property.test.ts',
      mutate: ['src/storage/portable/Brc38PrivatePublicationCopyNode.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38PrivatePublicationCopyNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivatePublicationCopyNode.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-profile-inventory-claim-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38ProfileInventoryClaimNode.ts',
        'src/storage/portable/Brc38ProfileInventoryNode.ts',
        'src/storage/portable/Brc38IdbPackedReferenceInventory.ts',
        'src/storage/portable/Brc38IdbRestoreInventory.ts',
        'src/storage/portable/Brc38NativePackedTextInventoryNode.ts',
        'src/storage/portable/Brc38PrivateCheckpointInventoryNode.ts',
        'src/storage/portable/Brc38PrivateLocalInventoryNode.ts',
        'src/storage/portable/Brc38PrivateMergeHistoryInventoryNode.ts',
        'src/storage/portable/Brc38PrivatePriorImportInventoryNode.ts',
        'src/storage/portable/Brc38PrivateProofInventoryNode.ts',
        'src/storage/portable/Brc38PrivateRequestInventoryNode.ts',
        'src/storage/portable/Brc38PrivateScalarInventoryNode.ts',
        'src/storage/portable/Brc38PrivateSelectedFieldInventoryNode.ts',
        'src/storage/portable/Brc38PrivateSimpleFieldInventoryNode.ts',
        'src/storage/portable/Brc38PrivateUserInventoryNode.ts',
        'src/storage/portable/Brc38StreamedNativeInventoryNode.ts',
        'src/storage/portable/Brc38StructuredNativeFieldInventoryNode.ts',
        'src/storage/portable/Brc38StructuredNativeInventoryNode.ts',
        'src/storage/portable/Brc38TextNativeFieldInventoryNode.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-profile-physical-identity-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38ProfilePhysicalIdentityNode.property.test.ts',
      mutate: ['src/storage/portable/Brc38ProfilePhysicalIdentityNode.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38PrivatePublicationCopyNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivatePublicationCopyNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfilePhysicalIdentityNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfilePhysicalIdentityNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-published-profile-receipt-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PublishedProfileReceiptNode.ts',
        'src/storage/portable/Brc38PublishedProfileNode.ts',
        'src/storage/portable/Brc38PublishedWalletNode.ts',
        'src/storage/portable/Brc38ComposedProfileReceiptNode.ts',
        'src/storage/portable/Brc38IdbProfileRetirementBrowser.ts',
        'src/storage/portable/Brc38IdbProfileSelection.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-published-wallet-data': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38PublishedWalletData.ts',
        'src/WalletAuthenticationManager.ts',
        'src/storage/WalletStorageManager.ts',
        'src/storage/portable/Brc38ManagedNativeCurrentDataFenceNode.ts',
        'src/storage/portable/Brc38NativeLocalPackedWalletNode.ts',
        'src/storage/portable/Brc38NativePackedTextWalletNode.ts',
        'src/storage/portable/Brc38NativePackedWalletNode.ts',
        'src/storage/portable/Brc38PrivateCheckpointData.ts',
        'src/storage/portable/Brc38PublishedStructuredInventoryNode.ts',
        'src/storage/portable/Brc38PublishedStructuredSourceNode.ts',
        'src/storage/snapshot/SnapshotSyncRowData.ts',
        'src/storage/snapshot/WalletReadSnapshot.ts',
        'src/storage/snapshot/observeWalletSnapshotFieldReader.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/__tests/Wallet.identityDiscovery.pagination.test.ts',
          '<rootDir>/src/__tests/Wallet.identityDiscovery.wire.test.ts',
          '<rootDir>/src/__tests/Wallet.identityVerification.test.ts',
          '<rootDir>/src/__tests/WalletAuthenticationManager.boundaries.test.ts',
          '<rootDir>/src/__tests/WalletAuthenticationManager.storageFunding.test.ts',
          '<rootDir>/src/__tests__/PhoneNumberChange.test.ts',
          '<rootDir>/src/__tests__/WalletAuthenticationContinuity.test.ts',
          '<rootDir>/src/monitor/__test/MonitorDaemon.test.ts',
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCursor.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotRows.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/observeWalletSnapshotFieldReader.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncFailure.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts',
          '<rootDir>/src/wab-client/__tests/WABTransport.test.ts',
          '<rootDir>/test/Wallet/action/knownTxidsResultBeef.test.ts',
          '<rootDir>/test/Wallet/action/noSendExpiry.test.ts',
          '<rootDir>/test/storage/getStoreEndpointURL.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-semantic-stage': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38SemanticStage.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38SemanticStage.ts',
        'src/storage/portable/Brc38NativeBackendNode.ts',
        'src/storage/portable/Brc38NativeImportJournalNode.ts',
        'src/storage/portable/Brc38NativeImportJournalSchemaNode.ts',
        'src/storage/portable/Brc38NativePublishedWalletNode.ts',
        'src/storage/portable/Brc38NativeExecutable.cjs',
        'src/storage/portable/NativeProfileSqlite.cjs',
        'src/storage/portable/Brc38IdbOccupiedHistoryStage.ts',
        'src/storage/portable/Brc38PrivateIdbStage.ts',
        'src/storage/portable/Brc38StreamedSemanticStage.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeExecutableNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-staging-admission-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38StagingAdmissionNode.ts',
        'src/storage/snapshot/archive/SnapshotArchiveAdmission.ts',
        'src/storage/sync/commitSyncAdmission.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveAdmission.test.ts',
          '<rootDir>/src/storage/sync/commitSyncAdmission.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-staging-binding': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38StagingBinding.property.test.ts',
      mutate: ['src/storage/portable/Brc38StagingBinding.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingBinding.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingBinding.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-staging-cleanup-error': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38StagingCleanupError.property.test.ts',
      mutate: [
        'src/storage/portable/Brc38StagingCleanupError.ts',
        'src/storage/snapshot/archive/SnapshotArchiveCleanup.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38OwnedByteSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38OwnedPreparation.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateFilesystemNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingCleanupError.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingCleanupError.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedBrowserKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.property.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-brc38-staging-ownership-node': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/Brc38StagingOwnershipNode.property.test.ts',
      mutate: ['src/storage/portable/Brc38StagingOwnershipNode.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/Brc38StagingOwnershipNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingOwnershipNode.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-knex-brc38-staging-store': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
      mutate: [
        'src/storage/portable/KnexBrc38StagingStore.ts',
        'src/storage/StorageKnex.ts',
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
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/WalletStorageManager.ts',
          'private async trySetActiveHandoff(',
          'private async trySetActiveJournal('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/WalletStorageManager.ts',
          'private async runAsAuthorizedWriter<R>(',
          'runAsReader<R>('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/WalletStorageManager.ts',
          'private async copyJournalWindow(',
          'private async confirmLocalJournalPushContent('
        ),
        'src/storage/schema/primaryHandoffMigration.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/schema/KnexMigrations.ts',
          'migrations[PRIMARY_HANDOFF_MIGRATION] = {',
          'migrations[SNAPSHOT_JOURNAL_DESTINATION_MIGRATION] = {'
        ),
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
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/WalletStorageManager.ts',
          'runAsStorageProvider<R>(',
          'invalidatePreparedBeefsForReorg(): Promise<void>'
        ),
        'src/monitor/tasks/TaskCheckForProofs.ts',
        'src/monitor/tasks/TaskArcSSE.ts',
        'src/monitor/tasks/TaskUnFail.ts',
        'src/storage/methods/processAction.ts',
        'src/storage/methods/attemptToPostReqsToNetwork.ts',
        'src/storage/methods/reconcileFailedTransactionInputs.ts',
        'src/storage/methods/createAction.ts',
        'src/storage/methods/actionBatch.ts',
        'src/storage/methods/actionBatchBlobs.ts',
        'src/storage/methods/noSendExpiry.ts',
        'src/storage/methods/internalizeAction.ts',
        'src/storage/idbPackedStaging.ts',
        'src/storage/methods/listActionsKnex.ts',
        'src/storage/methods/listOutputsKnex.ts',
        'src/storage/portable/Brc38ComposedDatabaseImageNode.ts',
        'src/storage/portable/Brc38IdbPreparedRestoreRow.ts',
        'src/storage/portable/Brc38IdbRestoreBinary.ts',
        'src/storage/portable/Brc38IdbRestoreMetadata.ts',
        'src/storage/portable/Brc38IdbRestorePublication.ts',
        'src/storage/portable/Brc38IdbRestoreText.ts',
        'src/storage/portable/Brc38IdbSource.ts',
        'src/storage/portable/Brc38IdbStreamedFieldSink.ts',
        'src/storage/portable/Brc38IdbStreamedProof.ts',
        'src/storage/portable/Brc38IdbStructuredFieldSink.ts',
        'src/storage/portable/Brc38IdbTextFieldSink.ts',
        'src/storage/portable/Brc38JsonAllocation.ts',
        'src/storage/portable/Brc38JsonBinaryFields.ts',
        'src/storage/portable/Brc38JsonStream.ts',
        'src/storage/portable/Brc38JsonStructuredFields.ts',
        'src/storage/portable/Brc38JsonTextFields.ts',
        'src/storage/portable/Brc38KnexSource.ts',
        'src/storage/portable/Brc38NodeJsonIndex.ts',
        'src/storage/portable/Brc38OwnedByteSource.ts',
        'src/storage/portable/Brc38OwnedPreparation.ts',
        'src/storage/portable/Brc38PackedRestoreMetadataNode.ts',
        'src/storage/portable/Brc38PackedRow.ts',
        'src/storage/portable/Brc38PrivateContentVersionNode.ts',
        'src/storage/portable/Brc38PrivateCurrentStructuredSourceNode.ts',
        'src/storage/portable/Brc38PrivateDerivedTextComparisonNode.ts',
        'src/storage/portable/Brc38PrivateDerivedTextLifetimesNode.ts',
        'src/storage/portable/Brc38PrivateDerivedTextVersionNode.ts',
        'src/storage/portable/Brc38PrivateFilesystemNode.ts',
        'src/storage/portable/Brc38PrivateIdbOwnership.ts',
        'src/storage/portable/Brc38PrivateIdbStructuredPolicy.ts',
        'src/storage/portable/Brc38PrivateLocalBaselineRowNode.ts',
        'src/storage/portable/Brc38PrivateLocalCandidateNode.ts',
        'src/storage/portable/Brc38PrivateLocalPackedRowWriterNode.ts',
        'src/storage/portable/Brc38PrivateLocalSequencesNode.ts',
        'src/storage/portable/Brc38PrivateLocalUniqueNode.ts',
        'src/storage/portable/Brc38PrivateNewRequestTextNode.ts',
        'src/storage/portable/Brc38PrivateOccupiedNotifyTextNode.ts',
        'src/storage/portable/Brc38PrivateOccupiedRequestSourcesNode.ts',
        'src/storage/portable/Brc38PrivateProofOriginalFieldsNode.ts',
        'src/storage/portable/Brc38PrivateStructuredPolicy.ts',
        'src/storage/portable/Brc38RawTransactionStream.ts',
        'src/storage/portable/Brc38SqlBinaryStaging.ts',
        'src/storage/portable/Brc38SqlCanonicalStructuredStaging.ts',
        'src/storage/portable/Brc38SqlFieldSchemaBatch.ts',
        'src/storage/portable/Brc38SqlProjectedStructuredStaging.ts',
        'src/storage/portable/Brc38SqlRowFieldRead.ts',
        'src/storage/portable/Brc38SqlSourceFieldRead.ts',
        'src/storage/portable/Brc38SqlStreamedFieldSink.ts',
        'src/storage/portable/Brc38SqlStructuredChunkWindowNode.ts',
        'src/storage/portable/Brc38SqlStructuredFieldSink.ts',
        'src/storage/portable/Brc38SqlStructuredPrefixGuards.ts',
        'src/storage/portable/Brc38SqlStructuredStaging.ts',
        'src/storage/portable/Brc38SqlTextFieldSink.ts',
        'src/storage/portable/Brc38SqlTextStaging.ts',
        'src/storage/portable/Brc38Stream.ts',
        'src/storage/portable/Brc38StreamedNotifyField.ts',
        'src/storage/portable/Brc38StreamedNotifyProjection.ts',
        'src/storage/portable/Brc38StreamedNotifyProjectionNode.ts',
        'src/storage/portable/Brc38StreamedProof.ts',
        'src/storage/portable/Brc38StreamedRow.ts',
        'src/storage/portable/Brc38StreamedText.ts',
        'src/storage/portable/Brc38StructuredFilesystemNode.ts',
        'src/storage/portable/Brc38StructuredInlineProofNode.ts',
        'src/storage/portable/Brc38StructuredJson.ts',
        'src/storage/portable/Brc38StructuredProjectionOwners.ts',
        'src/storage/portable/Brc38StructuredRestoreResourcesNode.ts',
        'src/storage/portable/Brc38Utf16Chunks.ts',
        'src/storage/portable/Brc38Utf8Chunks.ts',
        'src/storage/portable/Brc38Utf8Length.ts',
        'src/storage/portable/Brc38WorkingAllocation.ts',
        'src/storage/portable/Brc39ExpiredPendingComposedRecoveryNode.ts',
        'src/storage/portable/Brc39Frame.ts',
        'src/storage/portable/Brc39OwnedBrowserEnvelope.ts',
        'src/storage/portable/Brc39OwnedBrowserKey.ts',
        'src/storage/portable/Brc39OwnedNodeKey.ts',
        'src/storage/portable/Brc39PendingComposedRecoveryNode.ts',
        'src/storage/portable/Brc39PrivateFileNode.ts',
        'src/storage/portable/Brc39RecoveryAuthenticationNode.ts',
        'src/storage/portable/Brc39RecoveryIncomingComparisonNode.ts',
        'src/storage/portable/Brc39StreamBrowser.ts',
        'src/storage/portable/Brc39StreamNode.ts',
        'src/storage/portable/Brc39WebCryptoGcm.ts',
        'src/storage/portable/CanonicalPortableChunks.ts',
        'src/storage/portable/index.ts',
        'src/storage/portable/node.ts',
        'src/storage/portable/stream.ts',
        'src/storage/remoting/KnexPaymentReplayStore.ts',
        'src/storage/remoting/KnexSyncTransferStore.ts',
        'src/storage/schema/KnexMigrations.ts',
        'src/storage/snapshot/KnexWalletReadSnapshot.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveClosure.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveStore.ts'
      ],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'src/storage/StorageActiveWrite.ts',
        'src/storage/PrimaryHandoffControl.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/__test/StorageKnexActiveWriteFence.test.ts',
          '<rootDir>/src/storage/__test/KnexPrimaryHandoffControl.test.ts',
          '<rootDir>/src/storage/snapshot/journal/KnexSnapshotJournalDataDestination.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskSendWaiting.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskReviewUtxos.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskReviewDoubleSpends.test.ts',
          '<rootDir>/src/monitor/tasks/__tests__/TaskNoSendExpiry.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskFailAbandoned.test.ts',
          '<rootDir>/test/Wallet/action/actionBatch.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskReconcilePendingTransactions.test.ts',
          '<rootDir>/test/storage/reviewStatus.test.ts',
          '<rootDir>/src/storage/__test/completeAllTxidCopies.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskCheckForProofs.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskArcSSE.test.ts',
          '<rootDir>/src/monitor/tasks/__tests/TaskUnFail.test.ts',
          '<rootDir>/src/monitor/__test/MonitorDaemon.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedStorage.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.postgres.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.telemetry.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexColdTransaction.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationAtomicity.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexPagedOrder.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/StorageProvider.authorization.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/__test/attemptToPostReqsToNetwork.security.test.ts',
          '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/__test/preparedBeef.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.test.ts',
          '<rootDir>/src/storage/methods/__tests__/actionBatchManifestBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/broadcastBatchBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/listOutputsPaging.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/reviewUtxoOutputs.test.ts',
          '<rootDir>/src/storage/methods/proofWork.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedDatabaseImageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonAllocation.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38OwnedByteSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38OwnedPreparation.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateFilesystemNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateStructuredPolicy.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38RawTransactionStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlFieldSchemaBatch.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredFilesystemNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Utf16Chunks.test.ts',
          '<rootDir>/src/storage/portable/Brc38Utf8Chunks.test.ts',
          '<rootDir>/src/storage/portable/Brc38Utf8Length.test.ts',
          '<rootDir>/src/storage/portable/Brc38WorkingAllocation.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedBrowserKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedNodeKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/CanonicalPortableChunks.property.test.ts',
          '<rootDir>/src/storage/portable/CanonicalPortableChunks.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/remoting/SyncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketMapping.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/test/Wallet/action/knownTxidsResultBeef.test.ts',
          '<rootDir>/test/Wallet/action/noSendExpiry.test.ts',
          '<rootDir>/test/wallet/sync/Wallet.sync.test.ts',
          '<rootDir>/test/storage/count.test.ts',
          '<rootDir>/test/storage/find.test.ts',
          '<rootDir>/test/storage/insert.test.ts',
          '<rootDir>/test/storage/portable.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-knex-database-system': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/schema/knexDatabaseSystem.property.test.ts',
      mutate: [
        'src/storage/schema/knexDatabaseSystem.ts',
        'src/storage/remoting/KnexSessionManager.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveRpc.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveService.ts',
        'src/storage/snapshot/archive/captureKnexSnapshotArchive.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.property.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-delta-frame': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
      mutate: ['src/storage/snapshot/journal/SnapshotJournalDeltaFrame.ts'],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-delta-page': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
      mutate: [
        'src/storage/snapshot/journal/SnapshotJournalDeltaPage.ts',
        'src/storage/idbPackedPage.ts',
        'src/storage/snapshot/archive/RemoteSnapshotPageReader.ts',
        'src/storage/snapshot/journal/SnapshotJournalCapturedPage.ts',
        'src/storage/snapshot/journal/SnapshotJournalPage.ts',
        'src/storage/sync/snapshotSyncPage.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedPage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedStorage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.syncLookup.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.postgres.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.telemetry.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexColdTransaction.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationAtomicity.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexPagedOrder.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/StorageProvider.authorization.test.ts',
          '<rootDir>/src/storage/__test/StorageProviderBatchFallbacks.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterRevivalAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterUserAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/TaskReviewUtxosLiquidity.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.test.ts',
          '<rootDir>/src/storage/__test/actionBatch.test.ts',
          '<rootDir>/src/storage/__test/allocateChangeInputTypeFilter.test.ts',
          '<rootDir>/src/storage/__test/completeAllTxidCopies.test.ts',
          '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRoots.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/getBeefForTransaction.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminFormatting.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminUtxoReview.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/__test/attemptToPostReqsToNetwork.security.test.ts',
          '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/__test/preparedBeef.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.test.ts',
          '<rootDir>/src/storage/methods/__tests__/actionBatchManifestBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/broadcastBatchBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/listOutputsPaging.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/reviewUtxoOutputs.test.ts',
          '<rootDir>/src/storage/methods/proofWork.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/remoting/SyncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.forwarding.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.inputBeef.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncRetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCertificate.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCommission.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityOutput.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityProvenTxReq.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntitySyncState.summary.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityTransaction.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateFieldTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CommissionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketMapping.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxReqTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/SyncStateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TransactionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/stampLogTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/usersTests.test.ts',
          '<rootDir>/src/storage/schema/entities/mergeSimpleMetadata.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteConnectionsNode.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/privateNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteDefinitions.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteSchemaObservations.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotOpening.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/src/storage/sync/SyncPageBudget.property.test.ts',
          '<rootDir>/src/storage/sync/SyncPageBudget.test.ts',
          '<rootDir>/src/storage/sync/snapshotSyncPage.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncFailure.test.ts',
          '<rootDir>/src/storage/sync/syncProofHttp.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-destination-stage': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
      mutate: [
        'src/storage/snapshot/journal/SnapshotJournalDestinationStage.ts',
        'src/storage/snapshot/stageIdbSnapshotSyncText.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-destination-window': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
      mutate: [
        'src/storage/snapshot/journal/SnapshotJournalDestinationWindow.ts',
        'src/storage/snapshot/IdbSnapshotSyncDestination.ts',
        'src/storage/snapshot/journal/KnexSnapshotJournalDestination.ts',
        'src/storage/snapshot/journal/SnapshotJournalDestinationPromotion.ts',
        'src/storage/snapshot/journal/SnapshotJournalDestinationSchema.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeDestinationSchema.ts',
        'src/storage/snapshot/journal/SnapshotJournalWindowCleanup.ts'
      ],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalBaselineBatchNode.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-identity-ledger': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
      mutate: ['src/storage/snapshot/journal/SnapshotJournalIdentityLedger.ts'],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-identity-retirements': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
      mutate: [
        'src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.ts',
        'src/storage/schema/snapshotSqliteIdentity.ts',
        'src/storage/schema/snapshotSqliteIdentityObservations.ts'
      ],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'test/utils/snapshotSqliteFixtures.ts',
        'test/utils/snapshotSqliteMaintenanceFixture.ts',
        'src/storage/schema/snapshotSqliteMembership.ts',
        'src/storage/schema/snapshotSqliteIndexGeneration.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteSharedMembership.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteCompactMembership.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-source-generations': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
      mutate: ['src/storage/snapshot/journal/SnapshotJournalSourceGenerations.ts'],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-snapshot-journal-source-identities': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
      mutate: [
        'src/storage/snapshot/journal/SnapshotJournalSourceIdentities.ts',
        'src/storage/StorageIdb.ts',
        'src/storage/StorageProvider.ts',
        'src/storage/idbHelpers.ts',
        'src/storage/idbPackedConnection.ts',
        'src/storage/idbPackedCurrentMetadata.ts',
        'src/storage/idbPackedFields.ts',
        'src/storage/idbPackedJsonIndex.ts',
        'src/storage/idbPackedReclaimMetadata.ts',
        'src/storage/idbPackedSnapshot.ts',
        'src/storage/methods/SyncProofErrors.ts',
        'src/storage/methods/validateSyncProof.ts',
        'src/storage/remoting/BinaryJson.ts',
        'src/storage/remoting/SyncTransfer.ts',
        'src/storage/snapshot/IdbSnapshotSyncActions.ts',
        'src/storage/snapshot/IdbSnapshotSyncCertificateFields.ts',
        'src/storage/snapshot/IdbSnapshotSyncCertificates.ts',
        'src/storage/snapshot/IdbSnapshotSyncCommissions.ts',
        'src/storage/snapshot/IdbSnapshotSyncJournal.ts',
        'src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.ts',
        'src/storage/snapshot/IdbSnapshotSyncProvenTxs.ts',
        'src/storage/snapshot/IdbSnapshotSyncStructuredWorkspace.ts',
        'src/storage/snapshot/NativeSnapshotSyncStructuredSourceNode.ts',
        'src/storage/snapshot/PackedIdbCurrentStructuredRead.ts',
        'src/storage/snapshot/SnapshotCursor.ts',
        'src/storage/snapshot/SnapshotSyncActionMetadata.ts',
        'src/storage/snapshot/SnapshotSyncNormalizedNotify.ts',
        'src/storage/snapshot/SnapshotSyncRequestMetadata.ts',
        'src/storage/snapshot/SnapshotSyncScalarFields.ts',
        'src/storage/snapshot/SnapshotSyncSmallText.ts',
        'src/storage/snapshot/SnapshotWorkingAllocationLimitError.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveSource.ts',
        'src/storage/snapshot/archive/SnapshotArchive.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuard.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuardBackend.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuardRegistry.ts',
        'src/storage/snapshot/archive/SnapshotArchiveRequest.ts',
        'src/storage/snapshot/archive/SnapshotArchiveSql.ts',
        'src/storage/snapshot/archive/captureSnapshotArchiveSource.ts',
        'src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.ts',
        'src/storage/snapshot/journal/SnapshotJournalBootstrap.ts',
        'src/storage/snapshot/journal/SnapshotJournalCapture.ts',
        'src/storage/snapshot/journal/SnapshotJournalCaptureBackend.ts',
        'src/storage/snapshot/journal/SnapshotJournalCaptureFence.ts',
        'src/storage/snapshot/journal/SnapshotJournalCapturedIdentities.ts',
        'src/storage/snapshot/journal/SnapshotJournalCollection.ts',
        'src/storage/snapshot/journal/SnapshotJournalConnections.ts',
        'src/storage/snapshot/journal/SnapshotJournalCopyLimits.ts',
        'src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.ts',
        'src/storage/snapshot/journal/SnapshotJournalDestinationIdentities.ts',
        'src/storage/snapshot/journal/SnapshotJournalEntityMerge.ts',
        'src/storage/snapshot/journal/SnapshotJournalHighWater.ts',
        'src/storage/snapshot/journal/SnapshotJournalLifecycle.ts',
        'src/storage/snapshot/journal/SnapshotJournalLineage.ts',
        'src/storage/snapshot/journal/SnapshotJournalMaintenance.ts',
        'src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.ts',
        'src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.ts',
        'src/storage/snapshot/journal/SnapshotJournalMemberships.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlClock.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlIntent.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlObservers.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlSource.ts',
        'src/storage/snapshot/journal/SnapshotJournalMysqlSourceUpgrade.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeCustody.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativePayload.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeReferences.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeRows.ts',
        'src/storage/snapshot/journal/SnapshotJournalOwnedWriter.ts',
        'src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.ts',
        'src/storage/snapshot/journal/SnapshotJournalProgress.ts',
        'src/storage/snapshot/journal/SnapshotJournalProvenance.ts',
        'src/storage/snapshot/journal/SnapshotJournalProvider.ts',
        'src/storage/snapshot/journal/SnapshotJournalReceipt.ts',
        'src/storage/snapshot/journal/SnapshotJournalRetirementCleanup.ts',
        'src/storage/snapshot/journal/SnapshotJournalRevision.ts',
        'src/storage/snapshot/journal/SnapshotJournalRevisionSql.ts',
        'src/storage/snapshot/journal/SnapshotJournalRowReferences.ts',
        'src/storage/snapshot/journal/SnapshotJournalSharedQuota.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeQuotaSql.ts',
        'src/storage/snapshot/journal/SnapshotJournalNativeQuotaLayout.ts',
        'src/storage/snapshot/journal/SnapshotJournalSqliteClock.ts',
        'src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.ts',
        'src/storage/snapshot/journal/SnapshotJournalSqliteObservers.ts',
        'src/storage/snapshot/journal/SnapshotJournalTypes.ts',
        'src/storage/snapshot/journal/SnapshotJournalWithdrawals.ts',
        'src/storage/snapshot/journal/closeSnapshotJournalSource.ts',
        'src/storage/snapshot/journal/runSnapshotJournalReconciliation.ts',
        'src/storage/snapshot/openPackedIdbSyncSource.ts',
        'src/storage/snapshot/preparePackedIdbSnapshotField.ts',
        'src/storage/snapshot/runSnapshotSyncSession.ts',
        'src/storage/sync/syncFailure.ts',
        'src/storage/sync/syncSession.ts',
        'src/utility/hashWasm.ts'
      ],
      additionalInputs: [
        'test/utils/mysqlReadSnapshotFixture.ts',
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/mobile/test/argon2-fallback.test.ts',
          '<rootDir>/mobile/test/argon2-no-wasm.test.ts',
          '<rootDir>/mobile/test/argon2-output.test.ts',
          '<rootDir>/src/__tests/Wave28Compatibility.test.ts',
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedPage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.packedStorage.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.syncLookup.test.ts',
          '<rootDir>/src/storage/__test/StorageIdb.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.postgres.test.ts',
          '<rootDir>/src/storage/__test/StorageKnex.telemetry.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexColdTransaction.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationAtomicity.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexPagedOrder.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/StorageProvider.authorization.test.ts',
          '<rootDir>/src/storage/__test/StorageProviderBatchFallbacks.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterRevivalAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/StorageReaderWriterUserAtomicity.security.test.ts',
          '<rootDir>/src/storage/__test/TaskReviewUtxosLiquidity.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.providerTransition.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.test.ts',
          '<rootDir>/src/storage/__test/actionBatch.test.ts',
          '<rootDir>/src/storage/__test/allocateChangeInputTypeFilter.test.ts',
          '<rootDir>/src/storage/__test/completeAllTxidCopies.test.ts',
          '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRoots.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/getBeefForTransaction.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminFormatting.test.ts',
          '<rootDir>/src/storage/adminServer/__tests/adminUtxoReview.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/__test/attemptToPostReqsToNetwork.security.test.ts',
          '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
          '<rootDir>/src/storage/methods/__test/offsetKey.test.ts',
          '<rootDir>/src/storage/methods/__test/preparedBeef.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/ListOutputsSpecOp.test.ts',
          '<rootDir>/src/storage/methods/__tests__/actionBatchManifestBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/broadcastBatchBounds.security.test.ts',
          '<rootDir>/src/storage/methods/__tests__/listOutputsPaging.storage.test.ts',
          '<rootDir>/src/storage/methods/__tests__/reviewUtxoOutputs.test.ts',
          '<rootDir>/src/storage/methods/proofWork.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedImportRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedNativeProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedPrivateStageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ComposedPublishedReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38IdbRestoreMetadata.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityMergeNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportEntityTargets.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportExistingRows.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportFieldPolicyRowsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportHistory.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportIdMap.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalCharges.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournalSchema.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeCheckpointNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportPageNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportReadDestinationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredEntityRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportStructuredProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportTargetIndexes.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStream.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexDestinationFence.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBaselineInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryFieldNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeBinaryReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateResumeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateSchemaContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCandidateUniqueContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCatalogNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentCommitFenceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentSourceContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeCurrentStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeDeleteActivationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeIncomingAllocationContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalCaptureContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeLocalStructuredContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMergeContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeMetadataContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedFieldPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedHashWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedPayloadTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextPreparationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePortableInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePrivateContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSharedQuota.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalNativeQuotaSql.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeProfileTransferNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRecoveryScratchNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeReopenNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeRetirementNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeStreamedContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTailLayoutNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeTextReadNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38OriginalAllocationInventoryContractsNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateDestinationLeaseNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateEmptyBootstrapNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateIdbStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportHistoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportJournalNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportPreviewNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateImportProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeComparisonNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeCopyDescriptorNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateNativeRestoreNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PrivateSchemaMigrationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryClaimNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38ProfileInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedProfileReceiptNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedStructuredSourceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletData.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38PublishedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38SemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlProjectedStructuredStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlRowFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlSourceFieldRead.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredChunkWindowNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlStructuredCompletion.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38StagingAdmissionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38Stream.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedHistoryProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjection.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedNotifyProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSemanticStage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedSyncMapProjectionNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedText.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeFieldInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeInventoryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredNativeReceiverSchemaNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredRestoreResourcesNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.property.test.ts',
          '<rootDir>/src/storage/portable/Brc39OwnedNodeKey.test.ts',
          '<rootDir>/src/storage/portable/Brc39PrivateFileNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39RecoveryAuthenticationNode.test.ts',
          '<rootDir>/src/storage/portable/Brc39StreamNode.test.ts',
          '<rootDir>/src/storage/portable/EntryPoints.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingResume.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.property.test.ts',
          '<rootDir>/src/storage/portable/KnexBrc38StagingStore.test.ts',
          '<rootDir>/src/storage/portable/SnapshotIndexDefinitionsNode.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/remoting/SyncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexStores.postgres.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.forwarding.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.inputBeef.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncRetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/remoting/syncChunkBinary.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCertificate.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityCommission.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityOutput.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityProvenTxReq.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/EntitySyncState.summary.test.ts',
          '<rootDir>/src/storage/schema/entities/EntityTransaction.metadataMerge.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateFieldTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CertificateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/CommissionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketMapping.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputBasketTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTagTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/OutputTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxReqTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/ProvenTxTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/SyncStateTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TransactionTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelMapTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/TxLabelTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/stampLogTests.test.ts',
          '<rootDir>/src/storage/schema/entities/__tests/usersTests.test.ts',
          '<rootDir>/src/storage/schema/entities/mergeSimpleMetadata.test.ts',
          '<rootDir>/src/storage/schema/knexDatabaseSystem.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteConnectionsNode.test.ts',
          '<rootDir>/src/storage/schema/ownedNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/privateNativeSqliteRuntimeNode.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteDefinitions.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteSchemaObservations.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncCertificateFields.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncJournal.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxReqs.test.ts',
          '<rootDir>/src/storage/snapshot/IdbSnapshotSyncProvenTxs.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletSnapshotBinary.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncProofCurrentNode.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotSyncSimpleRows.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbMergeLookup.test.ts',
          '<rootDir>/src/storage/snapshot/PackedIdbSyncFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/PostgresSnapshotCompatibility.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCertificateIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCursor.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.mysql.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotGlobalIndexes.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotProfileIndexes.migration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotRelationIndexes.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteActualSchema.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteAllFamilies.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteFileWal.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSqliteIdentity.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncActionMetadata.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncScalarFields.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotRows.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveAdmission.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuardBackend.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderOffer.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderRequest.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveRequest.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveTransport.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalBootstrapPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCaptureFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCollection.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalConnections.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCurrentDataFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaFrame.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationStage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDestinationWindow.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalHighWater.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityLedger.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalIdentityRetirements.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlBootstrap.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlIntent.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMysqlSource.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrerequisites.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalPrimaryCommitFence.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceipt.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalReceiptMysql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalRevisionSql.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceGenerations.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSourceIdentities.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteClock.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalSqliteObserverColumns.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/snapshot/preparePackedIdbSnapshotField.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncFailure.test.ts',
          '<rootDir>/src/storage/sync/syncProofHttp.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts',
          '<rootDir>/test/Wallet/certificate/listCertificates.test.ts',
          '<rootDir>/test/storage/idb/allocateChange.test.ts',
          '<rootDir>/test/storage/idb/count.test.ts',
          '<rootDir>/test/storage/idb/find.test.ts',
          '<rootDir>/test/storage/idb/insert.test.ts',
          '<rootDir>/test/storage/idb/reviewStatus.test.ts',
          '<rootDir>/test/storage/idb/transactionAbort.test.ts',
          '<rootDir>/test/storage/idb/update.test.ts',
          '<rootDir>/test/storage/processAction.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-current-storage-access-queue': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/sync/StorageAccessQueue.property.test.ts',
      mutate: [
        'src/storage/sync/StorageAccessQueue.ts',
        'src/index.client.ts',
        'src/storage/DeviceBackupController.ts',
        'src/storage/index.all.ts',
        'src/storage/index.client.ts',
        'src/storage/index.mobile.ts',
        'src/storage/remoting/RateLimitPolicy.ts',
        'src/storage/remoting/StorageClient.ts',
        'src/storage/remoting/StorageClientBase.ts',
        'src/storage/remoting/StorageMobile.ts',
        'src/storage/remoting/StorageServer.ts',
        'src/storage/remoting/edgePolicy.ts',
        'src/storage/remoting/entityValidationHelpers.ts',
        'src/storage/remoting/syncChunkBinary.ts',
        'src/storage/remoting/validateRpcSyncProofs.ts',
        'src/storage/snapshot/KnexRemoteSnapshotSyncRpc.ts',
        'src/storage/snapshot/RemoteSnapshotSyncDestination.ts',
        'src/storage/snapshot/RemoteSnapshotSyncProtocol.ts',
        'src/storage/snapshot/RetainedReadSnapshot.ts',
        'src/storage/snapshot/SnapshotCancelledError.ts',
        'src/storage/snapshot/SnapshotResourceLimitError.ts',
        'src/storage/snapshot/SnapshotSync.ts',
        'src/storage/snapshot/archive/SnapshotArchiveDirectory.ts',
        'src/storage/snapshot/archive/SnapshotArchiveOwner.ts',
        'src/storage/snapshot/archive/SnapshotArchiveProtocol.ts',
        'src/storage/snapshot/archive/SnapshotArchiveReaderOffer.ts',
        'src/storage/snapshot/archive/SnapshotArchiveReaderRequest.ts',
        'src/storage/snapshot/archive/SnapshotArchiveTransport.ts',
        'src/storage/snapshot/archive/SnapshotArchiveTransportFailure.ts',
        'src/storage/snapshot/archive/openRemoteSnapshot.ts',
        'src/storage/sync/StorageAccessCancelledError.ts',
        'src/storage/sync/StorageAccessQueueLimitError.ts',
        'src/storage/sync/StorageMySQLDojoReader.ts',
        'src/storage/sync/index.ts',
        'src/utility/index.all.ts',
        'src/utility/index.client.ts'
      ],
      additionalInputs: [
        'src/storage/portable/Brc38AuthenticatedPrivateStageFixture.ts',
        'src/storage/portable/Brc38ComposedAuxiliaryFixture.ts',
        'src/storage/portable/Brc38ComposedNativeFixture.ts',
        'src/storage/portable/Brc38ComposedPriorImportFixture.ts',
        'src/storage/portable/Brc38ComposedSemanticFixture.ts',
        'src/storage/portable/Brc38ImportJournalFixture.ts',
        'src/storage/portable/Brc38ImportPageFixture.ts',
        'src/storage/portable/Brc38ImportPreviewFixture.ts',
        'src/storage/portable/Brc38IndependentNativeInventoryFixture.ts',
        'src/storage/portable/Brc38IndependentNativePortableFixture.ts',
        'src/storage/portable/Brc38JsonStreamFixture.ts',
        'src/storage/portable/Brc38NativeCandidateContractFixture.ts',
        'src/storage/portable/Brc38NativeMergeExpectedFixture.ts',
        'src/storage/portable/Brc38NativePrivateContractFixture.ts',
        'src/storage/portable/Brc38NativeStreamedContractFixture.ts',
        'src/storage/portable/Brc38ResumeFixture.ts',
        'src/storage/portable/Brc38ScalarTextFixture.ts',
        'src/storage/portable/Brc38SemanticStageFixture.ts',
        'src/storage/portable/KnexNativeContract.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/client/test/block-header-api.test.ts',
          '<rootDir>/client/test/public-contract.test.ts',
          '<rootDir>/mobile/test/block-header-api.test.ts',
          '<rootDir>/mobile/test/payment-transport.test.ts',
          '<rootDir>/mobile/test/public-contract.test.ts',
          '<rootDir>/src/services/__tests/bitrails.test.ts',
          '<rootDir>/src/services/__tests/getFiatExchangeRate.test.ts',
          '<rootDir>/src/services/__tests/getMerklePath.test.ts',
          '<rootDir>/src/services/__tests/getRawTx.test.ts',
          '<rootDir>/src/services/chaintracker/__tests/ChaintracksChainTracker.test.ts',
          '<rootDir>/src/services/chaintracker/__tests/ChaintracksServiceClient.test.ts',
          '<rootDir>/src/storage/DeviceBackupController.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexQueryBindings.security.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts',
          '<rootDir>/src/storage/__test/WalletStorageManager.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRoots.test.ts',
          '<rootDir>/src/storage/__test/findStaleMerkleRootsKnex.test.ts',
          '<rootDir>/src/storage/__test/readSettingsTrx.test.ts',
          '<rootDir>/src/storage/methods/__test/GenerateChange/generateChangeSdk.test.ts',
          '<rootDir>/src/storage/methods/repairBeefProofs.test.ts',
          '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
          '<rootDir>/src/storage/portable/Brc38AuthenticatedStreamedProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportJournal.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportMergeProvenanceNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38ImportProvenanceNode.property.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonBinaryFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonStructuredFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38JsonTextFields.test.ts',
          '<rootDir>/src/storage/portable/Brc38KnexSource.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedTextNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NativePackedWalletNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38NodeJsonIndex.test.ts',
          '<rootDir>/src/storage/portable/Brc38PackedRow.test.ts',
          '<rootDir>/src/storage/portable/Brc38SqlBinaryStaging.test.ts',
          '<rootDir>/src/storage/portable/Brc38StreamedImportPage.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredFilesystemNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredInlineProofNode.test.ts',
          '<rootDir>/src/storage/portable/Brc38StructuredJson.test.ts',
          '<rootDir>/src/storage/portable/Brc38WorkingAllocation.test.ts',
          '<rootDir>/src/storage/portable/Brc39Frame.test.ts',
          '<rootDir>/src/storage/portable/CanonicalPortableChunks.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.forwarding.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.inputBeef.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncRetry.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.syncTransfer.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/remoting/__tests__/entityValidationHelpers.test.ts',
          '<rootDir>/src/storage/remoting/edgePolicy.test.ts',
          '<rootDir>/src/storage/remoting/syncChunkBinary.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/KnexRemoteSnapshotSyncRpc.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotFieldSource.test.ts',
          '<rootDir>/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncDestination.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncHttp.test.ts',
          '<rootDir>/src/storage/snapshot/RemoteSnapshotSyncProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.integration.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSync.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncFieldRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncRows.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncScalarFields.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotLease.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotOpening.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReader.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotRows.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveAdmission.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveClientBoundary.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveDirectory.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveDirectory.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveHttpFixtureCleanup.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveProtocol.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveProtocol.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderClient.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderOffer.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReaderRequest.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveServerLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveTransport.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveTransportFailure.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalAutomaticRetention.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.property.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalDeltaPage.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalLifecycle.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.test.ts',
          '<rootDir>/src/storage/snapshot/journal/runSnapshotJournalReconciliation.test.ts',
          '<rootDir>/src/storage/sync/StorageAccessQueue.property.test.ts',
          '<rootDir>/src/storage/sync/StorageAccessQueue.test.ts',
          '<rootDir>/src/storage/sync/__tests__/StorageMySQLDojoReader.test.ts',
          '<rootDir>/src/storage/sync/commitSyncAdmission.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/sync/syncProofHttp.test.ts',
          '<rootDir>/src/storage/sync/syncSession.test.ts',
          '<rootDir>/src/storage/sync/syncTransferHttp.test.ts',
          '<rootDir>/test/wallet/action/abortAction.test.ts',
          '<rootDir>/test/wallet/action/createAction.test.ts',
          '<rootDir>/test/wallet/action/internalizeAction.test.ts',
          '<rootDir>/test/Wallet/certificate/listCertificates.test.ts',
          '<rootDir>/test/wallet/construct/Wallet.constructor.test.ts',
          '<rootDir>/test/Wallet/list/listActions.brc114.test.ts',
          '<rootDir>/test/wallet/list/listActions.test.ts',
          '<rootDir>/test/wallet/list/listActions2.test.ts',
          '<rootDir>/test/wallet/list/listCertificates.test.ts',
          '<rootDir>/test/wallet/sync/Wallet.sync.test.ts',
          '<rootDir>/test/storage/KnexMigrations.test.ts',
          '<rootDir>/test/storage/count.test.ts',
          '<rootDir>/test/storage/find.test.ts',
          '<rootDir>/test/storage/getStoreEndpointURL.test.ts',
          '<rootDir>/test/storage/idb/allocateChange.test.ts',
          '<rootDir>/test/storage/idb/count.test.ts',
          '<rootDir>/test/storage/idb/find.test.ts',
          '<rootDir>/test/storage/idb/insert.test.ts',
          '<rootDir>/test/storage/idb/reviewStatus.test.ts',
          '<rootDir>/test/storage/idb/transactionAbort.test.ts',
          '<rootDir>/test/storage/idb/update.test.ts',
          '<rootDir>/test/storage/insert.test.ts',
          '<rootDir>/test/storage/internalizeActionMarkInputsSpent.test.ts',
          '<rootDir>/test/storage/markStaleInputsAsSpent.test.ts',
          '<rootDir>/test/storage/nosendLifecycleDefense.test.ts',
          '<rootDir>/test/storage/portable.test.ts',
          '<rootDir>/test/storage/purgeData.test.ts',
          '<rootDir>/test/storage/reviewStatus.test.ts',
          '<rootDir>/test/storage/update.test.ts',
          '<rootDir>/test/storage/update2.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    }
  }
  // Extend the exact allowed universe before applying the reviewed selection.
  for (const [name, additions] of Object.entries(walletDataAdditions)) {
    if (!name.startsWith('wallet-current-')) continue
    const target = targets[name]
    target.componentTestUniverse = [
      ...new Set([
        ...(target.componentTestUniverse ??
          target.runnerOptions.jest.config.testMatch.map(file => file.replace(/^<rootDir>\//, ''))),
        ...(target.mutate.some(file => file.includes('Idb') || file.includes('Browser'))
          ? [nativeBrowserComponentTest]
          : []),
        ...(target.mutate.includes('src/utility/BrowserArgon2idWorker.ts')
          ? [nativeBrowserWorkerTest]
          : []),
        ...additions.tests.map(file => file.replace(/^<rootDir>\//, ''))
      ])
    ]
  }
  applyWalletComponentTests(
    targets,
    JSON.parse(readFileSync(resolve(repositoryRoot, walletComponentSelectionPath), 'utf8'))
  )
  // Real browser cases launch a native Node driver outside Jest's VM. Include
  // the complete controller bridge in every current target that selects them;
  // the original target definitions and all case/resource controls stay intact.
  for (const target of Object.values(targets)) {
    const cases = [
      ...(target.runnerOptions?.jest?.config?.testMatch ?? []),
      ...(target.componentTestUniverse ?? [])
    ]
    if (
      !cases.some(
        path =>
          path.endsWith('/PackedIdbCurrentStructuredRead.test.ts') ||
          path.endsWith('/BrowserArgon2idWorker.native.test.cjs') ||
          path.endsWith('/Brc38NativeBrowserComponents.test.cjs')
      )
    )
      continue
    target.additionalInputs = [
      ...new Set([
        ...(target.additionalInputs ?? []),
        'client/test/native-browser-budgets.cjs',
        'client/test/native-browser-driver.cjs',
        'client/test/native-browser-session.cjs',
        'client/test/native-browser-executable.cjs',
        'client/test/portable-program-browser.cjs',
        'client/test/portable-program-browser.ts',
        'client/test/argon2id-coverage-browser.cjs',
        'client/test/argon2id-coverage-browser.ts',
        'client/test/argon2id-coverage-worker.ts',
        'client/argon2id-worker.ts',
        'client/build-argon2id-worker.mjs',
        'src/storage/portable/*.browser.case.ts',
        'src/storage/snapshot/*.browser.case.ts',
        'src/utility/*.browser.case.ts'
      ])
    ]
  }
  return targets
}

function vitestTarget(configFile) {
  return {
    testRunner: 'vitest',
    runnerOptions: {
      vitest: {
        configFile,
        related: true
      }
    }
  }
}

function lookupProviderTarget(
  property,
  files,
  tests,
  additionalInputs = [],
  { maxTestRunnerReuse } = {}
) {
  return {
    packageDirectory: 'packages/application/output-knowledge',
    manifest: 'packages/application/output-knowledge/package.json',
    propertyTest: `packages/application/output-knowledge/test/${property}`,
    additionalInputs: [
      'src/lookup/**',
      'src/storage/SQLiteTransactionDomain.ts',
      'src/internal/BoundedOutputWork.ts',
      'test/lookup-*-fixture.ts',
      'test/fixtures/lookup-*.mjs',
      ...additionalInputs
    ],
    mutate: files.map(name => `src/lookup/${name}.ts`),
    ...jestTarget(
      'jest.config.js',
      [...tests.map(name => `<rootDir>/test/${name}.test.ts`), `<rootDir>/test/${property}`],
      { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse }
    )
  }
}

function rootEvictionTarget(repositoryRoot, property, files, { maxTestRunnerReuse } = {}) {
  return {
    packageDirectory: 'packages/application/output-knowledge',
    manifest: 'packages/application/output-knowledge/package.json',
    propertyTest: `packages/application/output-knowledge/test/${property}`,
    additionalInputs: [
      'src/internal/asyncValues.ts',
      'src/internal/pendingWork.ts',
      'src/internal/synchronousPromise.ts',
      'src/root-eviction/**',
      'src/internal/BoundedOutputWork.ts',
      'test/root-eviction-service-fixture.ts',
      'test/root-eviction-scheduler-fixture.ts',
      'test/root-eviction-local-rules-fixture.ts',
      'test/fixtures/root-local-rules-worker.mjs',
      'test/root-eviction-fixture.ts',
      'test/fixtures/root-eviction-worker.mjs',
      'test/fixtures/root-commit-lock-worker.mjs',
      'test/root-contract-fixture.ts',
      'test/root-eviction-coordination-fixture.ts',
      'test/fixtures/root-coordination-worker.mjs',
      'test/fixtures/root-maintenance-worker.mjs',
      'test/root-advertisement-fixture.ts',
      'test/evidence-fixture.ts',
      'test/fixtures/reconciliation-vectors.json',
      '../../sdk/src/**',
      'src/**',
      'test/*fixture.ts',
      'test/fixtures/**',
      '../../overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.fixture.ts',
      '../../overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts',
      '../../overlays/overlay-express/src/RootEviction*.ts',
      '../../overlays/overlay-express/src/OutputLookup*.ts',
      '../../overlays/overlay/src/**',
      '../../middleware/auth-express-middleware/src/**'
    ],
    mutate: files.map(name => `src/root-eviction/${name}.ts`),
    ...jestTarget(
      'jest.config.js',
      [
        '<rootDir>/test/root-eviction*.test.ts',
        resolve(
          repositoryRoot,
          'packages/overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts'
        )
      ],
      {
        esm: true,
        buildCommand: 'pnpm build',
        maxTestRunnerReuse,
        config: {
          roots: [
            '<rootDir>',
            resolve(repositoryRoot, 'packages/overlays/overlay-express/src/__tests__')
          ],
          moduleNameMapper: {
            [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]:
              '<rootDir>/$1.ts',
            [String.raw`^(\.{1,2}/.*)\.js$`]: '$1'
          }
        }
      }
    )
  }
}

function lineageTarget(source, property, { maxTestRunnerReuse } = {}) {
  return {
    packageDirectory: 'packages/application/output-knowledge',
    manifest: 'packages/application/output-knowledge/package.json',
    propertyTest: `packages/application/output-knowledge/test/${property}`,
    additionalInputs: [
      'src/revenue-listing/**',
      'src/SDKEvidenceVerifier.ts',
      'src/EvidenceAssembler.ts',
      'test/revenue-lineage-fixture.ts',
      'test/fixtures/revenue-listing/**'
    ],
    mutate: [`src/revenue-listing/${source}.ts`],
    ...jestTarget(
      'jest.config.js',
      [
        '<rootDir>/test/revenue-lineage.test.ts',
        '<rootDir>/test/revenue-lineage-work.test.ts',
        '<rootDir>/test/revenue-lineage-package.test.ts',
        '<rootDir>/test/revenue-lineage-graph.test.ts',
        '<rootDir>/test/revenue-lineage.property.test.ts',
        '<rootDir>/test/revenue-lineage-package.property.test.ts',
        '<rootDir>/test/revenue-lineage-graph.property.test.ts',
        '<rootDir>/test/revenue-lineage-traversal.property.test.ts'
      ],
      { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse }
    )
  }
}

function lineageGraphTargets() {
  return {
    'revenue-lineage-graph': {
      ...lineageTarget('LineageLayout', 'revenue-lineage-graph.property.test.ts', {
        maxTestRunnerReuse: 8
      }),
      mutate: ['src/revenue-listing/LineageLayout.ts', 'src/revenue-listing/LineageTransition.ts']
    },
    'revenue-lineage-traversal': lineageTarget(
      'LineageGraph',
      'revenue-lineage-traversal.property.test.ts'
    )
  }
}

function revenueSpendTargets(repositoryRoot) {
  const file = 'src/script/templates/RevenueListingSpend.ts'
  const lines = readFileSync(resolve(repositoryRoot, 'packages/sdk', file), 'utf8').split('\n')
  const signatureStart = lines.findIndex(line => line.startsWith('function preimage(')) + 1
  const apiStart = lines.findIndex(line => line.startsWith('function pushedBytes(')) + 1
  if (signatureStart < 2 || apiStart <= signatureStart)
    throw new Error('Unable to partition revenue spend responsibilities')
  const common = {
    packageDirectory: 'packages/sdk',
    manifest: 'packages/sdk/package.json',
    propertyTest: 'packages/sdk/src/script/templates/__tests/RevenueListingSpend.property.test.ts',
    ...jestTarget('jest.config.js', [
      '<rootDir>/src/script/templates/__tests/RevenueListingSpend.test.ts',
      '<rootDir>/src/script/templates/__tests/RevenueListingSpend.property.test.ts',
      '<rootDir>/src/script/templates/__tests/RevenueListingFunding.property.test.ts',
      '<rootDir>/src/script/templates/__tests/RevenueListingUnlock.property.test.ts'
    ])
  }
  // Exhaustive adjacent ranges retain every source line and the complete test
  // suite. Independent jobs keep this expensive Script campaign within CI time.
  return {
    'sdk-revenue-listing-funding': {
      ...common,
      propertyTest: common.propertyTest.replace('Spend.property', 'Funding.property'),
      mutate: [`${file}:1-${signatureStart - 1}`]
    },
    'sdk-revenue-listing-unlock': {
      ...common,
      propertyTest: common.propertyTest.replace('Spend.property', 'Unlock.property'),
      mutate: [`${file}:${signatureStart}-${apiStart - 1}`]
    },
    'sdk-revenue-listing-spend': { ...common, mutate: [`${file}:${apiStart}-${lines.length}`] }
  }
}

function walletRecoveryTarget(repositoryRoot, source, property) {
  const runner = jestTarget(
    'jest.config.cjs',
    [
      '<rootDir>/src/storage/actionRecovery/__test/*.test.ts',
      '<rootDir>/src/signer/actionRecovery/__test/*.test.ts',
      '<rootDir>/src/storage/methods/__test/createActionInputResolution.test.ts',
      '<rootDir>/src/storage/__test/createActionPerformance.test.ts',
      '<rootDir>/src/signer/methods/__tests/completeSignedTransaction*.test.ts',
      '<rootDir>/src/utility/__tests__/ScriptTemplateBRC29.test.ts'
    ],
    {
      buildCommand: 'pnpm build',
      config: {
        // Null survives Stryker's worker serialization and disables the package's
        // directory-wide sweep. The hook below removes only owned fixture files.
        globalSetup: null,
        globalTeardown: null,
        setupFilesAfterEnv: [
          '<rootDir>/src/storage/actionRecovery/__test/fixtures/mutationDatabases.cjs'
        ],
        moduleNameMapper: {
          '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
          '^(\\.{1,2}/.*)\\.js$': '$1'
        }
      }
    }
  )
  return {
    packageDirectory: 'packages/wallet/wallet-toolbox',
    manifest: 'packages/wallet/wallet-toolbox/package.json',
    propertyTest: `packages/wallet/wallet-toolbox/${property}`,
    additionalInputs: [
      'src/storage/actionRecovery/**',
      'src/signer/actionRecovery/**',
      'src/storage/methods/createAction.ts',
      'src/signer/methods/**',
      'src/utility/ScriptTemplateBRC29.ts'
    ],
    mutate: [source],
    ...runner
  }
}

function walletFundingTarget(repositoryRoot, source, property) {
  const target = walletRecoveryTarget(repositoryRoot, source, property)
  target.additionalInputs = [
    'src/storage/fundingRecovery/**',
    'src/signer/fundingRecovery/**',
    'src/storage/methods/internalizeAction.ts',
    'src/storage/methods/internalizeActionWithRecovery.ts',
    'src/signer/methods/internalizeAction.ts',
    'src/storage/methods/internalizeActionCore.ts',
    'src/signer/methods/internalizeActionCore.ts',
    'src/storage/methods/internalizeBrc197Action.ts',
    'src/storage/methods/InternalizeReceiptClaim.ts',
    'src/storage/StorageKnex.ts',
    'src/signer/methods/internalizeBrc197Action.ts',
    'src/sdk/Brc197Internalization.ts',
    'src/storage/__test/StorageIdb.internalizeConfirmed.test.ts',
    'src/storage/__test/StorageIdb.internalizeStoredProof.test.ts'
  ]
  target.runnerOptions.jest.config.testMatch = [
    '<rootDir>/src/storage/fundingRecovery/__test/*.test.ts',
    '<rootDir>/src/signer/fundingRecovery/__test/*.test.ts',
    '<rootDir>/test/wallet/action/internalizeAction.test.ts',
    '<rootDir>/test/storage/internalizeActionManagedChangePolicy.test.ts',
    '<rootDir>/test/storage/internalizeActionMarkInputsSpent.test.ts',
    '<rootDir>/test/storage/internalizeActionBasketReclassification.test.ts',
    '<rootDir>/src/storage/__test/StorageIdb.internalizeConfirmed.test.ts',
    '<rootDir>/src/storage/__test/StorageIdb.internalizeStoredProof.test.ts'
  ]
  return target
}

function appendSharedFixtureInputs(targets) {
  for (const target of Object.values(targets)) {
    if (target.packageDirectory === 'packages/overlays/overlay')
      target.additionalInputs = [
        ...(target.additionalInputs ?? []),
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests/mongo/**',
        'src/__tests/*Fixture.ts',
        'src/__tests/admission/**'
      ]
    if (
      target.packageDirectory === 'packages/application/output-knowledge' &&
      target.additionalInputs?.includes('test/private-purchase-contract.fixture.ts')
    )
      target.additionalInputs.push('test/private-purchase-signing.fixture.ts')
  }
}

function snapshotSyncMutationTargets(repositoryRoot) {
  const complete = {
    packageDirectory: 'packages/wallet/wallet-toolbox',
    manifest: 'packages/wallet/wallet-toolbox/package.json',
    propertyTest:
      'packages/wallet/wallet-toolbox/src/storage/snapshot/SnapshotSync.property.test.ts',
    mutate: [
      'src/utility/runInSeries.ts',
      'src/storage/sync/syncCheckpoint.ts',
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/sync/syncSession.ts',
        'async function committedCheckpoint(',
        '/** One page in flight;'
      ),
      'src/storage/snapshot/SnapshotSync.ts',
      'src/storage/snapshot/SnapshotSyncRows.ts',
      'src/storage/snapshot/KnexSnapshotSyncDestination.ts',
      'src/storage/snapshot/runSnapshotSyncSession.ts',
      'src/storage/schema/snapshotSyncMigration.ts',
      'src/storage/schema/entities/mergeSyncChunkEntities.ts',
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/sync/syncSession.ts',
        'if (chunk.user != null && session.activeStorage',
        "notify('preparing', { readMs })"
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/methods/validateSyncProof.ts',
        'if (!(candidate.rawTx instanceof Uint8Array',
        '  try {'
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/StorageKnex.ts',
        'this.snapshotSyncEnabled = options.snapshotSync',
        'this.preparedBeefPolicy ='
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/schema/entities/EntityProvenTxReq.ts',
        'override async mergeExisting(',
        'export interface ProvenTxReqHistorySummaryApi'
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/StorageKnex.ts',
        'override getSnapshotSync():',
        'protected override supportsNoSendExpiryPersistence()'
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/StorageKnex.ts',
        'override async destroy(): Promise<void>',
        'override async migrate('
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'private runSnapshotCopy(',
        'async syncFromReader('
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async syncFromReader(',
        '    let inserts = 0'
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async syncFromReaderResumable(',
        '    const generation ='
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async syncToWriterResumable(',
        'async syncToWriter('
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async syncToWriter(',
        '    let inserts = 0'
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async updateBackups(',
        'async setActive('
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'async setActive(',
        'getStoreEndpointURL('
      ),
      sourceLineRange(
        repositoryRoot,
        'packages/wallet/wallet-toolbox',
        'src/storage/WalletStorageManager.ts',
        'private async withAccess<R>(',
        'runAsWriter<R>('
      )
    ],
    ...jestTarget(
      'jest.config.cjs',
      [
        '<rootDir>/src/storage/snapshot/SnapshotSync*.test.ts',
        '<rootDir>/src/storage/snapshot/ConcurrentSnapshotSyncSource.test.ts',
        '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
        '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
        '<rootDir>/src/storage/schema/snapshotSyncMigration.test.ts',
        '<rootDir>/src/storage/methods/validateSyncProof.test.ts',
        '<rootDir>/src/storage/sync/syncFailure.test.ts',
        '<rootDir>/src/storage/sync/syncSession.test.ts',
        '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
        '<rootDir>/src/utility/__tests__/runInSeries.test.ts',
        '<rootDir>/src/storage/snapshot/journal/*.test.ts'
      ],
      {
        config: {
          moduleNameMapper: {
            '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
            '^(\\.{1,2}/.*)\\.js$': '$1'
          }
        }
      }
    )
  }
  const destination = new Set([
    'src/storage/snapshot/KnexSnapshotSyncDestination.ts',
    'src/storage/schema/snapshotSyncMigration.ts'
  ])
  const rows = new Set([
    'src/storage/snapshot/SnapshotSyncRows.ts',
    'src/storage/schema/entities/mergeSyncChunkEntities.ts',
    'src/storage/schema/entities/EntityProvenTxReq.ts',
    'src/storage/methods/validateSyncProof.ts'
  ])
  const groups = {
    'wallet-snapshot-sync': [],
    'wallet-snapshot-sync-destination': [],
    'wallet-snapshot-sync-rows': []
  }
  const propertyTests = {
    'wallet-snapshot-sync': complete.propertyTest,
    'wallet-snapshot-sync-destination':
      'packages/wallet/wallet-toolbox/src/storage/snapshot/SnapshotSyncDestination.property.test.ts',
    'wallet-snapshot-sync-rows':
      'packages/wallet/wallet-toolbox/src/storage/snapshot/SnapshotSyncRows.property.test.ts'
  }
  for (const range of complete.mutate) {
    const file = range.replace(/:\d+(?:-\d+)?$/, '')
    let name = 'wallet-snapshot-sync'
    if (destination.has(file)) name = 'wallet-snapshot-sync-destination'
    else if (rows.has(file)) name = 'wallet-snapshot-sync-rows'
    groups[name].push(range)
  }
  return Object.fromEntries(
    Object.entries(groups).map(([name, mutate]) => [
      name,
      {
        ...complete,
        mutate,
        propertyTest: propertyTests[name]
      }
    ])
  )
}

export function buildMutationTargets(repositoryRoot) {
  const actionStoreFile = 'src/storage/actionRecovery/SQLiteActionRecoveryStore.ts'
  const actionStoreLines = readFileSync(
    resolve(repositoryRoot, 'packages/wallet/wallet-toolbox', actionStoreFile),
    'utf8'
  ).split('\n')
  const recordsStart = actionStoreLines.findIndex(line => line.startsWith('  async metadata(')) + 1
  const transitionsStart =
    actionStoreLines.findIndex(line =>
      line.startsWith('export class SQLiteActionRecoveryOperation')
    ) + 1
  if (recordsStart < 2 || transitionsStart <= recordsStart)
    throw new Error('Unable to partition action recovery store responsibilities')
  const sessionRecordFile = 'src/lookup/SQLiteLookupSessionRecords.ts'
  const sessionRecordLines = readFileSync(
    resolve(repositoryRoot, 'packages/application/output-knowledge', sessionRecordFile),
    'utf8'
  ).split('\n')
  const payloadStart = sessionRecordLines.findIndex(line => line.startsWith('  saveOpening(')) + 1
  if (payloadStart < 2)
    throw new Error('Unable to partition lookup session record responsibilities')
  const sessionRecordTests = [
    'lookup-sqlite-sessions',
    'lookup-session',
    'lookup-process',
    'lookup-provider.property',
    'lookup-session-records.property'
  ]
  const sessionRecordTarget = lookupProviderTarget(
    'lookup-provider.property.test.ts',
    [],
    sessionRecordTests
  )
  const targets = {
    'sdk-paid-lookup-funding': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPaidLookupFunding.property.test.ts',
      additionalInputs: [
        'src/overlay-tools/OutputPaidLookupProtocol.ts',
        'src/overlay-tools/__tests/OutputPaidLookupFunding.fixture.ts'
      ],
      mutate: ['src/overlay-tools/OutputPaidLookupFunding.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding.property.test.ts'
      ])
    },
    'wallet-funding-protocol': walletFundingTarget(
      repositoryRoot,
      'src/storage/fundingRecovery/FundingRecoveryProtocol.ts',
      'src/storage/fundingRecovery/__test/FundingRecoveryProtocol.property.test.ts'
    ),
    'wallet-funding-store': walletFundingTarget(
      repositoryRoot,
      'src/storage/fundingRecovery/SQLiteFundingRecoveryStore.ts',
      'src/storage/fundingRecovery/__test/SQLiteFundingRecoveryStore.property.test.ts'
    ),
    'wallet-funding-controller': {
      ...walletFundingTarget(
        repositoryRoot,
        'src/signer/fundingRecovery/RecoverableFundingController.ts',
        'src/signer/fundingRecovery/__test/RecoverableFundingController.property.test.ts'
      ),
      mutate: [
        'src/signer/fundingRecovery/RecoverableFundingController.ts',
        // The entire shared pipelines include every site in the historical
        // method ranges, plus the new selected profile and ownership checks.
        'src/storage/methods/internalizeAction.ts',
        'src/storage/methods/internalizeActionWithRecovery.ts',
        'src/signer/methods/internalizeAction.ts',
        'src/storage/methods/internalizeActionCore.ts',
        'src/signer/methods/internalizeActionCore.ts',
        'src/storage/methods/internalizeBrc197Action.ts',
        'src/signer/methods/internalizeBrc197Action.ts',
        'src/sdk/Brc197Internalization.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          '  private async acquireInternalizeReceipt(',
          '  private databaseSystem('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/Wallet.ts',
          '  async getBrc197InternalizationCapabilities(',
          '  async abortAction('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/WalletStorageManager.ts',
          '  async getBrc197InternalizationCapabilities(',
          '  relinquishCertificate('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageProvider.ts',
          '  async internalizeBrc197Action(',
          '  async getReqsAndBeefToShareWithWorld('
        )
      ]
    },
    'wallet-recovery-codec': walletRecoveryTarget(
      repositoryRoot,
      'src/storage/actionRecovery/ActionRecoveryCodec.ts',
      'src/storage/actionRecovery/__test/ActionRecoveryDescriptors.property.test.ts'
    ),
    'wallet-recovery-encoding': {
      ...walletRecoveryTarget(
        repositoryRoot,
        'src/storage/actionRecovery/ActionRecoveryEncoding.ts',
        'src/storage/actionRecovery/__test/ActionRecoveryCodec.property.test.ts'
      ),
      mutate: [
        'src/storage/actionRecovery/ActionRecoveryEncoding.ts',
        'src/storage/actionRecovery/ActionRecoveryEncodingLimits.ts',
        'src/storage/actionRecovery/ActionRecoveryJSON.ts',
        'src/storage/actionRecovery/ActionRecoveryJSONOwnership.ts'
      ]
    },
    'wallet-recovery-installation': walletRecoveryTarget(
      repositoryRoot,
      `${actionStoreFile}:1-${recordsStart - 1}`,
      'src/storage/actionRecovery/__test/SQLiteActionRecoveryInstallation.property.test.ts'
    ),
    'wallet-recovery-store': walletRecoveryTarget(
      repositoryRoot,
      `${actionStoreFile}:${recordsStart}-${transitionsStart - 1}`,
      'src/storage/actionRecovery/__test/SQLiteActionRecoveryStore.property.test.ts'
    ),
    'wallet-recovery-transitions': walletRecoveryTarget(
      repositoryRoot,
      `${actionStoreFile}:${transitionsStart}-${actionStoreLines.length}`,
      'src/storage/actionRecovery/__test/SQLiteActionRecoveryTransitions.property.test.ts'
    ),
    'wallet-recovery-controller': {
      ...walletRecoveryTarget(
        repositoryRoot,
        'src/signer/actionRecovery/RecoverableActionController.ts',
        'src/signer/actionRecovery/__test/RecoverableActionController.property.test.ts'
      ),
      mutate: [
        'src/signer/actionRecovery/RecoverableActionController.ts',
        'src/signer/methods/completeSignedTransaction.ts'
      ]
    },
    'wallet-recovery-plan': {
      ...walletRecoveryTarget(
        repositoryRoot,
        'src/storage/actionRecovery/ActionRecoveryPlan.ts',
        'src/storage/actionRecovery/__test/ActionRecoveryPlan.property.test.ts'
      ),
      mutate: [
        'src/storage/actionRecovery/ActionRecoveryPlan.ts',
        ...[
          ['  if (recovery != null) {', '  if (!storage.telemetry.enabled)'],
          ['      const recovered = await recovery?.claim(trx)', '      const initialSatoshis ='],
          ['      let recoveryPlan: ActionRecoveryPlan', '      return { ...funded,'],
          ["    if ('recovered' in persisted", '    const committedTx ='],
          ['    await recordCreateActionFailure(', '    logger?.groupEnd()'],
          ['async function recordCreateActionFailure(', 'interface CreateTransactionSdkContext'],
          [
            "      if (trx != null) throw new WERR_INVALID_OPERATION('Recoverable",
            '      const beef = await getCompetingBeefForReview'
          ]
        ].map(([start, end]) =>
          sourceLineRange(
            repositoryRoot,
            'packages/wallet/wallet-toolbox',
            'src/storage/methods/createAction.ts',
            start,
            end
          )
        )
      ]
    },
    'revenue-listing-authority': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/revenue-authority.property.test.ts',
      additionalInputs: [
        'src/revenue-listing/**',
        'test/revenue-authority-fixture.ts',
        'test/revenue-lineage-fixture.ts',
        'test/fixtures/revenue-listing/**',
        'test/revenue-profile-authority.fixture.ts',
        'test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../sdk/src/script/templates/RevenueListingProfilePlan.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
        'src/revenue-listing/RevenueListingAuthority.ts',
        'src/revenue-listing/RevenueListingProfileAuthority.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/revenue-authority.test.ts',
          '<rootDir>/test/revenue-authority.property.test.ts',
          '<rootDir>/test/revenue-profile-authority.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'revenue-listing-profile': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/revenue-profile.property.test.ts',
      additionalInputs: [
        'src/revenue-listing/**',
        'src/SDKEvidenceVerifier.ts',
        'src/EvidenceAssembler.ts',
        'src/validation.ts',
        'src/internal/asyncValues.ts',
        'src/internal/synchronousPromise.ts',
        'test/revenue-profile*.ts',
        'test/revenue-lineage-package*.ts',
        'test/fixtures/revenue-listing/**'
      ],
      mutate: [
        'src/revenue-listing/LineagePackage.ts',
        'src/revenue-listing/ProfileLineagePackage.ts',
        'src/revenue-listing/ProfileLineageGraph.ts',
        'src/revenue-listing/RevenueListingProfileLineageVerifier.ts',
        'src/revenue-listing/RevenueListingProfilePurchaseVerifier.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/revenue-profile.test.ts',
          '<rootDir>/test/revenue-profile-work.test.ts',
          '<rootDir>/test/revenue-profile.property.test.ts',
          '<rootDir>/test/revenue-lineage-package.test.ts',
          '<rootDir>/test/revenue-lineage-package.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'revenue-listing-purchase': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/revenue-purchase.property.test.ts',
      additionalInputs: [
        'src/revenue-listing/**',
        'src/SDKEvidenceVerifier.ts',
        'src/EvidenceAssembler.ts',
        'src/validation.ts',
        'src/internal/asyncValues.ts',
        'src/internal/synchronousPromise.ts',
        'test/revenue-purchase*.ts',
        'test/revenue-lineage-fixture.ts',
        'test/revenue-authority-fixture.ts',
        'test/fixtures/revenue-listing/**'
      ],
      mutate: ['src/revenue-listing/RevenueListingPurchaseVerifier.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/revenue-purchase.test.ts',
          '<rootDir>/test/revenue-purchase.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'private-purchase-evidence': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-evidence.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/private-purchase*.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: [
        'src/private/PrivatePurchaseEvidence.ts',
        'src/private/SQLitePrivatePurchaseEvidence.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-purchase-contract.test.ts',
          '<rootDir>/test/private-purchase-contract.property.test.ts',
          '<rootDir>/test/private-purchase-progress.test.ts',
          '<rootDir>/test/private-purchase-store.test.ts',
          '<rootDir>/test/private-purchase-state.property.test.ts',
          '<rootDir>/test/private-purchase-coordinator.test.ts',
          '<rootDir>/test/private-purchase-coordination.property.test.ts',
          '<rootDir>/test/private-purchase-disclosure.test.ts',
          '<rootDir>/test/private-purchase-disclosure.property.test.ts',
          '<rootDir>/test/private-purchase-evidence.test.ts',
          '<rootDir>/test/private-purchase-evidence.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-purchase-coordination': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-coordination.property.test.ts',
      additionalInputs: [
        'src/**',
        'src/private/PrivatePurchaseEvidence.ts',
        'src/private/SQLitePrivatePurchaseEvidence.ts',
        'test/private-purchase-evidence.fixture.ts',
        'test/private-purchase*.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: ['src/private/PrivatePurchaseCoordinator.ts', 'src/private/PrivatePurchasePorts.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-purchase-coordinator.test.ts',
          '<rootDir>/test/private-purchase-coordinator-commitment.test.ts',
          '<rootDir>/test/private-purchase-coordination.property.test.ts',
          '<rootDir>/test/private-purchase-evidence.test.ts',
          '<rootDir>/test/private-purchase-evidence.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-purchase-disclosure': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-disclosure.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/private-purchase*.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: ['src/private/PrivatePurchaseAccess.ts', 'src/private/PrivatePurchaseDisclosure.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-purchase-disclosure.test.ts',
          '<rootDir>/test/private-purchase-disclosure.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-purchase-native-clock': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-native-clock.property.test.ts',
      additionalInputs: [
        'test/private-purchase-progress-commitment.test.ts',
        'test/private-purchase-store-commitment.test.ts',
        'src/private/**',
        'src/storage/**',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        'test/private-purchase-store.fixture.ts',
        'test/private-purchase-progress.fixture.ts',
        'test/private-purchase-contract.fixture.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: [
        'src/private/SQLiteProtectedLedger.ts',
        'src/private/SQLitePrivatePurchaseStore.ts',
        'src/private/PrivatePurchaseProgress.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
          '<rootDir>/test/private-purchase-progress.test.ts',
          '<rootDir>/test/private-purchase-store.test.ts',
          '<rootDir>/test/private-purchase-progress-commitment.test.ts',
          '<rootDir>/test/private-purchase-store-commitment.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-purchase-state': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-state.property.test.ts',
      additionalInputs: [
        'test/private-purchase-progress-commitment.test.ts',
        'test/private-purchase-store-commitment.test.ts',
        'src/private/**',
        'src/storage/**',
        'test/private-purchase-contract.fixture.ts',
        'test/private-purchase-progress.fixture.ts',
        'test/private-purchase-store.fixture.ts',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: [
        'src/private/PrivatePurchaseProgress.ts',
        'src/private/SQLitePrivatePurchaseStore.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-purchase-progress.test.ts',
          '<rootDir>/test/private-purchase-store.test.ts',
          '<rootDir>/test/private-purchase-progress-commitment.test.ts',
          '<rootDir>/test/private-purchase-store-commitment.test.ts',
          '<rootDir>/test/private-purchase-state.property.test.ts',
          '<rootDir>/test/protected-ledger-prepared.test.ts',
          '<rootDir>/test/private-purchase-native-clock.test.ts',
          '<rootDir>/test/private-purchase-native-clock.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-purchase-contract': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-contract.property.test.ts',
      additionalInputs: [
        '../../sdk/src/**',
        '../../sdk/package.json',
        'test/private-purchase-contract.fixture.ts'
      ],
      mutate: ['src/private/PrivatePurchaseContracts.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-purchase-contract.test.ts',
          '<rootDir>/test/private-purchase-contract.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'revenue-lineage-package': lineageTarget(
      'LineagePackage',
      'revenue-lineage-package.property.test.ts'
    ),
    ...lineageGraphTargets(),
    'revenue-lineage-verifier': lineageTarget(
      'RevenueListingLineageVerifier',
      'revenue-lineage.property.test.ts'
    ),
    'root-eviction-evidence': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/root-advertisement-evidence.property.test.ts',
      additionalInputs: [
        'src/SDKEvidenceVerifier.ts',
        'src/EvidenceAssembler.ts',
        'test/evidence-fixture.ts',
        'test/root-advertisement-fixture.ts',
        'test/fixtures/reconciliation-vectors.json'
      ],
      mutate: [
        'src/root-eviction/SDKRootEvictionEvidence.ts',
        'src/root-eviction/SDKRootAdvertisementEvidence.ts'
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/test/root-advertisement-evidence*.test.ts'], {
        esm: true,
        buildCommand: 'pnpm build'
      })
    },
    'root-eviction-contracts': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/root-contract.property.test.ts',
      additionalInputs: ['test/root-contract-fixture.ts'],
      mutate: ['src/root-eviction/RootEvictionContracts.ts'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/root-contract.test.ts', '<rootDir>/test/root-contract.property.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build'
        }
      )
    },
    'root-eviction-local-rules': {
      ...rootEvictionTarget(repositoryRoot, 'root-eviction-local-rules.property.test.ts', [
        'SQLiteRootEvictionLocalRules',
        'RootEvictionLocalRuleSchema',
        'RootEvictionLocalRules'
      ]),
      ...jestTarget('jest.config.js', ['<rootDir>/test/root-eviction-local-rules*.test.ts'], {
        esm: true,
        buildCommand: 'pnpm build'
      })
    },
    'root-eviction-scheduler': {
      ...rootEvictionTarget(repositoryRoot, 'root-eviction-scheduler.property.test.ts', [
        'RootEvictionScheduler'
      ]),
      ...jestTarget('jest.config.js', ['<rootDir>/test/root-eviction-scheduler*.test.ts'], {
        esm: true,
        buildCommand: 'pnpm build'
      })
    },
    'root-eviction-service': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-service.property.test.ts',
      ['RootEvictionService']
    ),
    'root-eviction-maintenance': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-maintenance.property.test.ts',
      ['SQLiteRootEvictionMaintenance', 'RootEvictionMaintenanceStorage']
    ),
    'root-eviction-coordination': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-coordination.property.test.ts',
      [
        'RootEvictionContractRecords',
        'RootEvictionCoordinatedStorage',
        'RootEvictionRecoveryStorage'
      ],
      { maxTestRunnerReuse: 8 }
    ),
    'root-eviction-commit': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-commit.property.test.ts',
      ['RootEvictionCommitContext']
    ),
    'root-eviction-journal': rootEvictionTarget(
      repositoryRoot,
      'root-eviction.property.test.ts',
      ['SQLiteRootEvictionStore', 'RootAdvertisementServing', 'RootLookupServingDisclosure'],
      { maxTestRunnerReuse: 8 }
    ),
    'root-eviction-records': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-records.property.test.ts',
      ['RootEvictionRequests', 'RootEvictionServingRecords'],
      { maxTestRunnerReuse: 8 }
    ),
    'root-eviction-codec': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-codec.property.test.ts',
      ['RootEvictionCodec'],
      { maxTestRunnerReuse: 8 }
    ),
    'root-eviction-storage': rootEvictionTarget(
      repositoryRoot,
      'root-eviction-storage.property.test.ts',
      ['SQLiteRootEvictionDatabase', 'RootEvictionStorage'],
      { maxTestRunnerReuse: 8 }
    ),
    'sdk-root-eviction': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputRootEvictionProtocol.property.test.ts',
      mutate: ['src/overlay-tools/OutputRootEvictionProtocol.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionProtocol.property.test.ts'
      ])
    },
    'sdk-private-publication': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPrivatePublicationProtocol.property.test.ts',
      mutate: ['src/overlay-tools/OutputPrivatePublicationProtocol.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputPrivatePublicationProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputPrivatePublicationProtocol.property.test.ts'
      ])
    },
    'sdk-paid-lookup': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPaidLookupProtocol.property.test.ts',
      mutate: ['src/overlay-tools/OutputPaidLookupProtocol.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupProtocol.property.test.ts'
      ])
    },
    'sdk-output-purchase': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPurchaseProtocol.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputPurchaseProtocol.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/overlay-tools/OutputObservation.ts',
          'export const parseOutputSTEAK =',
          'const simpleState ='
        )
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputPurchaseProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputPurchaseProtocol.property.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputProposalProtocol.test.ts'
      ])
    },
    'sdk-output-release': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/overlay-tools/__tests/OutputReleaseProtocol.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputReleaseProtocol.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/overlay-tools/OutputCapabilities.ts',
          'export function parseOutputReleasePolicy(',
          'const profile ='
        )
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputReleaseProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputReleaseProtocol.property.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputLookupProtocol.test.ts'
      ])
    },
    'sdk-output-json': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/overlay-tools/__tests/OutputProtocolJSON.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputProtocolJSON.ts',
        'src/overlay-tools/OutputProtocolSchema.ts',
        'src/overlay-tools/OutputProtocol.ts'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputProtocolJSON.property.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputProtocolSchema.test.ts'
      ])
    },
    'sdk-revenue-listing-plan': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/script/templates/__tests/RevenueListingPlan.property.test.ts',
      mutate: [
        'src/script/templates/RevenueListingPlan.ts',
        'src/script/templates/RevenueListingProfilePlan.ts'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/script/templates/__tests/RevenueListingPlan.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingPlan.property.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingProfilePlan.test.ts'
      ])
    },
    ...revenueSpendTargets(repositoryRoot),
    'sdk-revenue-listing-profile-spend': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/script/templates/__tests/RevenueListingProfileSpend.property.test.ts',
      mutate: ['src/script/templates/RevenueListingProfileSpend.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/script/templates/__tests/RevenueListingProfileSpend.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingProfileSpend.property.test.ts'
      ])
    },
    'sdk-revenue-listing': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/script/templates/__tests/RevenueListing.property.test.ts',
      mutate: [
        'src/script/templates/RevenueListing.ts',
        'src/script/templates/RevenueListingKeys.ts',
        'src/script/templates/RevenueListingProfile.ts'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/script/templates/__tests/RevenueListing.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingKeys.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingProfile.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListing.property.test.ts'
      ])
    },
    'proposal-response-disclosure': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/proposal-disclosure.property.test.ts',
      additionalInputs: [
        'src/internal/asyncValues.ts',
        'src/internal/pendingWork.ts',
        'src/internal/synchronousPromise.ts',
        'src/proposals/**',
        'test/proposal-*.ts'
      ],
      mutate: ['src/proposals/ProposalResponseDisclosure.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/test/proposal-disclosure*.test.ts'], {
        esm: true
      })
    },
    'lookup-response-disclosure': lookupProviderTarget(
      'lookup-send.property.test.ts',
      ['LookupResponseDisclosure'],
      ['lookup-native-send']
    ),
    'proposal-maintenance': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/proposal-maintenance.property.test.ts',
      additionalInputs: [
        'src/internal/asyncValues.ts',
        'src/internal/pendingWork.ts',
        'src/internal/synchronousPromise.ts',
        'src/proposals/**',
        'test/proposal-*.ts'
      ],
      mutate: ['src/proposals/ProposalMaintenance.ts', 'src/proposals/ProposalScheduler.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-maintenance*.test.ts',
          '<rootDir>/test/proposal-scheduler*.test.ts',
          '<rootDir>/test/proposal-recovery.test.ts',
          '<rootDir>/test/proposal-open.test.ts'
        ],
        { esm: true }
      )
    },
    'proposal-journal-send': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/proposal-send.property.test.ts',
      additionalInputs: [
        'src/internal/asyncValues.ts',
        'src/internal/pendingWork.ts',
        'src/internal/synchronousPromise.ts',
        'src/proposals/**',
        'src/lookup/**',
        'src/storage/SQLiteTransactionDomain.ts',
        'test/proposal-*.ts',
        'test/fixtures/proposal*.mjs'
      ],
      mutate: [
        'src/proposals/SQLiteProposalJournal.ts',
        'src/proposals/SQLiteProposalJournalStore.ts',
        'src/proposals/ProposalJournalState.ts',
        'src/storage/SQLiteTransactionDomain.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-journal*.test.ts',
          '<rootDir>/test/proposal-storage-channel.test.ts',
          '<rootDir>/test/proposal-feed-writer.test.ts',
          '<rootDir>/test/sqlite-transaction-domain.test.ts',
          '<rootDir>/test/proposal-service*.test.ts',
          '<rootDir>/test/proposal-send*.test.ts',
          '<rootDir>/test/proposal-open.test.ts',
          '<rootDir>/test/proposal-recovery.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'overlay-proposal-admission': {
      packageDirectory: 'packages/overlays/overlay',
      manifest: 'packages/overlays/overlay/package.json',
      propertyTest: 'packages/overlays/overlay/src/__tests/ProposalAdmission.property.test.ts',
      additionalInputs: [
        'src/EngineAdmission.ts',
        'src/storage/AdmissionStorage.ts',
        'src/__tests/ProposalAdmissionFixture.ts'
      ],
      mutate: ['src/ProposalAdmission.ts', 'src/RetainedTopicAdmission.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/ProposalAdmission.test.ts',
        '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
      ])
    },
    'overlay-private-purchase-admission': {
      packageDirectory: 'packages/overlays/overlay',
      manifest: 'packages/overlays/overlay/package.json',
      propertyTest: 'packages/overlays/overlay/src/__tests/PurchaseAdmission.property.test.ts',
      additionalInputs: [
        'src/**',
        'src/__tests/ProposalAdmissionFixture.ts',
        'src/__tests/PrivatePublicationAdmissionFixture.ts',
        'src/__tests/PurchaseAdmissionFixture.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: ['src/PurchaseAdmission.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/__tests/PurchaseAdmission.test.ts',
          '<rootDir>/src/__tests/PurchaseAdmission.property.test.ts',
          '<rootDir>/src/__tests/PrivatePublicationAdmission.test.ts',
          '<rootDir>/src/__tests/PrivatePublicationAdmission.property.test.ts',
          '<rootDir>/src/__tests/ProposalAdmission.test.ts',
          '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
        ],
        { maxTestRunnerReuse: 8 }
      )
    },
    'overlay-private-publication-admission': {
      packageDirectory: 'packages/overlays/overlay',
      manifest: 'packages/overlays/overlay/package.json',
      propertyTest:
        'packages/overlays/overlay/src/__tests/PrivatePublicationAdmission.property.test.ts',
      additionalInputs: [
        'src/EngineAdmission.ts',
        'src/storage/AdmissionStorage.ts',
        'src/ProposalAdmission.ts',
        'src/__tests/ProposalAdmissionFixture.ts',
        'src/__tests/PrivatePublicationAdmissionFixture.ts'
      ],
      mutate: ['src/PrivatePublicationAdmission.ts', 'src/RetainedTopicAdmission.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/__tests/PrivatePublicationAdmission.test.ts',
          '<rootDir>/src/__tests/PrivatePublicationAdmission.property.test.ts',
          '<rootDir>/src/__tests/ProposalAdmission.test.ts',
          '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
        ],
        { maxTestRunnerReuse: 8 }
      )
    },
    'overlay-root-response-guard': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/RootEvictionResponseGuard.property.test.ts',
      mutate: ['src/RootEvictionResponseGuard.ts'],
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/RootEvictionResponseGuard.fixture.ts',
        '../../application/output-knowledge/src/root-eviction/**',
        '../../application/output-knowledge/test/root-eviction-fixture.ts',
        '../../middleware/auth-express-middleware/src/**',
        '../../middleware/auth-express-middleware/mod.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        ['<rootDir>/src/__tests__/RootEvictionResponseGuard*.test.ts'],
        {
          config: {
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/test/root-eviction-fixture\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/application/output-knowledge/test/root-eviction-fixture.ts'
                ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'overlay-proposal-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/ProposalRoutes.property.test.ts',
      mutate: [
        'src/ProposalRoutes.ts',
        'src/ProposalResponseGuard.ts',
        'src/ProposalHTTPPolicy.ts',
        'src/ProposalHTTPPorts.ts'
      ],
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/ProposalRoutes.fixture.ts',
        'src/OverlayExpress.ts',
        'src/RootEvictionHTTPPolicy.ts',
        'src/OutputLookupHTTPPolicy.ts',
        '../../application/output-knowledge/src/proposals/**',
        '../../application/output-knowledge/test/proposal-*.ts',
        '../../sdk/src/**',
        '../../middleware/auth-express-middleware/src/**',
        '../../middleware/auth-express-middleware/mod.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        [
          '<rootDir>/src/__tests__/Proposal*.test.ts',
          '<rootDir>/src/__tests__/OverlayExpress.test.ts'
        ],
        {
          maxTestRunnerReuse: 8,
          config: {
            moduleNameMapper: {
              ...Object.fromEntries(
                ['proposal-disclosure-fixture', 'proposal-fixture'].map(name => [
                  String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/test/${name}\.js$`,
                  resolve(repositoryRoot, `packages/application/output-knowledge/test/${name}.ts`)
                ])
              ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'overlay-root-eviction-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/RootEvictionRoutes.property.test.ts',
      mutate: ['src/RootEvictionRoutes.ts', 'src/RootEvictionHTTPPolicy.ts'],
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/RootEvictionRoutes.fixture.ts',
        'src/RootEvictionHTTPPorts.ts',
        'src/RootEvictionResponseGuard.ts',
        'src/OutputLookupHTTPPolicy.ts',
        '../../application/output-knowledge/src/root-eviction/**',
        '../../application/output-knowledge/src/internal/**',
        '../../sdk/src/**',
        '../../application/output-knowledge/test/root-*.ts',
        '../../middleware/auth-express-middleware/src/**',
        '../../middleware/auth-express-middleware/mod.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        ['<rootDir>/src/__tests__/RootEvictionRoutes*.test.ts'],
        {
          config: {
            moduleNameMapper: {
              ...Object.fromEntries(
                [
                  'root-eviction-service-fixture',
                  'root-contract-fixture',
                  'root-eviction-fixture'
                ].map(name => [
                  String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/test/${name}\.js$`,
                  resolve(repositoryRoot, `packages/application/output-knowledge/test/${name}.ts`)
                ])
              ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'overlay-output-lookup-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/OutputLookupRoutes.property.test.ts',
      mutate: [
        'src/OutputLookupRoutes.ts',
        'src/OutputLookupHTTPPolicy.ts',
        'src/OutputLookupResponseGuard.ts'
      ],
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        '../../application/output-knowledge/src/lookup/**',
        '../../application/output-knowledge/test/lookup-provider-fixture.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        [
          '<rootDir>/src/__tests__/OutputLookupRoutes.test.ts',
          '<rootDir>/src/__tests__/OutputLookupRoutes.property.test.ts',
          '<rootDir>/src/__tests__/OutputLookupNativeSend.test.ts',
          '<rootDir>/src/__tests__/OutputLookupResponseGuard.driver.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/src/lookup/LookupResponseDisclosure\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/application/output-knowledge/src/lookup/LookupResponseDisclosure.ts'
                ),
              // The HTTP sandbox moves two levels deeper. Keep the real, unmutated
              // provider fixture at its repository path; only this adapter is mutated.
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/test/lookup-provider-fixture\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/application/output-knowledge/test/lookup-provider-fixture.ts'
                ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'output-lookup-query': lookupProviderTarget(
      'lookup-query.test.ts',
      ['LookupQueryRegistry', 'CollectionOutputQueryPolicy', 'LookupLimitError'],
      ['lookup-query', 'lookup-collection']
    ),
    'output-lookup-batches': lookupProviderTarget(
      'lookup-batch.test.ts',
      ['LookupBatchBuilder', 'LookupLiveReader', 'LookupWake'],
      ['lookup-batch', 'lookup-provider', 'lookup-provider-work']
    ),
    'output-lookup-service': {
      ...lookupProviderTarget(
        'lookup-provider-work.test.ts',
        ['LookupProviderService', 'LookupProviderContracts', 'LookupProviderWork'],
        ['lookup-provider', 'lookup-provider-feed', 'lookup-provider-work', 'lookup-session']
      ),
      mutate: [
        'src/lookup/LookupProviderService.ts',
        'src/lookup/LookupProviderContracts.ts',
        'src/lookup/LookupProviderWork.ts',
        'src/internal/BoundedOutputWork.ts'
      ]
    },
    'output-lookup-session-codec': lookupProviderTarget(
      'lookup-session.test.ts',
      ['LookupSessionCodec', 'SQLiteLookupDisclosure'],
      ['lookup-session', 'lookup-sqlite-sessions', 'lookup-provider']
    ),
    'output-lookup-index': lookupProviderTarget(
      'lookup-sqlite-index.test.ts',
      ['SQLiteLookupIndex', 'SQLiteLookupIndexStore'],
      ['lookup-sqlite-index', 'lookup-retention', 'lookup-process', 'lookup-batch']
    ),
    'output-lookup-index-records': lookupProviderTarget(
      'lookup-retention.test.ts',
      ['SQLiteLookupRecords', 'SQLiteLookupEncoding', 'SQLiteLookupBridge'],
      ['lookup-sqlite-index', 'lookup-retention', 'lookup-process']
    ),
    'output-lookup-session-records': {
      ...sessionRecordTarget,
      mutate: [
        `${sessionRecordFile}:1-${payloadStart - 1}`,
        'src/lookup/SQLiteLookupSessionSchema.ts'
      ]
    },
    'output-lookup-session-payloads': {
      ...sessionRecordTarget,
      propertyTest:
        'packages/application/output-knowledge/test/lookup-session-records.property.test.ts',
      mutate: [`${sessionRecordFile}:${payloadStart}-${sessionRecordLines.length}`]
    },
    'output-lookup-sessions': lookupProviderTarget(
      'lookup-disclosure.property.test.ts',
      ['SQLiteLookupSessions'],
      [
        'lookup-sqlite-sessions',
        'lookup-session',
        'lookup-process',
        'lookup-provider',
        'lookup-native-send',
        'lookup-send.property',
        'proposal-journal-composition',
        'proposal-storage-channel',
        'lookup-session-bootstrap'
      ],
      ['src/proposals/**', 'test/proposal-client-fixture.ts', 'test/live-lookup-fixture.ts'],
      { maxTestRunnerReuse: 8 }
    ),
    'output-lookup-codecs': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/lookup-index-codec.test.ts',
      mutate: [
        'src/lookup/LookupIndexCodec.ts',
        'src/lookup/LookupIndexKey.ts',
        'src/lookup/LookupCursorCodec.ts',
        'src/lookup/LookupServingEpoch.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/lookup-index-codec.test.ts',
          '<rootDir>/test/lookup-cursor.test.ts',
          '<rootDir>/test/lookup-serving-epoch.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'output-knowledge-live': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/lookup-state.test.ts',
      mutate: [
        'src/sources/LiveLookupConfiguration.ts',
        'src/sources/LiveLookupSource.ts',
        'src/sources/LookupSourceState.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/lookup-framing.test.ts',
          '<rootDir>/test/lookup-state.test.ts',
          '<rootDir>/test/lookup-guard.test.ts',
          '<rootDir>/test/lookup-work.test.ts',
          '<rootDir>/test/live-lookup-source.test.ts',
          '<rootDir>/test/live-lookup-indexeddb.test.ts',
          '<rootDir>/test/live-lookup-http.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'output-knowledge-live-boundaries': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/lookup-framing.test.ts',
      mutate: [
        'src/sources/LookupSourceFraming.ts',
        'src/sources/LookupSourceGuard.ts',
        'src/sources/LookupSourceWork.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/lookup-framing.test.ts',
          '<rootDir>/test/lookup-state.test.ts',
          '<rootDir>/test/lookup-guard.test.ts',
          '<rootDir>/test/lookup-work.test.ts',
          '<rootDir>/test/live-lookup-source.test.ts',
          '<rootDir>/test/live-lookup-indexeddb.test.ts',
          '<rootDir>/test/live-lookup-http.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'private-publication-state': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-publication.property.test.ts',
      additionalInputs: [
        'src/private/**',
        'src/storage/**',
        'test/private-publication-fixture.ts',
        'test/private-publication-coordinator-fixture.ts',
        'test/private-publication-service-fixture.ts',
        'test/private-verified-publication-fixture.ts',
        'test/evidence-fixture.ts',
        'test/fixtures/reconciliation-vectors.json'
      ],
      mutate: [
        'src/private/SQLitePrivatePublicationStore.ts',
        'src/private/PrivateServiceIdentity.ts',
        'src/private/PrivateServiceDomain.ts',
        'src/private/PrivatePublicationRecords.ts',
        'src/private/PrivatePublicationProgress.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-publication-service': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-verified-publication.property.test.ts',
      additionalInputs: ['src/**', 'test/*fixture.ts', 'test/fixtures/**'],
      mutate: [
        'src/private/SDKPrivatePublicationEvidence.ts',
        'src/private/PrivatePublicationContracts.ts',
        'src/private/PrivatePublicationContractRecord.ts',
        'src/private/PrivateLookupBinding.ts',
        'src/private/PrivatePublicationServiceRecords.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-publication-coordination': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-publication-coordination.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/*fixture.ts',
        'test/fixtures/**',
        '../../overlays/overlay-express/src/PrivatePublication*.ts',
        '../../overlays/overlay-express/src/__tests__/PrivatePublication*.ts',
        '../../overlays/overlay/src/**',
        '../../sdk/src/**',
        '../../middleware/auth-express-middleware/src/**'
      ],
      mutate: [
        'src/private/PrivatePublicationVerificationLeases.ts',
        'src/private/PrivatePublicationAccess.ts',
        'src/private/PrivatePublicationPorts.ts',
        'src/private/PrivatePublicationCoordinator.ts',
        'src/private/PrivatePublicationDisclosure.ts',
        'src/private/PrivatePublicationWork.ts',
        'src/private/PrivatePublicationReconciler.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
            repositoryRoot,
            'packages/overlays/overlay-express/src/__tests__/PrivatePublication*.integration.test.ts'
          )
        ],
        {
          esm: true,
          buildCommand: 'pnpm build',
          maxTestRunnerReuse: 8,
          config: {
            roots: [
              '<rootDir>',
              resolve(repositoryRoot, 'packages/overlays/overlay-express/src/__tests__')
            ],
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]:
                '<rootDir>/$1.ts',
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1'
            }
          }
        }
      )
    },
    'private-publication-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/PrivatePublicationRoutes.property.test.ts',
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/PrivatePublication*.ts',
        'src/RootEvictionHTTPPolicy.ts',
        'src/OutputLookupHTTPPolicy.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/private-*.ts',
        '../../application/output-knowledge/test/*fixture.ts',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/**',
        '../overlay/src/**',
        '../../sdk/src/**',
        '../../middleware/auth-express-middleware/src/**'
      ],
      mutate: [
        'src/PrivatePublicationHTTPPorts.ts',
        'src/PrivatePublicationHTTPPolicy.ts',
        'src/PrivatePublicationResponseGuard.ts',
        'src/PrivatePublicationRoutes.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        ['<rootDir>/src/__tests__/PrivatePublication*.test.ts'],
        {
          esm: true,
          maxTestRunnerReuse: 8,
          config: {
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]: resolve(
                repositoryRoot,
                'packages/application/output-knowledge/$1.ts'
              ),
              [String.raw`^\.\./\.\./\.\./overlay/src/__tests/mongo/MongoReplicaFixture\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'
                ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'private-purchase-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/PrivatePurchaseRoutes.property.test.ts',
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/PrivatePublication*.ts',
        'src/__tests__/PrivateAcquisition*.ts',
        'src/__tests__/PrivateOverlayHost*.ts',
        'src/__tests__/PrivatePurchase*.ts',
        'src/OverlayExpress.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/package.json',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        'src/RootEvictionHTTPPolicy.ts',
        'src/OutputLookupHTTPPolicy.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/private-*.ts',
        '../../application/output-knowledge/test/*fixture.ts',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/**',
        '../../content/lch/src/**',
        '../../content/lch/test/overlay-acquisition*.ts',
        '../../content/lch/package.json',
        '../../content/lch/tsconfig*.json',
        '../overlay/src/**',
        '../../sdk/src/**',
        '../../middleware/auth-express-middleware/src/**'
      ],
      mutate: [
        'src/PrivatePurchaseHTTPPorts.ts',
        'src/PrivatePurchaseHTTPPolicy.ts',
        'src/PrivatePurchaseResponseGuard.ts',
        'src/PrivatePurchaseRoutes.ts',
        'src/PrivateOverlayHost.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        [
          '<rootDir>/src/__tests__/PrivateAcquisition*.test.ts',
          '<rootDir>/src/__tests__/PrivateOverlayHost*.test.ts',
          '<rootDir>/src/__tests__/PrivatePurchase*.test.ts',
          '<rootDir>/src/__tests__/PrivatePublication*.test.ts'
        ],
        {
          esm: true,
          maxTestRunnerReuse: 8,
          buildCommand: mutationBuildCommand(repositoryRoot, [
            '@bsv/wallet-toolbox',
            '@bsv/output-knowledge'
          ]),
          config: {
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]: resolve(
                repositoryRoot,
                'packages/application/output-knowledge/$1.ts'
              ),
              [String.raw`^\.\./\.\./\.\./overlay/src/__tests/mongo/MongoReplicaFixture\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'
                ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'private-acquisition-http': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/PrivateAcquisitionRoutes.property.test.ts',
      additionalInputs: [
        'jest-projects.config.mjs',
        'jest.config.js',
        'src/__tests__/setup.ts',
        'src/__tests__/PrivatePublication*.ts',
        'src/__tests__/PrivateAcquisition*.ts',
        'src/__tests__/PrivateOverlayHost*.ts',
        'src/__tests__/PrivatePurchase*.ts',
        'src/OverlayExpress.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/package.json',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        'src/RootEvictionHTTPPolicy.ts',
        'src/OutputLookupHTTPPolicy.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/private-*.ts',
        '../../application/output-knowledge/test/*fixture.ts',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/**',
        '../../content/lch/src/**',
        '../../content/lch/test/overlay-acquisition*.ts',
        '../../content/lch/package.json',
        '../../content/lch/tsconfig*.json',
        '../overlay/src/**',
        '../../sdk/src/**',
        '../../middleware/auth-express-middleware/src/**'
      ],
      mutate: [
        'src/PrivateAcquisitionHTTPPorts.ts',
        'src/PrivateAcquisitionHTTPPolicy.ts',
        'src/PrivateAcquisitionResponseGuard.ts',
        'src/PrivateAcquisitionRoutes.ts',
        'src/PrivateOverlayHost.ts'
      ],
      ...overlayJestTarget(
        repositoryRoot,
        [
          '<rootDir>/src/__tests__/PrivateAcquisition*.test.ts',
          '<rootDir>/src/__tests__/PrivateOverlayHost*.test.ts',
          '<rootDir>/src/__tests__/PrivatePurchase*.test.ts',
          '<rootDir>/src/__tests__/PrivatePublication*.test.ts'
        ],
        {
          esm: true,
          maxTestRunnerReuse: 8,
          buildCommand: mutationBuildCommand(repositoryRoot, [
            '@bsv/wallet-toolbox',
            '@bsv/output-knowledge'
          ]),
          config: {
            moduleNameMapper: {
              [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]: resolve(
                repositoryRoot,
                'packages/application/output-knowledge/$1.ts'
              ),
              [String.raw`^\.\./\.\./\.\./overlay/src/__tests/mongo/MongoReplicaFixture\.js$`]:
                resolve(
                  repositoryRoot,
                  'packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'
                ),
              [String.raw`^(\.{1,2}/.*)\.js$`]: '$1',
              '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
            }
          }
        }
      )
    },
    'private-acquisition-foundation': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-acquisition.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/private-acquisition.fixture.ts',
        'test/private-publication-fixture.ts',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        'test/evidence-fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/private/PrivateAcquisitionProgress.ts',
        'src/private/PrivateAcquisitionResult.ts',
        'src/private/PrivateAcquisitionFundingIndex.ts',
        'src/private/PrivateAcquisitionContracts.ts',
        'src/private/SDKPrivateAcquisitionFunding.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-acquisition-state': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-acquisition-state.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/private-acquisition.fixture.ts',
        'test/private-acquisition-records.fixture.ts',
        'test/private-acquisition-store.fixture.ts',
        'test/private-publication-fixture.ts',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        'test/evidence-fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/private/PrivateAcquisitionPayloads.ts',
        'src/private/PrivateAcquisitionRecords.ts',
        'src/private/PrivateAcquisitionState.ts',
        'src/private/SQLitePrivateAcquisitionStore.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-acquisition-payloads.test.ts',
          '<rootDir>/test/private-acquisition-records.test.ts',
          '<rootDir>/test/private-acquisition-state.test.ts',
          '<rootDir>/test/private-acquisition-store.test.ts',
          '<rootDir>/test/private-acquisition-process.test.ts',
          '<rootDir>/test/private-acquisition-state.property.test.ts',
          '<rootDir>/test/protected-payload.test.ts',
          '<rootDir>/test/protected-payload-serialized.test.ts',
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
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'private-acquisition-coordination': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-acquisition-coordination.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/private-acquisition.fixture.ts',
        'test/private-acquisition-records.fixture.ts',
        'test/private-acquisition-store.fixture.ts',
        'test/private-acquisition-coordinator.fixture.ts',
        'test/private-acquisition-wallet.fixture.ts',
        'test/revenue-purchase.fixture.ts',
        'test/revenue-lineage-fixture.ts',
        'test/revenue-authority-fixture.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/package.json',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        '../../sdk/src/**',
        'test/private-publication-fixture.ts',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        'test/evidence-fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/private/PrivateAcquisitionAccess.ts',
        'src/private/PrivateAcquisitionPorts.ts',
        'src/private/PrivateAcquisitionWallet.ts',
        'src/private/WalletToolboxAcquisitionFunding.ts',
        'src/private/SDKPrivateReleaseEvidence.ts',
        'src/private/PrivateAcquisitionCoordinator.ts',
        'src/private/PrivateAcquisitionDisclosure.ts',
        'src/private/PrivateAcquisitionWork.ts',
        'src/private/PrivateAcquisitionReconciler.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-acquisition-access.test.ts',
          '<rootDir>/test/private-acquisition-preparation.test.ts',
          '<rootDir>/test/private-acquisition-wallet.test.ts',
          '<rootDir>/test/private-acquisition-wallet-native.test.ts',
          '<rootDir>/test/private-release-evidence.test.ts',
          '<rootDir>/test/private-acquisition-coordinator.test.ts',
          '<rootDir>/test/private-acquisition-disclosure.test.ts',
          '<rootDir>/test/private-acquisition-recovery.test.ts',
          '<rootDir>/test/private-acquisition-coordination.property.test.ts',
          '<rootDir>/test/private-acquisition-payloads.test.ts',
          '<rootDir>/test/private-acquisition-records.test.ts',
          '<rootDir>/test/private-acquisition-state.test.ts',
          '<rootDir>/test/private-acquisition-store.test.ts',
          '<rootDir>/test/private-acquisition-process.test.ts',
          '<rootDir>/test/private-acquisition-state.property.test.ts',
          '<rootDir>/test/protected-payload.test.ts',
          '<rootDir>/test/protected-payload-serialized.test.ts',
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
        ],
        {
          esm: true,
          buildCommand: mutationBuildCommand(repositoryRoot, ['@bsv/wallet-toolbox']),
          maxTestRunnerReuse: 8
        }
      )
    },
    'protected-ledger': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/protected-ledger.property.test.ts',
      additionalInputs: [
        'src/private/**',
        'src/storage/**',
        'test/protected-ledger-fixture.ts',
        'test/protected-ledger-restoration-fixture.ts',
        'test/private-purchase-store.fixture.ts',
        'test/private-purchase-progress.fixture.ts',
        'test/private-purchase-contract.fixture.ts',
        '../../sdk/src/**',
        '../../sdk/package.json'
      ],
      mutate: [
        'src/private/SQLiteProtectedLedger.ts',
        'src/private/ProtectedLedgerCodec.ts',
        'src/private/NodeProtectedPayloadCodec.ts',
        'src/private/NativeOutputBytes.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
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
          '<rootDir>/test/private-purchase-state.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'proposal-channel-storage': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/proposal-storage-channel.property.test.ts',
      additionalInputs: [
        'src/proposals/**',
        'src/lookup/**',
        'src/storage/**',
        'src/internal/**',
        'test/*fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/proposals/SQLiteProposalChannelStore.ts',
        'src/lookup/SQLiteLookupSessionBootstrap.ts',
        'src/proposals/SQLiteProposalFeedWriter.ts',
        'src/proposals/SQLiteProposalFeedInventory.ts',
        'src/proposals/ProposalChannelFeedCapacity.ts',
        'src/proposals/ProposalChannelFeedRecords.ts',
        'src/proposals/ProposalFeedPrivacy.ts',
        'src/proposals/AuthorDocumentPolicy.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-storage-channel*.test.ts',
          '<rootDir>/test/proposal-feed-*.test.ts',
          '<rootDir>/test/lookup-session-bootstrap.test.ts',
          '<rootDir>/test/proposal-policy.test.ts',
          '<rootDir>/test/proposal-transitions.test.ts',
          '<rootDir>/test/proposal-journal*.test.ts',
          '<rootDir>/test/lookup-sqlite-sessions.test.ts',
          '<rootDir>/test/lookup-native-send.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'proposal-current-query': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/proposal-channel.property.test.ts',
      additionalInputs: [
        'src/*.ts',
        'src/proposals/**',
        'src/lookup/**',
        'src/sources/**',
        'src/storage/**',
        'src/internal/**',
        'test/*fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/proposals/ProposalChannelHeadsQuery.ts',
        'src/proposals/ProposalChannelHeadsContract.ts',
        'src/proposals/ProposalChannelHeadsSource.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-channel*.test.ts',
          '<rootDir>/test/proposal-current*.test.ts',
          '<rootDir>/test/proposal-knowledge-order.test.ts',
          '<rootDir>/test/source-generation-state.test.ts',
          '<rootDir>/test/membership.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'proposal-current-projection': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/proposal-current.property.test.ts',
      additionalInputs: [
        'src/*.ts',
        'src/proposals/**',
        'src/lookup/**',
        'src/sources/**',
        'src/storage/**',
        'src/internal/**',
        'test/*fixture.ts',
        'test/fixtures/**'
      ],
      mutate: ['src/proposals/ProposalCurrentChannels.ts', 'src/SourceMembership.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-channel*.test.ts',
          '<rootDir>/test/proposal-current*.test.ts',
          '<rootDir>/test/proposal-knowledge-order.test.ts',
          '<rootDir>/test/source-generation-state.test.ts',
          '<rootDir>/test/membership.test.ts',
          '<rootDir>/test/currentness.test.ts',
          '<rootDir>/test/quarantine.test.ts',
          '<rootDir>/test/verification-ledger.test.ts',
          '<rootDir>/test/reconciliation.test.ts',
          '<rootDir>/test/reconciliation-current-conformance.test.ts',
          '<rootDir>/test/proposal-bitcoin-core.test.ts',
          '<rootDir>/test/bitcoin-knowledge.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'proposal-client-verification': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/proposal-client-verification.property.test.ts',
      additionalInputs: [
        'src/*.ts',
        'src/proposals/**',
        'src/storage/**',
        'src/internal/**',
        'test/*fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/proposals/ProposalSourcePolicy.ts',
        'src/proposals/ProposalVerificationPool.ts',
        'src/proposals/ProposalLocalFrame.ts',
        'src/proposals/ProposalPolicyRegistry.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/proposal-policy.test.ts',
          '<rootDir>/test/proposal-signature-cache.test.ts',
          '<rootDir>/test/proposal-source-policy.test.ts',
          '<rootDir>/test/proposal-verification-pool.test.ts',
          '<rootDir>/test/proposal-local-frame.test.ts',
          '<rootDir>/test/proposal-client-verification.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'output-knowledge-proposal-core': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/proposal-core.property.test.ts',
      additionalInputs: [
        'src/*.ts',
        'src/proposals/**',
        'src/storage/**',
        'src/internal/**',
        'test/*fixture.ts',
        'test/fixtures/**'
      ],
      mutate: [
        'src/BitcoinKnowledge.ts',
        'src/BitcoinKnowledgeState.ts',
        'src/KnowledgeStore.ts',
        'src/proposals/ProposalLocalState.ts',
        'src/proposals/ProposalKnowledgeView.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/bitcoin-knowledge.test.ts',
          '<rootDir>/test/knowledge-store.test.ts',
          '<rootDir>/test/local-replay-compatibility.test.ts',
          '<rootDir>/test/currentness.test.ts',
          '<rootDir>/test/runtime.test.ts',
          '<rootDir>/test/runtime-publication.property.test.ts',
          '<rootDir>/test/membership.test.ts',
          '<rootDir>/test/quarantine.test.ts',
          '<rootDir>/test/verification-ledger.test.ts',
          '<rootDir>/test/reconciliation.test.ts',
          '<rootDir>/test/reconciliation-current-conformance.test.ts',
          '<rootDir>/test/proposal-bitcoin-core.test.ts',
          '<rootDir>/test/proposal-knowledge-view.test.ts',
          '<rootDir>/test/proposal-knowledge-order.test.ts',
          '<rootDir>/test/proposal-current*.test.ts',
          '<rootDir>/test/source-generation-state.test.ts',
          '<rootDir>/test/knowledge-read-window.test.ts',
          '<rootDir>/test/proposal-core.property.test.ts',
          '<rootDir>/test/proposal-source-policy.test.ts',
          '<rootDir>/test/worker-traces.test.ts'
        ],
        // Bound Jest ESM worker reuse after repeated runner memory exhaustion.
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'output-knowledge-runtime': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/runtime-publication.property.test.ts',
      additionalInputs: [
        'src/*.ts',
        'src/proposals/**',
        'test/proposal-fixture.ts',
        'src/ports.ts',
        'src/KnowledgeStore.ts',
        'src/RuntimeEvents.ts',
        'src/validation.ts',
        'src/storage/**',
        'src/internal/**',
        'test/fixtures/reconciliation-vectors.json',
        'test/empty-reducer.ts',
        'test/evidence-fixture.ts'
      ],
      mutate: ['src/OutputKnowledge.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/runtime.test.ts',
          '<rootDir>/test/runtime-publication.property.test.ts',
          '<rootDir>/test/proposal-bitcoin-core.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'private-lookup-buyer': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-lookup-buyer.property.test.ts',
      mutate: [
        'src/private/PrivateLookupBuyer.ts',
        'src/private/PrivateLookupBuyerPorts.ts',
        'src/private/WalletToolboxBuyerPayment.ts',
        'src/private/buyer.ts'
      ],
      additionalInputs: [
        'src/operations/**',
        'src/revenue-listing/**',
        'test/private-purchase-wallet*.ts',
        'test/private-purchase*.ts',
        'test/revenue-*.ts',
        'test/fixtures/revenue-listing/**',
        '../../sdk/src/script/**',
        '../../sdk/src/transaction/**',
        '../../sdk/src/chaintrackers/**',
        'src/private/**',
        'src/internal/BoundedOutputWork.ts',
        'src/storage/SQLiteTransactionDomain.ts',
        'test/private-*buyer*.ts',
        'test/private-buyer*.ts',
        'test/private-acquisition*fixture.ts',
        'test/protected-operation-object.fixture.ts',
        'test/protected-ledger*fixture.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/test/utils/**',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        '../../wallet/wallet-toolbox/package.json',
        '../../sdk/src/primitives/**',
        '../../sdk/src/wallet/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/auth/**'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-lookup-buyer.test.ts',
          '<rootDir>/test/private-buyer-payment.test.ts',
          '<rootDir>/test/private-purchase-buyer*.test.ts',
          '<rootDir>/test/private-purchase-wallet-native*.test.ts'
        ],
        {
          esm: true,
          buildCommand: mutationBuildCommand(repositoryRoot, ['@bsv/wallet-toolbox']),
          maxTestRunnerReuse: 8
        }
      )
    },
    'private-purchase-buyer': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-buyer.property.test.ts',
      mutate: [
        'src/private/PrivatePurchaseBuyer.ts',
        'src/private/PrivatePurchaseBuyerPorts.ts',
        'src/private/purchase-buyer.ts'
      ],
      additionalInputs: [
        'src/operations/**',
        'src/revenue-listing/**',
        'test/private-purchase-wallet*.ts',
        'test/private-purchase*.ts',
        'test/revenue-*.ts',
        'test/fixtures/revenue-listing/**',
        '../../sdk/src/script/**',
        '../../sdk/src/transaction/**',
        '../../sdk/src/chaintrackers/**',
        'src/private/**',
        'src/internal/BoundedOutputWork.ts',
        'src/storage/SQLiteTransactionDomain.ts',
        'test/private-*buyer*.ts',
        'test/private-buyer*.ts',
        'test/private-acquisition*fixture.ts',
        'test/protected-operation-object.fixture.ts',
        'test/protected-ledger*fixture.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/test/utils/**',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        '../../wallet/wallet-toolbox/package.json',
        '../../sdk/src/primitives/**',
        '../../sdk/src/wallet/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/auth/**'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-lookup-buyer*.test.ts',
          '<rootDir>/test/private-buyer-payment.test.ts',
          '<rootDir>/test/private-purchase-buyer*.test.ts',
          '<rootDir>/test/private-purchase-wallet-native*.test.ts',
          '<rootDir>/test/private-purchase-wallet-routes.test.ts',
          '<rootDir>/test/private-purchase-wallet-profile-routes.test.ts'
        ],
        {
          esm: true,
          buildCommand: mutationBuildCommand(repositoryRoot, ['@bsv/wallet-toolbox']),
          maxTestRunnerReuse: 8
        }
      )
    },
    'wallet-purchase-payment': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/private-purchase-wallet-native.property.test.ts',
      mutate: [
        'src/private/WalletToolboxPurchasePayment.ts',
        'src/private/purchase-wallet.ts',
        'src/private/WalletToolboxPurchasePaymentCore.ts',
        'src/private/WalletToolboxProfilePurchasePayment.ts'
      ],
      additionalInputs: [
        'src/operations/**',
        'src/revenue-listing/**',
        'test/private-purchase-wallet*.ts',
        'test/private-purchase*.ts',
        'test/revenue-*.ts',
        'test/fixtures/revenue-listing/**',
        '../../sdk/src/script/**',
        '../../sdk/src/transaction/**',
        '../../sdk/src/chaintrackers/**',
        'src/private/**',
        'src/internal/BoundedOutputWork.ts',
        'src/storage/SQLiteTransactionDomain.ts',
        'test/private-*buyer*.ts',
        'test/private-buyer*.ts',
        'test/private-acquisition*fixture.ts',
        'test/protected-operation-object.fixture.ts',
        'test/protected-ledger*fixture.ts',
        '../../wallet/wallet-toolbox/src/**',
        '../../wallet/wallet-toolbox/test/utils/**',
        '../../wallet/wallet-toolbox/tsconfig*.json',
        '../../wallet/wallet-toolbox/package.json',
        '../../sdk/src/primitives/**',
        '../../sdk/src/wallet/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/auth/**'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/private-lookup-buyer*.test.ts',
          '<rootDir>/test/private-buyer-payment.test.ts',
          '<rootDir>/test/private-purchase-buyer*.test.ts',
          '<rootDir>/test/private-purchase-wallet-native*.test.ts',
          '<rootDir>/test/private-purchase-wallet-routes.test.ts',
          '<rootDir>/test/private-purchase-wallet-profile-routes.test.ts'
        ],
        {
          esm: true,
          buildCommand: mutationBuildCommand(repositoryRoot, ['@bsv/wallet-toolbox']),
          maxTestRunnerReuse: 8
        }
      )
    },
    'protected-operation-objects': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/protected-operation-object.property.test.ts',
      mutate: [
        'src/operations/ProtectedOperationObjectStore.ts',
        'src/operations/ProtectedOperationObjectPlan.ts',
        'src/operations/SQLiteProtectedOperationObjectStore.ts',
        'src/operations/ProtectedOperationObjectCipher.ts',
        'src/operations/IndexedDBProtectedOperationObjectStore.ts'
      ],
      additionalInputs: [
        'src/operations/**',
        'src/private/**',
        'src/storage/SQLiteTransactionDomain.ts',
        'src/internal/synchronousPromise.ts',
        'test/fixtures/protected-operation-worker.mjs',
        'test/fixtures/protected-operation-object-worker.mjs',
        'test/protected-operation-object.fixture.ts',
        'test/protected-ledger*fixture.ts',
        '../../sdk/src/primitives/**',
        '../../sdk/src/wallet/**',
        '../../sdk/src/overlay-tools/**'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/protected-operation*.test.ts',
          '<rootDir>/test/operation-state*.test.ts',
          '<rootDir>/test/protected-ledger*.test.ts',
          '<rootDir>/test/protected-payload.test.ts',
          '<rootDir>/test/protected-payload-serialized.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'protected-operation-state': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest:
        'packages/application/output-knowledge/test/protected-operation.property.test.ts',
      additionalInputs: [
        'src/operations/**',
        'src/storage/SQLiteTransactionDomain.ts',
        'src/internal/synchronousPromise.ts',
        'test/fixtures/protected-operation-worker.mjs',
        'test/fixtures/protected-operation-object-worker.mjs',
        'test/protected-operation-object.fixture.ts',
        'src/private/**',
        '../../sdk/src/primitives/**',
        '../../sdk/src/wallet/**',
        '../../sdk/src/overlay-tools/**'
      ],
      mutate: [
        'src/operations/ProtectedOperationPayload.ts',
        'src/operations/WalletProtectedOperationPayload.ts',
        'src/operations/ProtectedOperationStateStore.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/protected-operation*.test.ts', '<rootDir>/test/operation-state*.test.ts'],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    },
    'output-knowledge-journal': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/journal.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/application/output-knowledge',
          'src/storage/MemoryJournal.ts',
          '  append(',
          '  read('
        ),
        'src/operations/OperationStateStore.ts',
        'src/operations/OperationStateCodec.ts',
        'src/operations/MemoryOperationStateStore.ts',
        'src/internal/synchronousPromise.ts',
        'src/internal/pendingWork.ts',
        'src/internal/asyncValues.ts',
        ...['SQLiteOperationStateStore', 'IndexedDBOperationStateStore'].map(name =>
          sourceLineRange(
            repositoryRoot,
            'packages/application/output-knowledge',
            `src/operations/${name}.ts`,
            name === 'SQLiteOperationStateStore' ? '  compareAndSwap(' : '  async compareAndSwap(',
            '  close('
          )
        )
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/journal.property.test.ts',
          '<rootDir>/test/journal.test.ts',
          '<rootDir>/test/operation-state.test.ts',
          '<rootDir>/test/synchronous-promise.test.ts',
          '<rootDir>/test/pending-work.test.ts',
          '<rootDir>/test/async-values.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'sdk-codecs': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/primitives/__tests/utils.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/primitives/utils.ts',
          'const lz = str.match(',
          'type WriterChunk'
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/primitives/__tests/utils.property.test.ts'], {
        esm: true
      })
    },
    'sdk-brc100-json': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/wallet/__tests/BRC100ByteEncoding.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/wallet/BRC100ByteEncoding.ts',
          'export function normalizeBRC100ByteArray(',
          '/** Convert a valid BRC-100 byte array'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/wallet/BRC100ByteEncoding.ts',
          'export function brc100JsonReplacer(',
          '/** Serialize a BRC-100 payload'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/wallet/BRC100ByteEncoding.ts',
          'export function stringifyBRC100(',
          '* Repairs byte arrays only in explicitly selected own fields'
        )
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/wallet/__tests/BRC100ByteEncoding.property.test.ts',
          '<rootDir>/src/wallet/__tests/BRC100ByteEncoding.test.ts'
        ],
        { esm: true }
      )
    },
    'sdk-auth-http': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/auth/clients/__tests__/AuthFetch.property.test.ts',
      mutate: [
        [
          'src/overlay-tools/OutputLookupProtocol.ts',
          'const checkpoint =',
          'function positiveLimits('
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'const allowPayments = config.allowPayments',
          "if (typeof config.retryCounter === 'number')"
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'const peerToUse = await this.#getOrCreatePeer(baseURL)',
          '// Serialize the simplified fetch request.'
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          '// Check if server requires payment to access the requested route',
          'async #getOrCreatePeer('
        ],
        [
          'src/auth/AuthMessageValidation.ts',
          'const separatePayload =',
          'const lengthDescriptor ='
        ],
        [
          'src/auth/AuthMessageValidation.ts',
          'if (!separatePayload) bytes +=',
          'if (snapshot) retain('
        ],
        [
          'src/auth/AuthMessageValidation.ts',
          'export function assertGeneralPayloadByteLimit(',
          '/** Validate and own an untrusted BRC-103 message'
        ],
        [
          'src/auth/AuthMessageValidation.ts',
          'export function snapshotAuthMessage(',
          'return snapshot'
        ],
        [
          'src/auth/Peer.ts',
          'const maxGeneralPayloadBytes = messageValidation.maxGeneralPayloadBytes',
          'this.#wallet = wallet'
        ],
        ['src/auth/Peer.ts', 'message = copyAuthByteArray(', 'if (identityKey !== undefined)'],
        ['src/auth/Peer.ts', 'const outbound =', '} catch (error: unknown)'],
        [
          'src/auth/Peer.ts',
          'message = snapshotAuthMessage(message,',
          'this.#restoreOwnedCertificates(message)'
        ],
        [
          'src/auth/Peer.ts',
          '// Register before sending:',
          'Waits for the initial response from the peer'
        ],
        [
          'src/auth/Peer.ts',
          'private stopListeningForInitialResponsesByNonce(',
          'private propagateTransportError('
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'if (this.pendingRequestNonces.size >= MAX_PENDING_AUTH_REQUESTS)',
          'responseTimeout = setTimeout('
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'responseTimeout = setTimeout(',
          'Before sending general messages to the peer'
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'if (peerToUse.pendingCertificateRequests.length > 0)',
          '// Check if server requires payment to access the requested route'
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'private async waitForPendingCertificateRequests(',
          'private composePaymentLogDetails('
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'private isStaleSessionError(',
          'private parseAuthenticatedResponse('
        ],
        [
          'src/auth/clients/AuthFetch.ts',
          'private parseAuthenticatedResponse(',
          'Request Certificates from a Peer'
        ],
        [
          'src/auth/transports/SimplifiedFetchTransport.ts',
          'async #sendAuthMessage(message: AuthMessage): Promise<void> {',
          '#encodeRequestBody('
        ],
        [
          'src/auth/transports/SimplifiedFetchTransport.ts',
          'this.#validateResponseAuthentication(url, response, body)',
          'Registers a callback to handle incoming messages.'
        ],
        [
          'src/auth/transports/SimplifiedFetchTransport.ts',
          'async onData(callback:',
          '#createNetworkError('
        ]
      ]
        .map(([filePath, startMarker, endMarker]) =>
          sourceLineRange(repositoryRoot, 'packages/sdk', filePath, startMarker, endMarker)
        )
        .concat(
          'src/overlay-tools/OutputLookupTransport.ts',
          'src/overlay-tools/internal/OutputFiniteHTTP.ts'
        ),
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/auth/__tests/Peer.boundary.test.ts',
          '<rootDir>/src/auth/__tests/Peer.messageValidation.security.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.boundary.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.property.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.certificateWait.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.authenticationPolicy.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.paymentPolicy.test.ts',
          '<rootDir>/src/auth/transports/__tests__/SimplifiedFetchTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        ],
        { esm: true }
      )
    },
    'sdk-root-eviction-http': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputRootEvictionTransport.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputRootEvictionTransport.ts',
        'src/overlay-tools/internal/OutputFiniteHTTP.ts'
      ],
      additionalInputs: ['src/overlay-tools/**', 'src/auth/**', 'src/wallet/Wallet.interfaces.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        ],
        { esm: true }
      )
    },
    'output-proposal-http': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputProposalTransport.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputProposalTransport.ts',
        'src/overlay-tools/internal/OutputFiniteHTTP.ts'
      ],
      additionalInputs: ['src/overlay-tools/**', 'src/auth/**', 'src/wallet/Wallet.interfaces.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/overlay-tools/__tests/OutputProposalTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        ],
        { esm: true }
      )
    },
    'sdk-paid-lookup-http': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPaidLookupTransport.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputPaidLookupTransport.ts',
        'src/overlay-tools/internal/OutputFiniteHTTP.ts'
      ],
      additionalInputs: ['src/overlay-tools/**', 'src/auth/**', 'src/wallet/Wallet.interfaces.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/overlay-tools/__tests/OutputProposalTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        ],
        { esm: true, maxTestRunnerReuse: 8 }
      )
    },
    'sdk-purchase-http': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest:
        'packages/sdk/src/overlay-tools/__tests/OutputPurchaseTransport.property.test.ts',
      mutate: [
        'src/overlay-tools/OutputPurchaseTransport.ts',
        'src/overlay-tools/internal/OutputFiniteHTTP.ts'
      ],
      additionalInputs: ['src/overlay-tools/**', 'src/auth/**', 'src/wallet/Wallet.interfaces.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/overlay-tools/__tests/OutputProposalTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputRootEvictionTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupTransport*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPaidLookupFunding*.test.ts',
          '<rootDir>/src/overlay-tools/__tests/OutputPurchaseTransport*.test.ts'
        ],
        { esm: true, maxTestRunnerReuse: 8 }
      )
    },
    'wallet-action-batch': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/utility/__tests/actionBatchPack.property.test.ts',
      mutate: ['src/utility/actionBatchPack.ts:38-132'],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/utility/__tests/actionBatchPack*.test.ts',
          '<rootDir>/src/utility/__tests__/actionBatchPack*.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-read-snapshot-consistency': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      additionalInputs: [
        'test/storage/snapshotArchiveMysql.cjs',
        'test/storage/runSnapshotArchiveMysql.cjs',
        'test/storage/snapshotArchiveDocker.cjs',
        'test/storage/snapshotMysqlFixtureGroups.cjs',
        'test/utils/mysqlReadSnapshotFixture.ts'
      ],
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/portable/mysqlReadSnapshot.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          '// Only provider-owned snapshot callbacks',
          'interface KnexTelemetryQuery'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override async readSnapshot<T>',
          'override supportsRetainedReadSnapshot(): boolean'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'private async readMySQLSnapshot<T>',
          'override getSnapshotSync():'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override async findProvenTxs(',
          'override async findStaleMerkleRoots('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override async findSyncStates(',
          'override async findTransactions('
        )
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/portable/snapshot.test.ts',
          '<rootDir>/src/storage/portable/mysqlSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/StorageKnex.retainedSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/KnexWalletReadSnapshot.test.ts',
          '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
          '<rootDir>/src/storage/portable/mysqlReadSnapshot.property.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-retained-snapshot': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      additionalInputs: [
        'test/utils/snapshotRelationFixtures.ts',
        'test/utils/snapshotCertificateFixtures.ts',
        'test/utils/snapshotGlobalFixtures.ts',
        'test/utils/snapshotHistoricalMigrations.ts',
        'test/utils/snapshotSqliteFixtures.ts',
        'test/utils/snapshotSqliteIdentityFixture.ts',
        'test/utils/snapshotSqliteMaintenanceFixture.ts',
        'test/storage/snapshotHistoricalMigrations.cjs',
        'test/storage/snapshotSqliteGenerationCrash.cjs'
      ],
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/RetainedReadSnapshot.property.test.ts',
      configurationInputs: ['scripts/mutation-partitions.mjs'],
      componentTestPartitions: {
        'sqlite-bootstrap': {
          mutate: [
            'src/storage/schema/snapshotSqliteIndexBootstrap.ts',
            'src/storage/schema/snapshotSqliteIndexState.ts'
          ],
          sourceHashes: {
            'src/storage/schema/snapshotSqliteIndexBootstrap.ts':
              '89e21d1952fe89f678e6b4f22e687137c94c86def0d946ad1517c4a423ff87a6',
            'src/storage/schema/snapshotSqliteIndexState.ts':
              'db758c4ab0c000641016237cd410961adfe64a1230b8e061d938b53fe251dff8'
          },
          tests: [
            'src/storage/schema/snapshotSqliteDefinitions.test.ts',
            'src/storage/snapshot/SnapshotSqliteBootstrap.test.ts',
            'src/storage/snapshot/SnapshotSqliteGeneration.test.ts',
            'src/storage/snapshot/SnapshotSqliteGenerationCost.test.ts',
            'src/storage/snapshot/SnapshotSqliteGenerationMigration.test.ts',
            'src/storage/snapshot/SnapshotSqliteGenerationReaders.test.ts',
            'src/storage/snapshot/SnapshotSqliteGenerationRegistry.test.ts',
            'src/storage/snapshot/SnapshotSqliteGenerationRetirement.test.ts',
            'src/storage/snapshot/RetainedReadSnapshot.property.test.ts'
          ]
        }
      },
      mutate: [
        'src/storage/snapshot/RetainedReadSnapshot.ts',
        'src/storage/snapshot/KnexWalletReadSnapshot.ts',
        'src/storage/schema/snapshotSqlMigration.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/schema/KnexMigrations.ts',
          'migrations[SNAPSHOT_SQLITE_INDEX_MIGRATION] = {',
          'migrations[SYNC_TRANSFER_MIGRATION] = {'
        ),
        'src/storage/schema/snapshotProfileIndexMigration.ts',
        'src/storage/schema/snapshotRelationIndexMigration.ts',
        'src/storage/schema/snapshotCertificateIndexMigration.ts',
        'src/storage/schema/snapshotGlobalIndexMigration.ts',
        'src/storage/schema/snapshotGlobalIndexModel.ts',
        'src/storage/schema/snapshotGlobalIndexMysql.ts',
        'src/storage/schema/snapshotGlobalIndexSqlite.ts',
        'src/storage/schema/snapshotSqliteSchemaObservations.ts',
        'src/storage/schema/snapshotGlobalIndexBootstrap.ts',
        'src/storage/schema/snapshotGlobalIndexTriggers.ts',
        'src/storage/schema/snapshotSqliteIdentity.ts',
        'src/storage/schema/snapshotSqliteIdentityObservations.ts',
        'src/storage/schema/snapshotSqliteMembership.ts',
        'src/storage/schema/snapshotSqliteIndexGeneration.ts',
        'src/storage/schema/snapshotSqliteIndexBootstrap.ts',
        'src/storage/schema/snapshotSqliteIndexState.ts',
        'src/storage/schema/snapshotSqliteIndexRetirement.ts',
        'src/storage/schema/snapshotSqliteLegacyOwnership.ts',
        'src/storage/schema/snapshotSqliteIndexMigration.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override supportsRetainedReadSnapshot(): boolean',
          'private async readMySQLSnapshot<T>'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'async openSnapshotJournalSource(',
          'recoverSnapshotArchiveSources(): Promise<void>'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override async destroy(): Promise<void>',
          'override async migrate('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageKnex.ts',
          'override async dropAllData(): Promise<void>',
          'override async transaction<T>'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/storage/StorageProvider.ts',
          'supportsRetainedReadSnapshot(): boolean',
          'protected supportsActionBatchPersistence(): boolean'
        )
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/*.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteIdentityObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteSchemaObservations.test.ts',
          '<rootDir>/src/storage/schema/snapshotSqliteDefinitions.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalCapture*.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalConnections.test.ts',
          '<rootDir>/src/storage/snapshot/journal/SnapshotJournalMaintenance*.test.ts',
          '<rootDir>/src/storage/__test/StorageKnexMigrationFailure.security.test.ts'
        ],
        {
          maxTestRunnerReuse: 8,
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-snapshot-journal': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      additionalInputs: [
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
        'test/storage/snapshotArchiveDocker.cjs'
      ],
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/journal/SnapshotJournal.property.test.ts',
      mutate: [
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
        'src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.ts'
      ],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/storage/snapshot/journal/*.test.ts'], {
        maxTestRunnerReuse: 8,
        config: {
          moduleNameMapper: {
            '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
            '^(\\.{1,2}/.*)\\.js$': '$1'
          }
        }
      })
    },
    'wallet-snapshot-archive': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
      mutate: [
        'src/storage/snapshot/archive/KnexSnapshotArchiveStore.ts',
        'src/storage/snapshot/archive/SnapshotArchive.ts',
        'src/storage/snapshot/archive/SnapshotArchiveSql.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveClosure.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveSource.ts',
        'src/storage/snapshot/archive/captureKnexSnapshotArchive.ts',
        'src/storage/snapshot/archive/captureSnapshotArchiveSource.ts',
        'src/storage/schema/snapshotArchiveMigration.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.property.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveCapture.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveDirectory.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveDirectory.property.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-snapshot-remote-directory': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/archive/SnapshotArchiveDirectory.property.test.ts',
      mutate: ['src/storage/snapshot/archive/SnapshotArchiveDirectory.ts'],
      ...jestTarget(
        'jest.config.cjs',
        ['<rootDir>/src/storage/snapshot/archive/SnapshotArchiveDirectory*.test.ts'],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-snapshot-remote-service': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts',
      mutate: [
        'src/storage/snapshot/archive/SnapshotArchiveRequest.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveService.ts',
        'src/storage/snapshot/archive/SnapshotArchiveSql.ts',
        'src/storage/schema/snapshotArchiveRequestMigration.ts',
        'src/storage/snapshot/archive/SnapshotArchiveOwner.ts',
        'src/storage/schema/snapshotArchiveOwnerMigration.ts',
        'src/storage/schema/snapshotArchiveGuardMigration.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuard.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuardRegistry.ts',
        'src/storage/snapshot/archive/SnapshotArchiveGuardBackend.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveRequest.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRequestStore.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveService.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveGuard*.test.ts',
          '<rootDir>/src/storage/snapshot/ConcurrentSnapshotArchiveSource.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveService.property.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-snapshot-remote-http': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/archive/SnapshotArchiveProtocol.property.test.ts',
      mutate: [
        'src/storage/snapshot/archive/SnapshotArchiveChain.ts',
        'src/storage/schema/snapshotArchivePacketLabels.ts',
        'src/storage/snapshot/archive/SnapshotArchiveProtocol.ts',
        'src/storage/snapshot/archive/KnexSnapshotArchiveRpc.ts',
        'src/storage/snapshot/archive/SnapshotArchiveTransport.ts',
        ...[
          [
            'src/storage/remoting/StorageClientBase.ts',
            'async processSyncChunk(',
            'async getSyncChunk('
          ],
          [
            'src/storage/remoting/StorageClientBase.ts',
            'if (properties.snapshotArchive != null)',
            'return value as RemoteStorageSettings'
          ],
          [
            'src/storage/remoting/StorageClientBase.ts',
            'this.snapshotWallet = wallet',
            'this.endpointUrl ='
          ],
          [
            'src/storage/remoting/StorageClientBase.ts',
            'protected async authenticatedFetch(',
            'protected async traceRpcCall<T>('
          ],
          [
            'src/storage/remoting/StorageClientBase.ts',
            'if (settings.snapshotArchive !== undefined',
            'this.settings = settings'
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            'private readonly snapshotArchivesEnabled:',
            'private readonly app ='
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            'this.snapshotArchivesEnabled =',
            '// Keep legacy configurations working'
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            'private async handleRpcRequestCore(',
            'private async sendOversizedSyncResponse('
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            '...(await this.snapshotArchiveSettings())',
            'this.finishRpcLogging(logger, result)'
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            'private async snapshotArchiveSettings(',
            'private async dispatchSyncTransfer('
          ],
          [
            'src/storage/remoting/StorageServer.ts',
            'private createSnapshotArchiveRpc(',
            'private async traceRpcStep<T>('
          ],
          ['src/storage/remoting/StorageServer.ts', 'public start(): void', 'validateDate(date:']
        ].map(([filePath, startMarker, endMarker]) =>
          sourceLineRange(
            repositoryRoot,
            'packages/wallet/wallet-toolbox',
            filePath,
            startMarker,
            endMarker
          )
        )
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchive*.test.ts',
          '<rootDir>/src/storage/schema/snapshotArchivePacketLabels.test.ts',
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshotReaderHttp.test.ts',
          '<rootDir>/src/storage/snapshot/archive/KnexSnapshotArchiveRpc.test.ts',
          '<rootDir>/src/storage/remoting/__test/BinaryJson.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexPaymentReplayStore.test.ts',
          '<rootDir>/src/storage/remoting/__test/KnexSessionManager.test.ts',
          '<rootDir>/src/storage/remoting/__test/RateLimitPolicy.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageServerRpc.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClientBase.*.test.ts',
          '<rootDir>/src/storage/sync/syncCheckpoint.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.transport.security.test.ts',
          '<rootDir>/src/storage/remoting/__test/StorageClient.telemetry.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-snapshot-remote-reader': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/snapshot/archive/RemoteSnapshotReader.property.test.ts',
      mutate: [
        'src/storage/snapshot/archive/SnapshotArchiveReaderRequest.ts',
        'src/storage/snapshot/archive/SnapshotArchiveReaderOffer.ts',
        'src/storage/snapshot/archive/SnapshotArchiveAdmission.ts',
        'src/storage/snapshot/archive/SnapshotArchiveTransportFailure.ts',
        'src/storage/snapshot/archive/SnapshotArchiveCleanup.ts',
        'src/storage/snapshot/archive/RemoteSnapshotLease.ts',
        'src/storage/snapshot/archive/RemoteSnapshotRows.ts',
        'src/storage/snapshot/archive/RemoteSnapshotPageReader.ts',
        'src/storage/snapshot/archive/openRemoteSnapshot.ts',
        'src/storage/snapshot/SnapshotCursor.ts',
        'src/storage/snapshot/SnapshotCancelledError.ts'
      ],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/snapshot/archive/RemoteSnapshot*.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveReader*.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveAdmission.test.ts',
          '<rootDir>/src/storage/snapshot/archive/SnapshotArchiveTransportFailure.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotCursor.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'wallet-adaptive-sync-budget': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/storage/sync/SyncPageBudget.property.test.ts',
      mutate: ['src/storage/sync/SyncPageBudget.ts'],
      additionalInputs: ['src/storage/snapshot/runSnapshotSyncSession.ts'],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/storage/sync/SyncPageBudget.test.ts',
          '<rootDir>/src/storage/sync/SyncPageBudget.property.test.ts',
          '<rootDir>/src/storage/snapshot/SnapshotSyncSession.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    ...portableStreamMutationTargets(repositoryRoot),
    ...currentWalletMutationTargets(repositoryRoot),
    ...snapshotSyncMutationTargets(repositoryRoot),
    'overlay-linkage': {
      packageDirectory: 'packages/overlays/topics',
      manifest: 'packages/overlays/topics/package.json',
      propertyTest: 'packages/overlays/topics/src/mandala/__tests/types.property.test.ts',
      mutate: [
        'src/mandala/types.ts',
        'src/mandala/details.ts',
        'src/admission/issuerPolicy.ts:36-39'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/mandala/__tests/types*.test.ts',
          '<rootDir>/src/mandala/__tests/details*.test.ts'
        ],
        {
          esm: true
        }
      )
    },
    'did-codecs': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/codec.property.test.ts',
      mutate: ['src/utils/base64url.ts', 'src/utils/multibase.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/tests/codec.property.test.ts',
          '<rootDir>/tests/codec-boundaries.test.ts',
          '<rootDir>/tests/did.test.ts',
          '<rootDir>/tests/brc202.test.ts',
          '<rootDir>/tests/brc202.property.test.ts'
        ],
        { esm: true }
      )
    },
    'brc202-resolution': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/brc202.property.test.ts',
      mutate: ['src/did/BsvDid.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/tests/brc202.property.test.ts',
          '<rootDir>/tests/brc202.test.ts',
          '<rootDir>/tests/did.test.ts'
        ],
        { esm: true }
      )
    },
    'brc52-envelope': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/brc52-envelope.property.test.ts',
      mutate: ['src/brc52/envelope.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/tests/brc52-envelope.property.test.ts',
          '<rootDir>/tests/brc52-envelope.test.ts',
          '<rootDir>/tests/brc52-envelope-boundaries.test.ts',
          '<rootDir>/tests/brc52-status.test.ts',
          '<rootDir>/tests/brc52-disclosure.test.ts',
          '<rootDir>/tests/brc52-auth-interoperability.test.ts'
        ],
        { esm: true }
      )
    },
    'brc52-status': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/brc52-status.property.test.ts',
      mutate: ['src/brc52/status.ts'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/tests/brc52-status.property.test.ts', '<rootDir>/tests/brc52-status.test.ts'],
        { esm: true }
      )
    },
    'brc52-disclosure': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/brc52-disclosure.property.test.ts',
      mutate: ['src/brc52/disclosure.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/tests/brc52-disclosure.property.test.ts',
          '<rootDir>/tests/brc52-disclosure.test.ts',
          '<rootDir>/tests/brc52-auth-interoperability.test.ts'
        ],
        { esm: true }
      )
    },
    'mandala-encoding': {
      packageDirectory: 'packages/helpers/ts-templates',
      manifest: 'packages/helpers/ts-templates/package.json',
      propertyTest: 'packages/helpers/ts-templates/src/__tests/mandala-encoding.property.test.ts',
      mutate: ['src/mandala-encoding.ts', 'src/strictCbor.ts', 'src/Bsv21Binary.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/mandala-encoding*.test.ts',
        '<rootDir>/src/__tests/strictCbor*.test.ts',
        '<rootDir>/src/__tests/Bsv21Binary*.test.ts'
      ])
    },
    'paymail-address': {
      packageDirectory: 'packages/messaging/ts-paymail',
      manifest: 'packages/messaging/ts-paymail/package.json',
      propertyTest: 'packages/messaging/ts-paymail/src/__tests/paymailAddress.property.test.ts',
      mutate: ['src/paymailAddress.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/paymailAddress*.test.ts'], {
        esm: true
      })
    },
    'p2p-messages': {
      packageDirectory: 'packages/network/ts-p2p',
      manifest: 'packages/network/ts-p2p/package.json',
      propertyTest: 'packages/network/ts-p2p/test/messages.property.test.ts',
      mutate: ['src/messages.ts:139-231'],
      ...jestTarget('jest.config.js', ['<rootDir>/test/messages*.test.ts'], { esm: true })
    },
    auth: {
      packageDirectory: 'packages/middleware/auth',
      manifest: 'packages/middleware/auth/package.json',
      propertyTest: 'packages/middleware/auth/src/__tests__/core.property.test.ts',
      mutate: ['src/core.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests__/authProof.test.ts',
        '<rootDir>/src/__tests__/core.property.test.ts'
      ])
    },
    'reorg-stream': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      additionalInputs: ['jest-projects.config.mjs', 'jest.config.js', 'src/__tests__/setup.ts'],
      propertyTest: 'packages/overlays/overlay-express/src/__tests/ReorgStream.property.test.ts',
      mutate: ['src/ReorgStream.ts'],
      ...overlayJestTarget(
        repositoryRoot,
        [
          '<rootDir>/src/__tests/ReorgStream*.test.ts',
          '<rootDir>/src/__tests__/ReorgStream*.test.ts'
        ],
        {
          esm: true
        }
      )
    },
    'message-box-host': {
      packageDirectory: 'packages/messaging/message-box-client',
      manifest: 'packages/messaging/message-box-client/package.json',
      propertyTest: 'packages/messaging/message-box-client/src/__tests/host.property.test.ts',
      mutate: ['src/host.ts'],
      ...jestTarget('jest.config.ts', ['<rootDir>/src/__tests/host*.test.ts'], { esm: true })
    },
    'authsocket-server-boundary': {
      packageDirectory: 'packages/messaging/authsocket',
      manifest: 'packages/messaging/authsocket/package.json',
      propertyTest: 'packages/messaging/authsocket/src/__tests__/eventPayload.property.test.ts',
      mutate: [
        'src/SocketServerTransport.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/messaging/authsocket',
          'src/AuthSocketServer.ts',
          'export function decodeAuthSocketEventPayload(',
          'export interface AuthSocketServerOptions'
        )
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests__/eventPayload.property.test.ts',
        '<rootDir>/src/__tests__/SocketServerTransport.test.ts',
        '<rootDir>/test/SocketServerTransport.integration.test.ts'
      ])
    },
    'authsocket-client-boundary': {
      packageDirectory: 'packages/messaging/authsocket-client',
      manifest: 'packages/messaging/authsocket-client/package.json',
      propertyTest:
        'packages/messaging/authsocket-client/src/__tests__/eventPayload.property.test.ts',
      mutate: [
        'src/SocketClientTransport.ts',
        sourceLineRange(
          repositoryRoot,
          'packages/messaging/authsocket-client',
          'src/AuthSocketClient.ts',
          'export function decodeAuthSocketEventPayload(',
          'export interface AuthSocketClientOptions'
        )
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests__/eventPayload.property.test.ts',
        '<rootDir>/src/__tests__/SocketClientTransport.test.ts'
      ])
    },
    'wallet-pairing': {
      packageDirectory: 'packages/wallet/ts-wallet-relay',
      manifest: 'packages/wallet/ts-wallet-relay/package.json',
      propertyTest: 'packages/wallet/ts-wallet-relay/tests/pairingUri.property.test.ts',
      mutate: ['src/shared/pairingUri.ts'],
      ...jestTarget('jest.mutation.config.cjs', undefined)
    },
    'overlay-advertisement': {
      packageDirectory: 'packages/overlays/overlay-discovery-services',
      manifest: 'packages/overlays/overlay-discovery-services/package.json',
      propertyTest:
        'packages/overlays/overlay-discovery-services/src/utils/__tests/isAdvertisableURI.property.test.ts',
      mutate: ['src/utils/isAdvertisableURI.ts', 'src/utils/isValidTopicOrServiceName.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/utils/__tests/isAdvertisableURI*.test.ts',
          '<rootDir>/src/utils/__tests/isValidTopicOrServiceName*.test.ts'
        ],
        { esm: true }
      )
    },
    'overlay-integrity': {
      packageDirectory: 'packages/overlays/overlay',
      manifest: 'packages/overlays/overlay/package.json',
      propertyTest: 'packages/overlays/overlay/src/__tests/BASM.property.test.ts',
      mutate: [
        'src/BASM.ts:154-190',
        'src/SafeLog.ts',
        'src/storage/mongo/MongoAdmissionReceipt.ts'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/BASM.test.ts',
        '<rootDir>/src/__tests/BASM.property.test.ts',
        '<rootDir>/src/__tests/SafeLog.test.ts',
        '<rootDir>/src/__tests/mongo/MongoAdmissionReceipt.test.ts'
      ])
    },
    'verifast-batch': {
      packageDirectory: 'packages/verifast',
      manifest: 'packages/verifast/package.json',
      propertyTest: 'packages/verifast/src/__tests/BdkBatch.property.test.ts',
      mutate: ['src/BdkBatch.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/BdkBatch*.test.ts'], {
        esm: true,
        config: {
          moduleNameMapper: {
            '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
            '^(\\.{1,2}/.*)\\.js$': '$1'
          }
        }
      })
    },
    'btms-helpers': {
      packageDirectory: 'packages/wallet/btms',
      manifest: 'packages/wallet/btms/package.json',
      propertyTest: 'packages/wallet/btms/src/__tests/BTMSHelpers.property.test.ts',
      mutate: [
        'src/BTMSHelpers.ts:24-27',
        'src/BTMSHelpers.ts:195-203',
        'src/BTMSHelpers.ts:238-256',
        'src/utils.ts:28-67'
      ],
      ...jestTarget(
        'jest.config.cjs',
        ['<rootDir>/src/__tests/BTMSHelpers*.test.ts', '<rootDir>/src/__tests/utils*.test.ts'],
        { esm: true }
      )
    },
    'air-gap-codec': {
      packageDirectory: 'packages/helpers/air-gap',
      manifest: 'packages/helpers/air-gap/package.json',
      propertyTest: 'packages/helpers/air-gap/tests/airGapCodec.property.test.ts',
      mutate: ['src/decoder.ts', 'src/encoder.ts', 'src/coding.ts', 'src/base64url.ts'],
      // No testMatch override: the whole suite is fast and every file bears on
      // the wire boundary, so every file gets to kill mutants.
      ...jestTarget('jest.config.cjs')
    },
    'amount-format': {
      packageDirectory: 'packages/helpers/amountinator',
      manifest: 'packages/helpers/amountinator/package.json',
      propertyTest: 'packages/helpers/amountinator/tests/amountFormat.property.test.ts',
      mutate: ['src/utils/amountFormatHelpers.ts', 'src/utils/currencyConverter.ts:208-260'],
      ...jestTarget('jest.config.cjs', [
        '<rootDir>/tests/amountFormat.property.test.ts',
        '<rootDir>/tests/formatAmountWithCurrency.test.ts'
      ])
    },
    'fund-wallet-cli': {
      packageDirectory: 'packages/helpers/fund-wallet',
      manifest: 'packages/helpers/fund-wallet/package.json',
      propertyTest: 'packages/helpers/fund-wallet/src/cli.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/helpers/fund-wallet',
          'src/cli.ts',
          'function argumentValue(',
          'function printHelp('
        )
      ],
      ...vitestTarget('vitest.config.ts')
    },
    'payment-402': {
      packageDirectory: 'packages/middleware/402-pay',
      manifest: 'packages/middleware/402-pay/package.json',
      propertyTest: 'packages/middleware/402-pay/src/server.property.test.ts',
      mutate: ['src/server.ts'],
      ...vitestTarget('vitest.config.ts')
    },
    'auth-express-queue': {
      packageDirectory: 'packages/middleware/auth-express-middleware',
      manifest: 'packages/middleware/auth-express-middleware/package.json',
      propertyTest:
        'packages/middleware/auth-express-middleware/src/__tests/authenticatedResponseQueue.property.test.ts',
      mutate: [
        'src/authenticatedResponseQueue.ts',
        ...[
          ['  private async sendGeneralMessage(', '  private readResponseHeaders('],
          ['  private setupAuthenticatedResponse(', '  private captureNativeResponseState(']
        ].map(([start, end]) =>
          sourceLineRange(
            repositoryRoot,
            'packages/middleware/auth-express-middleware',
            'src/index.ts',
            start,
            end
          )
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/**/*.test.ts'])
    },
    'auth-express-bytes': {
      packageDirectory: 'packages/middleware/auth-express-middleware',
      manifest: 'packages/middleware/auth-express-middleware/package.json',
      propertyTest:
        'packages/middleware/auth-express-middleware/src/__tests/authMiddlewareHelpers.property.test.ts',
      mutate: [
        'src/authMiddlewareHelpers.ts:96-103',
        'src/authMiddlewareHelpers.ts:154-163',
        'src/authMiddlewareHelpers.ts:180-184',
        'src/authMiddlewareHelpers.ts:206-233',
        'src/authMiddlewareHelpers.ts:99-114',
        'src/authMiddlewareHelpers.ts:155-164',
        'src/authMiddlewareHelpers.ts:181-185',
        'src/authMiddlewareHelpers.ts:198-238'
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/authMiddlewareHelpers*.test.ts'])
    },
    'payment-replay': {
      packageDirectory: 'packages/middleware/payment-express-middleware',
      manifest: 'packages/middleware/payment-express-middleware/package.json',
      propertyTest:
        'packages/middleware/payment-express-middleware/src/__tests/PaymentReplayStore.property.test.ts',
      mutate: ['src/index.ts:27-44', 'src/index.ts:30-47'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/PaymentReplayStore*.test.ts'])
    },
    'wallet-script-encoding': {
      packageDirectory: 'packages/helpers/bsv-wallet-helper',
      manifest: 'packages/helpers/bsv-wallet-helper/package.json',
      propertyTest:
        'packages/helpers/bsv-wallet-helper/src/utils/__tests__/scriptEncoding.property.test.ts',
      mutate: [
        'src/utils/opreturn.ts:51-111',
        'src/utils/scriptValidation.ts:102-145',
        'src/utils/scriptValidation.ts:705-749'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/utils/__tests__/scriptEncoding*.test.ts',
        '<rootDir>/src/utils/__tests__/opreturn*.test.ts',
        '<rootDir>/src/utils/__tests__/scriptValidation*.test.ts'
      ])
    },
    'create-app-config': {
      packageDirectory: 'packages/helpers/create-bsv-app',
      manifest: 'packages/helpers/create-bsv-app/package.json',
      propertyTest:
        'packages/helpers/create-bsv-app/src/config/__tests__/validate.property.test.ts',
      mutate: ['src/config/validate.ts'],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/config/__tests__/validate*.test.ts'])
    },
    'gasp-inputs': {
      packageDirectory: 'packages/overlays/gasp-core',
      manifest: 'packages/overlays/gasp-core/package.json',
      propertyTest: 'packages/overlays/gasp-core/src/__tests/GASP.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/overlays/gasp-core',
          'src/GASP.ts',
          'private validateTimestamp(',
          'private compute36ByteStructure('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/overlays/gasp-core',
          'src/GASP.ts',
          'async buildInitialRequest(',
          'async requestNode('
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/GASP*.test.ts'])
    },
    'btms-topic': {
      packageDirectory: 'packages/overlays/btms-backend',
      manifest: 'packages/overlays/btms-backend/package.json',
      propertyTest:
        'packages/overlays/btms-backend/src/topic-managers/__tests/BTMSTopicManager.property.test.ts',
      mutate: ['src/topic-managers/BTMSTopicManager.ts:70-88'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/src/topic-managers/__tests/BTMSTopicManager*.test.ts'],
        { esm: true }
      )
    },
    'btms-permission': {
      packageDirectory: 'packages/wallet/btms-permission-module',
      manifest: 'packages/wallet/btms-permission-module/package.json',
      propertyTest:
        'packages/wallet/btms-permission-module/src/__tests__/BasicTokenModule.property.test.ts',
      mutate: [
        'src/BasicTokenModule.ts:141-172',
        'src/BasicTokenModule.ts:778-818',
        'src/BasicTokenModule.ts:1082-1138'
      ],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/__tests__/BasicTokenModule*.test.ts'], {
        esm: true
      })
    },
    'color-permission': {
      packageDirectory: 'packages/wallet/color-permission-module',
      manifest: 'packages/wallet/color-permission-module/package.json',
      propertyTest:
        'packages/wallet/color-permission-module/src/__tests__/ColorPlan.property.test.ts',
      mutate: [
        'src/ColorPlan.ts',
        'src/strictJson.ts',
        'src/identifiers.ts',
        'src/tokenOutputs.ts',
        'src/overlay.ts'
      ],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/__tests__/*.test.ts'], { esm: true })
    },
    'ecpm-permission': {
      packageDirectory: 'packages/wallet/ecpm-permission-module',
      manifest: 'packages/wallet/ecpm-permission-module/package.json',
      propertyTest:
        'packages/wallet/ecpm-permission-module/src/__tests__/EcpmPermissionModule.property.test.ts',
      // Keep the defensive infinity checks in production, but omit them from mutation:
      // canonical compressed points and nonzero PrivateKey scalars cannot reach either branch.
      mutate: [
        'src/EcpmPermissionModule.ts:37-203',
        'src/EcpmPermissionModule.ts:207-289',
        'src/EcpmPermissionModule.ts:293-298'
      ],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/__tests__/EcpmPermissionModule*.test.ts'], {
        esm: true
      })
    },
    'chirp-codec': {
      packageDirectory: 'packages/network/chirp',
      manifest: 'packages/network/chirp/package.json',
      propertyTest: 'packages/network/chirp/test/codec.property.test.ts',
      mutate: ['src/compactSize.ts'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/codec.property.test.ts', '<rootDir>/test/primitives.test.ts'],
        { esm: true }
      )
    },
    'lch-overlay-acquisition': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest: 'packages/content/lch/test/overlay-acquisition-codec.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
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
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-overlay-covenant-terms': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest: 'packages/content/lch/test/overlay-acquisition-covenant-terms.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
        'src/overlayAcquisitionCovenantTerms.ts',
        'src/overlayAcquisitionCovenantTermsCore.ts',
        'src/overlayAcquisitionCovenantProfileTerms.ts',
        'src/overlayAcquisitionConsent.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-overlay-covenant-settlement': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest:
        'packages/content/lch/test/overlay-acquisition-covenant-settlement.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
        'src/overlayAcquisitionCovenantSettlement.ts',
        'src/overlayAcquisitionCovenantSettlementCore.ts',
        'src/overlayAcquisitionCovenantProfileSettlement.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-overlay-license': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest: 'packages/content/lch/test/overlay-acquisition-license.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: ['src/overlayAcquisitionLicense.ts'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-overlay-covenant-seller': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest:
        'packages/content/lch/test/overlay-acquisition-covenant-seller.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
        'src/overlayAcquisitionCovenantSeller.ts',
        'src/overlayAcquisitionCovenantSellerCore.ts',
        'src/overlayAcquisitionCovenantProfileSeller.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-overlay-covenant': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest: 'packages/content/lch/test/overlay-acquisition-covenant.property.test.ts',
      additionalInputs: [
        'src/**',
        'test/overlay-acquisition*.ts',
        'test/key-delivery.test.ts',
        '../../application/output-knowledge/src/**',
        '../../application/output-knowledge/test/evidence-fixture.ts',
        '../../application/output-knowledge/test/fixtures/evidence/**',
        '../../application/output-knowledge/test/revenue-lineage-fixture.ts',
        '../../application/output-knowledge/test/fixtures/revenue-listing/**',
        '../../sdk/src/overlay-tools/**',
        '../../sdk/src/script/templates/RevenueListingProfile.ts',
        '../../sdk/src/script/templates/RevenueListingKeys.ts',
        '../../application/output-knowledge/test/revenue-profile.fixture.ts',
        '../../sdk/src/script/templates/RevenueListingProfileSpend.ts'
      ],
      mutate: [
        'src/overlayAcquisitionCovenant.ts',
        'src/overlayAcquisitionCovenantCore.ts',
        'src/overlayAcquisitionCovenantProfile.ts',
        'src/overlayAcquisitionCovenantProof.ts',
        'src/overlayAcquisitionCovenantEntitlement.ts',
        'src/overlayAcquisitionEntitlement.ts',
        'src/keyRecovery.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/overlay-acquisition*.test.ts', '<rootDir>/test/key-delivery.test.ts'],
        {
          esm: true,
          buildCommand: 'pnpm build:mutation'
        }
      )
    },
    'lch-cbor': {
      packageDirectory: 'packages/content/lch',
      manifest: 'packages/content/lch/package.json',
      propertyTest: 'packages/content/lch/test/cbor.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/content/lch',
          'src/cbor.ts',
          'function compareBytes(',
          'function encode('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/content/lch',
          'src/cbor.ts',
          '  const entries = Object.entries(value)',
          'export function encodeDeterministicCbor('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/content/lch',
          'src/cbor.ts',
          '  private decodeMap(',
          '  done(): boolean'
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/content/lch',
          'src/cbor.ts',
          '  private readLength(',
          '  private read('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/content/lch',
          'src/cbor.ts',
          'export function decodeDeterministicCbor(',
          '}'
        )
      ],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/test/cbor.property.test.ts', '<rootDir>/test/cbor.test.ts'],
        { esm: true }
      )
    },
    'eqc-protocol': {
      packageDirectory: 'packages/overlays/eqc',
      manifest: 'packages/overlays/eqc/package.json',
      propertyTest: 'packages/overlays/eqc/src/protocol/protocol.property.test.ts',
      mutate: ['src/protocol/weights.ts', 'src/protocol/canonicalJson.ts'],
      ...vitestTarget('vitest.config.ts')
    },
    'webrtpay-codes': {
      packageDirectory: 'packages/messaging/webrtpay',
      manifest: 'packages/messaging/webrtpay/package.json',
      propertyTest: 'packages/messaging/webrtpay/test/codec.property.test.ts',
      mutate: ['src/codec/codes.ts', 'src/codec/sdp.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/test/codec*.test.ts'], { esm: true })
    },
    'webrtpay-frames': {
      packageDirectory: 'packages/messaging/webrtpay',
      manifest: 'packages/messaging/webrtpay/package.json',
      propertyTest: 'packages/messaging/webrtpay/test/frames.property.test.ts',
      // All of frames.ts but parseMessage's object check after JSON.parse, which cannot
      // fail: assertBoundedObject has already required the text to open with `{`, so its
      // mutants are only no-coverage or equivalent. The two block mutants that span a range
      // end (the bodies of parseMessage and of append, the file's last method) drop out too.
      // The helper needs an end marker, so the second range stops at append's last statement:
      // code added after it, or a method added after append, is outside this target until the
      // marker moves.
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/messaging/webrtpay',
          'src/channel/frames.ts',
          'export const FRAME_HEADER_BYTES',
          "if (typeof value !== 'object'"
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/messaging/webrtpay',
          'src/channel/frames.ts',
          '  return value',
          'this.length = needed'
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/test/frames*.test.ts'], { esm: true })
    },
    'group-messaging-envelope': {
      packageDirectory: 'packages/messaging/group-messaging',
      manifest: 'packages/messaging/group-messaging/package.json',
      propertyTest:
        'packages/messaging/group-messaging/src/bootstrap/__tests__/envelope.property.test.ts',
      mutate: ['src/bootstrap/envelope.ts'],
      ...vitestTarget('vitest.config.ts')
    }
  }
  const aliasTests = [
    '<rootDir>/test/private-purchase-alias-state.test.ts',
    '<rootDir>/test/private-purchase-alias-selection.test.ts',
    '<rootDir>/test/sqlite-private-purchase-aliases.test.ts',
    '<rootDir>/test/sqlite-private-purchase-aliases.property.test.ts'
  ]
  const aliasRegression = targets['private-purchase-state']
  for (const [id, property, mutate] of [
    [
      'private-purchase-alias-state',
      'private-purchase-alias-state.test.ts',
      ['src/private/PrivatePurchaseAliasState.ts', 'src/private/PrivatePurchaseAliasSelection.ts']
    ],
    [
      'private-purchase-alias-custody',
      'sqlite-private-purchase-aliases.property.test.ts',
      [
        'src/private/SQLitePrivatePurchaseAliases.ts',
        'src/private/SQLitePrivatePurchaseAdmissionJournal.ts'
      ]
    ]
  ]) {
    targets[id] = {
      ...structuredClone(aliasRegression),
      propertyTest: `packages/application/output-knowledge/test/${property}`,
      additionalInputs: [
        ...aliasRegression.additionalInputs,
        'test/private-purchase*.ts',
        'test/sqlite-private-purchase-aliases*.ts'
      ],
      mutate,
      ...jestTarget(
        'jest.config.js',
        [...aliasRegression.runnerOptions.jest.config.testMatch, ...aliasTests],
        { esm: true, buildCommand: 'pnpm build', maxTestRunnerReuse: 8 }
      )
    }
  }
  const lookupTests = [
    '<rootDir>/test/private-publication-lookup.test.ts',
    '<rootDir>/test/private-publication-lookup.property.test.ts'
  ]
  const publication = targets['private-publication-coordination']
  const lookupInputs = [
    ...publication.additionalInputs,
    'src/private/PrivatePublicationLookupContext.ts',
    'test/private-publication-lookup.fixture.ts'
  ]
  for (const id of [
    'private-publication-state',
    'private-publication-service',
    'private-publication-coordination',
    'protected-ledger',
    'private-purchase-native-clock'
  ]) {
    const target = targets[id]
    target.additionalInputs.push(...lookupInputs)
    target.runnerOptions.jest.config.testMatch.push(...lookupTests)
  }
  targets['private-publication-lookup'] = {
    ...structuredClone(publication),
    propertyTest:
      'packages/application/output-knowledge/test/private-publication-lookup.property.test.ts',
    mutate: ['src/private/PrivatePublicationLookupContext.ts']
  }
  appendSharedFixtureInputs(targets)
  const retainedTests = [
    '<rootDir>/src/__tests/RetainedTransactionBEEF.test.ts',
    '<rootDir>/src/__tests/RetainedTransactionBEEF.property.test.ts',
    '<rootDir>/src/__tests/EngineAdmission*.test.ts',
    '<rootDir>/src/__tests/OverlayGASPStorage.test.ts',
    '<rootDir>/src/__tests/mongo/*.test.ts',
    resolve(
      repositoryRoot,
      'packages/overlays/overlay-express/src/__tests__/PrivateOverlayHostRootServing.integration.test.ts'
    )
  ]
  const retainedInputs = [
    'src/**',
    'jest-projects.config.mjs',
    'jest.config.js',
    '../../sdk/src/**',
    '../../application/output-knowledge/src/**',
    '../../application/output-knowledge/test/*fixture.ts',
    '../../application/output-knowledge/test/fixtures/**',
    '../overlay-express/src/__tests__/PrivateOverlayHostRootServing*.ts',
    '../overlay-express/src/RootEviction*.ts',
    '../overlay-express/src/OutputLookup*.ts',
    '../../middleware/auth-express-middleware/src/**'
  ]
  const retainedRunner = testMatch =>
    jestTarget('jest.config.js', testMatch, {
      esm: true,
      buildCommand: 'pnpm build',
      maxTestRunnerReuse: 8,
      config: {
        projects: createCoreOverlayTestProjects(testMatch, {
          roots: [
            '<rootDir>',
            resolve(repositoryRoot, 'packages/overlays/overlay-express/src/__tests__')
          ],
          moduleNameMapper: {
            [String.raw`^\.\./\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]: resolve(
              repositoryRoot,
              'packages/application/output-knowledge/$1.ts'
            ),
            [String.raw`^(\.{1,2}/.*)\.js$`]: '$1'
          }
        })
      }
    })
  for (const id of [
    'overlay-proposal-admission',
    'overlay-private-publication-admission',
    'overlay-private-purchase-admission',
    'overlay-integrity'
  ]) {
    const target = targets[id]
    target.additionalInputs = [...(target.additionalInputs ?? []), ...retainedInputs]
    const testMatch = [...target.runnerOptions.jest.config.testMatch, ...retainedTests]
    const originalReuse = target.runnerOptions.maxTestRunnerReuse
    target.runnerOptions = { ...target.runnerOptions, ...retainedRunner(testMatch).runnerOptions }
    if (originalReuse === undefined) delete target.runnerOptions.maxTestRunnerReuse
    else target.runnerOptions.maxTestRunnerReuse = originalReuse
  }
  targets['overlay-retained-beef'] = {
    packageDirectory: 'packages/overlays/overlay',
    manifest: 'packages/overlays/overlay/package.json',
    propertyTest: 'packages/overlays/overlay/src/__tests/RetainedTransactionBEEF.property.test.ts',
    additionalInputs: retainedInputs,
    mutate: ['src/RetainedTransactionBEEF.ts'],
    ...retainedRunner(retainedTests)
  }
  for (const id of ['root-eviction-local-rules', 'root-eviction-scheduler']) {
    const config = targets[id].runnerOptions.jest.config
    const native = targets['root-eviction-journal'].runnerOptions.jest.config
    config.testMatch.push(...native.testMatch)
    config.roots = [...native.roots]
    config.moduleNameMapper = { ...native.moduleNameMapper, ...config.moduleNameMapper }
  }
  for (const id of [
    'lch-overlay-acquisition',
    'lch-overlay-covenant-terms',
    'lch-overlay-covenant-settlement',
    'lch-overlay-license',
    'lch-overlay-covenant-seller',
    'lch-overlay-covenant'
  ]) {
    const config = targets[id].runnerOptions.jest.config
    targets[id].runnerOptions.maxTestRunnerReuse = 8
    config.moduleNameMapper = {
      [String.raw`^\.\./\.\./\.\./application/output-knowledge/(.*)\.js$`]: resolve(
        repositoryRoot,
        'packages/application/output-knowledge/$1.ts'
      ),
      [String.raw`^(\.{1,2}/.*)\.js$`]: '$1'
    }
  }
  targets['lch-overlay-covenant-candidate'] = {
    ...targets['lch-overlay-covenant'],
    propertyTest:
      'packages/content/lch/test/overlay-acquisition-covenant-profile-candidate.property.test.ts',
    mutate: ['src/overlayAcquisitionCovenantCore.ts', 'src/overlayAcquisitionCovenantProfile.ts']
  }
  const aliasCoreTests = [
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
  for (const id of [
    'private-purchase-alias-state',
    'private-purchase-alias-custody',
    'private-purchase-state',
    'private-purchase-native-clock',
    'private-purchase-coordination',
    'private-purchase-evidence',
    'private-purchase-disclosure',
    'private-purchase-buyer',
    'protected-operation-objects'
  ]) {
    const selectors = targets[id].runnerOptions.jest.config.testMatch
    targets[id].runnerOptions.jest.config.testMatch = [
      ...selectors,
      ...aliasCoreTests.filter(test => !selectors.includes(test))
    ]
    // Complete initial-suite budget only: nine base profiles and five derived
    // alias profiles registered below. Preserve individual property deadlines,
    // tests, mutation ranges, thresholds, worker isolation and overall job limits.
    targets[id].runnerOptions.dryRunTimeoutMinutes = id === 'private-purchase-buyer' ? 30 : 15
    targets[id].additionalInputs = [
      ...targets[id].additionalInputs,
      'test/private-purchase-alias*.ts',
      'test/private-purchase-buyer-alias*.ts',
      'test/evidence-fixture.ts',
      'test/fixtures/reconciliation-vectors.json'
    ]
  }
  for (const [id, property, module] of [
    [
      'private-purchase-alias-owner',
      'private-purchase-alias-owner',
      'SQLitePrivatePurchaseAliasStore'
    ],
    [
      'private-purchase-alias-currentness',
      'private-purchase-alias-currentness',
      'SDKPrivatePurchaseAliasCurrentness'
    ],
    [
      'private-purchase-alias-coordinator',
      'private-purchase-alias-coordinator',
      'PrivatePurchaseAliasCoordinator'
    ],
    [
      'private-purchase-alias-disclosure',
      'private-purchase-alias-disclosure',
      'PrivatePurchaseAliasDisclosure'
    ],
    [
      'private-purchase-buyer-alias',
      'private-purchase-buyer-alias',
      'PrivatePurchaseBuyerAliasCurrentness'
    ]
  ]) {
    targets[id] = {
      ...structuredClone(targets['private-purchase-alias-custody']),
      propertyTest: `packages/application/output-knowledge/test/${property}.property.test.ts`,
      mutate: [`src/private/${module}.ts`]
    }
  }
  appendMutationBuildInputs(repositoryRoot, targets)
  for (const [name, additions] of Object.entries(walletDataAdditions)) {
    const target = targets[name]
    target.mutate = [...new Set([...target.mutate, ...additions.mutate])]
    target.additionalInputs = [
      ...new Set([...(target.additionalInputs ?? []), ...additions.additionalInputs])
    ]
    if (!name.startsWith('wallet-current-')) {
      const original = target.runnerOptions.jest.config
      target.runnerOptions = {
        ...target.runnerOptions,
        jest: {
          ...target.runnerOptions.jest,
          config: {
            ...original,
            testMatch: [...new Set([...original.testMatch, ...additions.tests])]
          }
        }
      }
    }
  }
  targets['wallet-portable-canonical-chunks'].runnerOptions.maxTestRunnerReuse = 20
  for (const target of Object.values(targets)) {
    if (
      target.packageDirectory === 'packages/wallet/wallet-toolbox' &&
      target.runnerOptions?.jest
    ) {
      // Stryker's Jest processes share one sandbox. The source-owned lifecycle
      // prepares physical Worker siblings and deletes a fixed fixture directory;
      // concurrent invocations would violate those exclusive ownership contracts.
      target.runnerOptions.concurrency = 1
      const config = target.runnerOptions.jest.config
      const functional = [...requiredFunctionalTests].filter(
        file =>
          target.requiredFunctionalTests?.includes(file.replace(/^<rootDir>\//, '')) ||
          config.testMatch?.some(pattern => matchesGlob(file, pattern))
      )
      if (functional.length !== 0) {
        target.requiredFunctionalTests = functional.map(file => file.replace(/^<rootDir>\//, ''))
        if (
          functional.includes('<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts')
        )
          target.configurationInputs = [
            ...new Set([
              ...(target.configurationInputs ?? []),
              'scripts/wallet-journal-ci.mjs',
              '.github/workflows/ci.yml'
            ])
          ]
        if (
          functional.some(
            file => file !== '<rootDir>/src/storage/__test/WalletStorageManager.journal.test.ts'
          )
        )
          target.configurationInputs = [
            ...new Set([
              ...(target.configurationInputs ?? []),
              'scripts/wallet-composed-native-ci.mjs',
              '.github/workflows/ci.yml'
            ])
          ]
        // Jest replaces this array when merging its configuration. Preserve the
        // package's generated-directory boundaries, then exclude only the eight
        // already governed functional files, including matches through globs.
        config.testPathIgnorePatterns = [
          ...new Set([
            '/node_modules/',
            String.raw`<rootDir>/\.stryker-tmp/`,
            ...(config.testPathIgnorePatterns ?? []),
            ...functional.map(
              file =>
                '<rootDir>/' +
                file.replace(/^<rootDir>\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                '$'
            )
          ])
        ]
      }
      target.runnerOptions.jest.config = {
        ...config,
        transform: {
          '^.+\\.ts$': [
            'ts-jest',
            {
              rootDir: '.',
              tsconfig: resolve(repositoryRoot, target.packageDirectory, 'tsconfig.jest.json')
            }
          ]
        }
      }
      target.configurationInputs = [
        ...new Set([
          ...(target.configurationInputs ?? []),
          'packages/wallet/wallet-toolbox/tsconfig.json',
          'packages/wallet/wallet-toolbox/tsconfig.jest.json',
          'packages/wallet/wallet-toolbox/client/test/tsconfig.browser.json',
          'config/typescript/dual-runtime.json',
          'config/typescript/strict.json',
          'scripts/wallet-jest-config.test.mjs'
        ])
      ]
    }
  }
  return targets
}
