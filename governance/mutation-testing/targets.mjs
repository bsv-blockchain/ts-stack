import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

function jestTarget(
  configFile,
  testMatch,
  { esm = false, config = {}, findRelated = false, buildCommand, maxTestRunnerReuse } = {}
) {
  return {
    testRunner: 'jest',
    runnerOptions: {
      ...(buildCommand ? { buildCommand } : {}),
      ...(maxTestRunnerReuse === undefined ? {} : { maxTestRunnerReuse }),
      jest: {
        projectType: 'custom',
        configFile,
        enableFindRelatedTests: findRelated,
        ...(testMatch === undefined
          ? {}
          : {
              config: {
                ...config,
                testMatch
              }
            })
      },
      ...(esm ? { testRunnerNodeArgs: ['--experimental-vm-modules'] } : {})
    }
  }
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

// Preserve the complete original snapshot-sync source ranges and selected tests.
// Each disjoint group runs the same behavioral suite and its own strict gate.
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
        'private async runSnapshotCopy(',
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
  return {
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
      ].map(([filePath, startMarker, endMarker]) =>
        sourceLineRange(repositoryRoot, 'packages/sdk', filePath, startMarker, endMarker)
      ),
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/auth/__tests/Peer.boundary.test.ts',
          '<rootDir>/src/auth/__tests/Peer.messageValidation.security.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.boundary.test.ts',
          '<rootDir>/src/auth/clients/__tests__/AuthFetch.property.test.ts',
          '<rootDir>/src/auth/transports/__tests__/SimplifiedFetchTransport*.test.ts'
        ],
        { esm: true }
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
        'src/storage/schema/snapshotGlobalIndexBootstrap.ts',
        'src/storage/schema/snapshotGlobalIndexTriggers.ts',
        'src/storage/schema/snapshotSqliteIdentity.ts',
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
      propertyTest: 'packages/overlays/overlay-express/src/__tests/ReorgStream.property.test.ts',
      mutate: ['src/ReorgStream.ts'],
      ...jestTarget(
        'jest.config.js',
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
      mutate: ['src/BASM.ts:154-190', 'src/SafeLog.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/BASM.test.ts',
        '<rootDir>/src/__tests/BASM.property.test.ts',
        '<rootDir>/src/__tests/SafeLog.test.ts'
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
    'auth-express-bytes': {
      packageDirectory: 'packages/middleware/auth-express-middleware',
      manifest: 'packages/middleware/auth-express-middleware/package.json',
      propertyTest:
        'packages/middleware/auth-express-middleware/src/__tests/authMiddlewareHelpers.property.test.ts',
      mutate: [
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
      mutate: ['src/index.ts:30-47'],
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
    }
  }
}
