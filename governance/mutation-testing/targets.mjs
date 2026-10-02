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

function lookupProviderTarget(property, files, tests, additionalInputs = []) {
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
      { esm: true, buildCommand: 'pnpm build' }
    )
  }
}

function rootEvictionTarget(property, files) {
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
      'test/fixtures/root-maintenance-worker.mjs'
    ],
    mutate: files.map(name => `src/root-eviction/${name}.ts`),
    ...jestTarget('jest.config.js', ['<rootDir>/test/root-eviction*.test.ts'], {
      esm: true,
      buildCommand: 'pnpm build'
    })
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

function lineageGraphTargets(repositoryRoot) {
  const file = 'src/revenue-listing/LineageGraph.ts'
  const lines = readFileSync(
    resolve(repositoryRoot, 'packages/application/output-knowledge', file),
    'utf8'
  ).split('\n')
  const traversalStart = lines.indexOf('interface Traversal {') + 1
  if (traversalStart < 2 || traversalStart >= lines.length)
    throw new Error('Unable to partition lineage layout and traversal responsibilities')
  return {
    'revenue-lineage-graph': {
      ...lineageTarget('LineageGraph', 'revenue-lineage-graph.property.test.ts', {
        maxTestRunnerReuse: 8
      }),
      mutate: [`${file}:1-${traversalStart - 1}`]
    },
    'revenue-lineage-traversal': {
      ...lineageTarget('LineageGraph', 'revenue-lineage-traversal.property.test.ts'),
      mutate: [`${file}:${traversalStart}-${lines.length}`]
    }
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
      '<rootDir>/src/storage/__test/createActionPerformance.test.ts'
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
      'src/storage/methods/createAction.ts'
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
    'src/signer/methods/internalizeAction.ts'
  ]
  target.runnerOptions.jest.config.testMatch = [
    '<rootDir>/src/storage/fundingRecovery/__test/*.test.ts',
    '<rootDir>/src/signer/fundingRecovery/__test/*.test.ts',
    '<rootDir>/test/storage/internalizeActionManagedChangePolicy.test.ts',
    '<rootDir>/test/storage/internalizeActionMarkInputsSpent.test.ts',
    '<rootDir>/test/storage/internalizeActionBasketReclassification.test.ts'
  ]
  return target
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
  return {
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
        ...[
          ['  if (recovery !== undefined) requireFunding', '  await ctx.asyncSetup()'],
          ['  private async loadExistingTransaction(', '  private computeWalletPaymentBalance()'],
          ['  async setupEvidence()', '  async validateAtomicBeef(']
        ].map(([start, end]) =>
          sourceLineRange(
            repositoryRoot,
            'packages/wallet/wallet-toolbox',
            'src/storage/methods/internalizeAction.ts',
            start,
            end
          )
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/wallet/wallet-toolbox',
          'src/signer/methods/internalizeAction.ts',
          '  const r: StorageInternalizeActionResult',
          '  return r'
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
        'src/storage/actionRecovery/ActionRecoveryJSON.ts'
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
    'wallet-recovery-controller': walletRecoveryTarget(
      repositoryRoot,
      'src/signer/actionRecovery/RecoverableActionController.ts',
      'src/signer/actionRecovery/__test/RecoverableActionController.property.test.ts'
    ),
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
        'test/fixtures/revenue-listing/**'
      ],
      mutate: ['src/revenue-listing/RevenueListingAuthority.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/revenue-authority.test.ts',
          '<rootDir>/test/revenue-authority.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
      )
    },
    'revenue-lineage-package': lineageTarget(
      'LineagePackage',
      'revenue-lineage-package.property.test.ts'
    ),
    ...lineageGraphTargets(repositoryRoot),
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
      ...rootEvictionTarget('root-eviction-local-rules.property.test.ts', [
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
      ...rootEvictionTarget('root-eviction-scheduler.property.test.ts', ['RootEvictionScheduler']),
      ...jestTarget('jest.config.js', ['<rootDir>/test/root-eviction-scheduler*.test.ts'], {
        esm: true,
        buildCommand: 'pnpm build'
      })
    },
    'root-eviction-service': rootEvictionTarget('root-eviction-service.property.test.ts', [
      'RootEvictionService'
    ]),
    'root-eviction-maintenance': rootEvictionTarget('root-eviction-maintenance.property.test.ts', [
      'SQLiteRootEvictionMaintenance',
      'RootEvictionMaintenanceStorage'
    ]),
    'root-eviction-coordination': rootEvictionTarget(
      'root-eviction-coordination.property.test.ts',
      [
        'RootEvictionContractRecords',
        'RootEvictionCoordinatedStorage',
        'RootEvictionRecoveryStorage'
      ]
    ),
    'root-eviction-commit': rootEvictionTarget('root-eviction-commit.property.test.ts', [
      'RootEvictionCommitContext'
    ]),
    'root-eviction-journal': rootEvictionTarget('root-eviction.property.test.ts', [
      'SQLiteRootEvictionStore'
    ]),
    'root-eviction-records': rootEvictionTarget('root-eviction-records.property.test.ts', [
      'RootEvictionRequests',
      'RootEvictionServingRecords'
    ]),
    'root-eviction-codec': rootEvictionTarget('root-eviction-codec.property.test.ts', [
      'RootEvictionCodec'
    ]),
    'root-eviction-storage': rootEvictionTarget('root-eviction-storage.property.test.ts', [
      'SQLiteRootEvictionDatabase',
      'RootEvictionStorage'
    ]),
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
      mutate: ['src/overlay-tools/OutputProtocolJSON.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/overlay-tools/__tests/OutputProtocol.test.ts',
        '<rootDir>/src/overlay-tools/__tests/OutputProtocolJSON.property.test.ts'
      ])
    },
    'sdk-revenue-listing-plan': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/script/templates/__tests/RevenueListingPlan.property.test.ts',
      mutate: ['src/script/templates/RevenueListingPlan.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/script/templates/__tests/RevenueListingPlan.test.ts',
        '<rootDir>/src/script/templates/__tests/RevenueListingPlan.property.test.ts'
      ])
    },
    ...revenueSpendTargets(repositoryRoot),
    'sdk-revenue-listing': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/script/templates/__tests/RevenueListing.property.test.ts',
      mutate: ['src/script/templates/RevenueListing.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/script/templates/__tests/RevenueListing.test.ts',
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
        { esm: true, buildCommand: 'pnpm build' }
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
      mutate: ['src/ProposalAdmission.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/ProposalAdmission.test.ts',
        '<rootDir>/src/__tests/ProposalAdmission.property.test.ts'
      ])
    },
    'overlay-root-response-guard': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest:
        'packages/overlays/overlay-express/src/__tests__/RootEvictionResponseGuard.property.test.ts',
      mutate: ['src/RootEvictionResponseGuard.ts'],
      additionalInputs: [
        'src/__tests__/RootEvictionResponseGuard.fixture.ts',
        '../../application/output-knowledge/src/root-eviction/**',
        '../../application/output-knowledge/test/root-eviction-fixture.ts',
        '../../middleware/auth-express-middleware/src/**',
        '../../middleware/auth-express-middleware/mod.ts'
      ],
      ...jestTarget(
        'jest.config.js',
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
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/__tests__/Proposal*.test.ts',
          '<rootDir>/src/__tests__/OverlayExpress.test.ts'
        ],
        {
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
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests__/RootEvictionRoutes*.test.ts'], {
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
      })
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
        '../../application/output-knowledge/src/lookup/**',
        '../../application/output-knowledge/test/lookup-provider-fixture.ts'
      ],
      ...jestTarget(
        'jest.config.js',
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
      ['src/proposals/**', 'test/proposal-client-fixture.ts', 'test/live-lookup-fixture.ts']
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
    'protected-ledger': {
      packageDirectory: 'packages/application/output-knowledge',
      manifest: 'packages/application/output-knowledge/package.json',
      propertyTest: 'packages/application/output-knowledge/test/protected-ledger.property.test.ts',
      additionalInputs: ['src/private/**', 'src/storage/**', 'test/protected-ledger-fixture.ts'],
      mutate: [
        'src/private/SQLiteProtectedLedger.ts',
        'src/private/ProtectedLedgerCodec.ts',
        'src/private/NodeProtectedPayloadCodec.ts'
      ],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/test/protected-payload.test.ts',
          '<rootDir>/test/protected-ledger-codec.test.ts',
          '<rootDir>/test/protected-ledger.test.ts',
          '<rootDir>/test/protected-ledger.property.test.ts'
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
          '<rootDir>/test/proposal-bitcoin-core.test.ts',
          '<rootDir>/test/proposal-knowledge-view.test.ts',
          '<rootDir>/test/proposal-knowledge-order.test.ts',
          '<rootDir>/test/proposal-current*.test.ts',
          '<rootDir>/test/source-generation-state.test.ts',
          '<rootDir>/test/knowledge-read-window.test.ts',
          '<rootDir>/test/proposal-core.property.test.ts'
        ],
        { esm: true, buildCommand: 'pnpm build' }
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
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts'
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
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts'
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
          '<rootDir>/src/overlay-tools/__tests/OutputLookupTransport.test.ts'
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
    'overlay-linkage': {
      packageDirectory: 'packages/overlays/topics',
      manifest: 'packages/overlays/topics/package.json',
      propertyTest: 'packages/overlays/topics/src/mandala/__tests/types.property.test.ts',
      mutate: ['src/mandala/types.ts:72-97', 'src/admission/issuerPolicy.ts:36-39'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/mandala/__tests/types*.test.ts'], {
        esm: true
      })
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
      mutate: ['src/mandala-encoding.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/mandala-encoding*.test.ts'])
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
        'src/authMiddlewareHelpers.ts:206-233'
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/authMiddlewareHelpers*.test.ts'])
    },
    'payment-replay': {
      packageDirectory: 'packages/middleware/payment-express-middleware',
      manifest: 'packages/middleware/payment-express-middleware/package.json',
      propertyTest:
        'packages/middleware/payment-express-middleware/src/__tests/PaymentReplayStore.property.test.ts',
      mutate: ['src/index.ts:27-44'],
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
