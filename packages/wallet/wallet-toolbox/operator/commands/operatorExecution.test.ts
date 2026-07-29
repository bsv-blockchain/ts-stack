import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { OperatorPlan } from '../contracts'
import { chaintracksExportCommand } from './chaintracksExport'
import { chaintracksIdbObserveCommand } from './chaintracksIdbObserve'
import { dojoImportCommand } from './dojoImport'
import { monitorDaemonCommand } from './monitorDaemon'
import { storageClientExerciseCommand } from './storageClientExercise'
import { walletAbortActionCommand } from './walletAbortAction'
import { walletDiagnosticsCommand } from './walletDiagnostics'
import { walletLegacyFixtureCommand } from './walletLegacyFixture'
import { walletProofHistoryCommand } from './walletProofHistory'
import { walletReconcileStuckCommand } from './walletReconcileStuck'
import { walletReinternalizeExportsCommand } from './walletReinternalizeExports'
import { walletRepairProvenTransactionsCommand } from './walletRepairProvenTransactions'
import { walletReviewCustomOutputsCommand } from './walletReviewCustomOutputs'
import { walletReviewOutputsCommand } from './walletReviewOutputs'
import { walletReviewProofRequestsCommand } from './walletReviewProofRequests'

type MockState = Record<string, any>

var mockState: MockState

jest.mock('../../out/src/index.js', () => {
  const StorageKnex = function (...args: unknown[]) {
    return mockState.storageFactory(...args)
  }
  StorageKnex.defaultOptions = () => ({ storageName: 'mock-storage' })

  const Services = function (...args: unknown[]) {
    return mockState.servicesFactory(...args)
  }
  Services.createDefaultOptions = (...args: unknown[]) => mockState.createServicesOptions(...args)

  const Chaintracks = function (...args: unknown[]) {
    return mockState.chaintracksFactory(...args)
  }

  const MonitorDaemon = function (...args: unknown[]) {
    return mockState.monitorDaemonFactory(...args)
  }

  const StorageSyncReader = function (...args: unknown[]) {
    return mockState.storageSyncReaderFactory(...args)
  }

  const WalletStorageManager = function (...args: unknown[]) {
    return mockState.walletStorageManagerFactory(...args)
  }

  const Monitor = function (...args: unknown[]) {
    return mockState.monitorFactory(...args)
  }
  Monitor.createDefaultWalletMonitorOptions = (...args: unknown[]) => mockState.monitorOptions(...args)

  const StorageMySQLDojoReader = function (...args: unknown[]) {
    return mockState.dojoReaderFactory(...args)
  }

  const TaskPurge = function (...args: unknown[]) {
    return mockState.purgeTaskFactory(...args)
  }

  return {
    Chaintracks,
    ChaintracksFs: {},
    EntityProvenTxReq: {
      fromTxid: (...args: unknown[]) => mockState.entityProvenTxReqFromTxid(...args)
    },
    EntitySyncState: {
      fromStorage: (...args: unknown[]) => mockState.entitySyncStateFromStorage(...args)
    },
    Monitor,
    MonitorDaemon,
    Services,
    Setup: {
      createMySQLKnex: (...args: unknown[]) => mockState.createMySQLKnex(...args),
      createSQLiteKnex: (...args: unknown[]) => mockState.createSQLiteKnex(...args)
    },
    SetupClient: {
      createWalletClientNoEnv: (...args: unknown[]) => mockState.createWalletClient(...args)
    },
    StorageKnex,
    StorageSyncReader,
    Task: { TaskPurge },
    WalletStorageManager,
    createDefaultNoDbChaintracksOptions: (...args: unknown[]) => mockState.createChaintracksOptions(...args),
    doubleSha256BE: (...args: unknown[]) => mockState.doubleSha256BE(...args),
    randomBytesHex: (...args: unknown[]) => mockState.randomBytesHex(...args),
    sdk: {
      Validation: {
        parseWalletOutpoint: (...args: unknown[]) => mockState.parseWalletOutpoint(...args)
      },
      specOpInvalidChange: 'invalid-change'
    },
    sync: { StorageMySQLDojoReader }
  }
})

jest.mock('../../out/src/services/chaintracker/chaintracks/createIdbChaintracks.js', () => ({
  createIdbChaintracks: (...args: unknown[]) => mockState.createIdbChaintracks(...args)
}))

jest.mock('@bsv/sdk', () => {
  const Beef = function (...args: unknown[]) {
    return mockState.beefFactory(...args)
  }
  Beef.fromBinary = (...args: unknown[]) => mockState.beefFromBinary(...args)

  const CachedKeyDeriver = function (...args: unknown[]) {
    return mockState.cachedKeyDeriverFactory(...args)
  }
  const P2PKH = function (...args: unknown[]) {
    return mockState.p2pkhFactory(...args)
  }

  return {
    Beef,
    CachedKeyDeriver,
    MerklePath: {
      fromBinary: (...args: unknown[]) => mockState.merklePathFromBinary(...args)
    },
    P2PKH,
    PrivateKey: {
      fromHex: (...args: unknown[]) => mockState.privateKeyFromHex(...args)
    },
    Transaction: {
      fromBinary: (...args: unknown[]) => mockState.transactionFromBinary(...args),
      fromHex: (...args: unknown[]) => mockState.transactionFromHex(...args)
    },
    Utils: {
      toHex: (...args: unknown[]) => mockState.toHex(...args)
    },
    Validation: {
      parseWalletOutpoint: (...args: unknown[]) => mockState.parseWalletOutpoint(...args)
    }
  }
})

function operatorPlan(command: string, parameters: OperatorPlan['parameters']): OperatorPlan {
  return {
    command,
    description: `Test ${command}`,
    effect: 'read-only',
    requiresProductionApproval: false,
    parameters
  }
}

function queryReturning<T>(rows: T[]): Record<string, jest.Mock> {
  const query: Record<string, jest.Mock> = {}
  for (const method of [
    'join',
    'limit',
    'orderBy',
    'select',
    'where',
    'whereNotNull',
    'whereNull'
  ]) {
    query[method] = jest.fn().mockReturnValue(query)
  }
  query.select.mockResolvedValue(rows)
  return query
}

function createStorage(overrides: MockState = {}): MockState {
  return {
    abortAction: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    dropAllData: jest.fn().mockResolvedValue(undefined),
    findOutputById: jest.fn(),
    findOutputs: jest.fn().mockResolvedValue([]),
    findProvenTxById: jest.fn(),
    findProvenTxReqById: jest.fn(),
    findProvenTxReqs: jest.fn().mockResolvedValue([]),
    findProvenTxs: jest.fn().mockResolvedValue([]),
    findTransactionById: jest.fn(),
    findTransactions: jest.fn().mockResolvedValue([]),
    findUserByIdentityKey: jest.fn(),
    findUsers: jest.fn().mockResolvedValue([]),
    getBeefForTransaction: jest.fn(),
    getProvenOrReq: jest.fn().mockResolvedValue({}),
    getRawTxOfKnownValidTransaction: jest.fn(),
    getReqsAndBeefToShareWithWorld: jest.fn(),
    getSettings: jest.fn().mockResolvedValue({ storageIdentityKey: 'storage-key' }),
    internalizeAction: jest.fn(),
    listOutputs: jest.fn(),
    makeAvailable: jest.fn().mockResolvedValue(undefined),
    migrate: jest.fn().mockResolvedValue(undefined),
    setServices: jest.fn(),
    toDb: jest.fn(),
    updateOutput: jest.fn(),
    updateProvenTx: jest.fn(),
    updateProvenTxReq: jest.fn(),
    updateTransactionStatus: jest.fn(),
    ...overrides
  }
}

function createServices(overrides: MockState = {}): MockState {
  return {
    getMerklePath: jest.fn(),
    getRawTx: jest.fn(),
    getStatusForTxids: jest.fn(),
    getUtxoStatus: jest.fn(),
    hashOutputScript: jest.fn(value => `hash:${String(value)}`),
    ...overrides
  }
}

beforeEach(() => {
  const defaultServices = createServices()
  const defaultPrivateKey = {
    toPublicKey: jest.fn().mockReturnValue({
      toAddress: jest.fn().mockReturnValue('mock-address')
    })
  }
  const defaultP2pkh = {
    lock: jest.fn().mockReturnValue({ toHex: jest.fn().mockReturnValue('51') }),
    unlock: jest.fn().mockReturnValue({ unlock: true })
  }
  mockState = {
    beefFactory: jest.fn().mockReturnValue({
      findAtomicTransaction: jest.fn(),
      findTxid: jest.fn(),
      mergeBeef: jest.fn(),
      mergeRawTx: jest.fn(),
      toBinary: jest.fn().mockReturnValue([9]),
      txs: []
    }),
    beefFromBinary: jest.fn(),
    cachedKeyDeriverFactory: jest.fn().mockReturnValue({
      derivePrivateKey: jest.fn().mockReturnValue(defaultPrivateKey)
    }),
    chaintracksFactory: jest.fn(),
    createChaintracksOptions: jest.fn().mockReturnValue({ chain: 'test' }),
    createIdbChaintracks: jest.fn(),
    createMySQLKnex: jest.fn().mockReturnValue({ client: 'mysql' }),
    createServicesOptions: jest.fn().mockReturnValue({
      arcConfig: {},
      bitailsApiKey: undefined,
      whatsOnChainApiKey: undefined
    }),
    createSQLiteKnex: jest.fn().mockReturnValue({ client: 'sqlite' }),
    createWalletClient: jest.fn(),
    dojoReaderFactory: jest.fn(),
    doubleSha256BE: jest.fn().mockReturnValue([0xaa]),
    entityProvenTxReqFromTxid: jest.fn(),
    entitySyncStateFromStorage: jest.fn(),
    merklePathFromBinary: jest.fn(),
    monitorDaemonFactory: jest.fn(),
    monitorFactory: jest.fn(),
    monitorOptions: jest.fn().mockReturnValue({}),
    p2pkhFactory: jest.fn().mockReturnValue(defaultP2pkh),
    parseWalletOutpoint: jest.fn().mockReturnValue({ txid: 'aa'.repeat(32), vout: 0 }),
    privateKeyFromHex: jest.fn().mockReturnValue(defaultPrivateKey),
    purgeTaskFactory: jest.fn(),
    randomBytesHex: jest.fn().mockReturnValue('11'.repeat(33)),
    servicesFactory: jest.fn().mockReturnValue(defaultServices),
    storageFactory: jest.fn(),
    storageSyncReaderFactory: jest.fn().mockReturnValue({ reader: true }),
    toHex: jest.fn((value: number[]) => Buffer.from(value).toString('hex')),
    transactionFromBinary: jest.fn(),
    transactionFromHex: jest.fn(),
    walletStorageManagerFactory: jest.fn()
  }
})

describe('extracted operator command execution', () => {
  test('exports Chaintracks artifacts and always closes the tracker', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'chaintracks-export-'))
    const chaintracks = {
      destroy: jest.fn().mockResolvedValue(undefined),
      exportBulkHeaders: jest.fn().mockImplementation(async (target: string) => {
        await fs.writeFile(path.join(target, 'headers.json'), '{}')
      }),
      findChainTipHeader: jest.fn().mockResolvedValue({ hash: 'tip-hash', height: 900_000 }),
      makeAvailable: jest.fn().mockResolvedValue(undefined)
    }
    mockState.chaintracksFactory.mockReturnValue(chaintracks)
    try {
      const evidence = await chaintracksExportCommand.execute(
        new Map(),
        operatorPlan('chaintracks-export', {
          chain: 'test',
          output,
          headersPerFile: 1_000,
          cdnBaseUrl: 'https://headers.example.test'
        })
      )
      expect(evidence.result).toMatchObject({
        chain: 'test',
        artifactCount: 1,
        tipHeight: 900_000,
        tipHash: 'tip-hash'
      })
      expect(chaintracks.exportBulkHeaders).toHaveBeenCalledWith(
        output,
        expect.anything(),
        'https://headers.example.test',
        1_000
      )
      expect(chaintracks.destroy).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(output, { force: true, recursive: true })
    }
  })

  test('validates and closes an IndexedDB Chaintracks observation', async () => {
    const chaintracks = {
      destroy: jest.fn().mockResolvedValue(undefined),
      findChainTipHash: jest.fn().mockResolvedValue('tip-hash'),
      findChainTipHeader: jest.fn().mockResolvedValue({ hash: 'tip-hash', height: 123 }),
      findHeaderForBlockHash: jest.fn().mockResolvedValue({ hash: 'tip-hash' }),
      findLiveHeaderForBlockHash: jest.fn().mockResolvedValue({ hash: 'tip-hash', chainWork: 'work' }),
      findHeaderForHeight: jest.fn().mockResolvedValue({ hash: 'tip-hash' }),
      findChainWorkForBlockHash: jest.fn().mockResolvedValue('work'),
      getInfo: jest.fn().mockResolvedValue({ storage: 'idb', heightBulk: 100, heightLive: 123 }),
      isListening: jest.fn().mockResolvedValue(true),
      subscribeHeaders: jest.fn().mockImplementation(async (listener: () => void) => {
        listener()
        return 'subscription'
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined)
    }
    mockState.createIdbChaintracks.mockResolvedValue({
      available: Promise.resolve(),
      chaintracks
    })

    const evidence = await chaintracksIdbObserveCommand.execute(
      new Map(),
      operatorPlan('chaintracks-idb-observe', {
        chain: 'test',
        whatsonchainApiKeyEnvironment: 'TEST_WOC_KEY',
        observeSeconds: 0
      })
    )
    expect(evidence.result).toMatchObject({
      chain: 'test',
      observedHeaders: 1,
      storage: 'idb',
      tipHeight: 123
    })
    expect(chaintracks.unsubscribe).toHaveBeenCalledWith('subscription')
    expect(chaintracks.destroy).toHaveBeenCalledTimes(1)
  })

  test('imports bounded Dojo chunks and closes both stores', async () => {
    process.env.TEST_DOJO_CONNECTION = 'source'
    process.env.TEST_IDENTITY = 'identity'
    const writer = createStorage()
    const reader = {
      destroy: jest.fn().mockResolvedValue(undefined),
      getSettings: jest.fn().mockResolvedValue({ storageIdentityKey: 'source-key' }),
      getSyncChunk: jest.fn().mockResolvedValue({ rows: [] })
    }
    const syncState = {
      makeRequestSyncChunkArgs: jest.fn().mockReturnValue({ cursor: 0 }),
      processSyncChunk: jest.fn().mockResolvedValue({ done: true, inserts: 3, updates: 2 })
    }
    mockState.storageFactory.mockReturnValue(writer)
    mockState.dojoReaderFactory.mockReturnValue(reader)
    mockState.entitySyncStateFromStorage.mockResolvedValue(syncState)

    const evidence = await dojoImportCommand.execute(
      new Map(),
      operatorPlan('dojo-import', {
        chain: 'test',
        sourceEnvironment: 'TEST_DOJO_CONNECTION',
        identityKeyEnvironment: 'TEST_IDENTITY',
        destinationKind: 'sqlite',
        destination: path.join(os.tmpdir(), 'dojo-import-test.sqlite'),
        databaseName: 'dojo-test',
        dropExisting: true,
        maxChunks: 1
      })
    )
    expect(evidence.result).toMatchObject({
      chunks: 1,
      inserts: 3,
      updates: 2
    })
    expect(writer.dropAllData).toHaveBeenCalledTimes(1)
    expect(reader.destroy).toHaveBeenCalledTimes(1)
    expect(writer.destroy).toHaveBeenCalledTimes(1)
  })

  test('runs one monitor pass and closes daemon and Chaintracks resources', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const monitor = {
      runOnce: jest.fn().mockResolvedValue(undefined),
      startTasks: jest.fn(),
      stopTasks: jest.fn()
    }
    const daemon = {
      createSetup: jest.fn().mockImplementation(async function (this: MockState) {
        this.setup = { monitor }
      }),
      destroy: jest.fn().mockResolvedValue(undefined),
      setup: undefined
    }
    const chaintracks = {
      destroy: jest.fn().mockResolvedValue(undefined)
    }
    mockState.monitorDaemonFactory.mockReturnValue(daemon)
    mockState.chaintracksFactory.mockReturnValue(chaintracks)

    const evidence = await monitorDaemonCommand.execute(
      new Map(),
      operatorPlan('monitor-daemon', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        taalApiKeyEnvironment: 'TEST_TAAL',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        bitailsApiKeyEnvironment: 'TEST_BITAILS',
        startupTaskMode: 'none',
        runMode: 'once'
      })
    )
    expect(evidence.result).toMatchObject({
      chain: 'test',
      runMode: 'once',
      shutdownSignal: 'unknown'
    })
    expect(monitor.runOnce).toHaveBeenCalledTimes(1)
    expect(daemon.destroy).toHaveBeenCalledTimes(1)
    expect(chaintracks.destroy).toHaveBeenCalledTimes(1)
  })

  test('creates, signs, and consumes one bounded storage-client output', async () => {
    process.env.TEST_ROOT_KEY = '11'.repeat(32)
    const transaction = {
      inputs: [
        {
          unlockingScript: { toHex: jest.fn().mockReturnValue('unlocking-script') },
          unlockingScriptTemplate: undefined
        }
      ],
      sign: jest.fn().mockResolvedValue(undefined)
    }
    const sourceBeef = {
      toBinaryAtomic: jest.fn().mockReturnValue([1, 2, 3])
    }
    const actionBeef = {
      txs: [{ tx: transaction }]
    }
    mockState.beefFromBinary.mockReturnValueOnce(sourceBeef).mockReturnValueOnce(actionBeef)

    const wallet = {
      balance: jest.fn().mockResolvedValue(100_000),
      createAction: jest
        .fn()
        .mockResolvedValueOnce({ txid: 'created' })
        .mockResolvedValueOnce({
          signableTransaction: {
            reference: 'action-reference',
            tx: [4, 5, 6]
          }
        }),
      destroy: jest.fn().mockResolvedValue(undefined),
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({ totalOutputs: 0, outputs: [] })
        .mockResolvedValueOnce({
          totalOutputs: 1,
          BEEF: [1, 2, 3],
          outputs: [
            {
              outpoint: `${'aa'.repeat(32)}.0`,
              satoshis: 1
            }
          ]
        }),
      signAction: jest.fn().mockResolvedValue({ txid: 'consumed' })
    }
    mockState.createWalletClient.mockResolvedValue(wallet)

    const evidence = await storageClientExerciseCommand.execute(
      new Map(),
      operatorPlan('storage-client-exercise', {
        chain: 'test',
        endpoint: 'https://storage.example.test',
        rootKeyEnvironment: 'TEST_ROOT_KEY',
        basket: 'operator-test',
        iterations: 1,
        concurrency: 1,
        satoshis: 1,
        waitMilliseconds: 0
      })
    )
    expect(evidence.result).toMatchObject({
      created: 1,
      consumed: 1,
      iterations: 1,
      concurrency: 1
    })
    expect(transaction.sign).toHaveBeenCalledTimes(1)
    expect(wallet.signAction).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'action-reference',
        spends: { 0: { unlockingScript: 'unlocking-script' } }
      })
    )
    expect(wallet.destroy).toHaveBeenCalledTimes(1)
  })

  test('aborts exactly one selected wallet action and verifies persistence', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage({
      abortAction: jest.fn().mockResolvedValue({ aborted: true }),
      findTransactions: jest
        .fn()
        .mockResolvedValueOnce([
          {
            transactionId: 7,
            status: 'sending'
          }
        ])
        .mockResolvedValueOnce([]),
      findTransactionById: jest.fn().mockResolvedValue({
        transactionId: 7,
        status: 'failed'
      })
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletAbortActionCommand.execute(
      new Map(),
      operatorPlan('wallet-abort-action', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        userId: 42,
        reference: 'action-reference'
      })
    )
    expect(evidence.result).toMatchObject({
      aborted: true,
      previousStatus: 'sending',
      finalStatus: 'failed'
    })
    expect(storage.abortAction).toHaveBeenCalledWith(
      { userId: 42, identityKey: '' },
      { reference: 'action-reference' }
    )
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('reports recent wallet transactions without modifying storage', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage({
      findTransactions: jest.fn().mockResolvedValue([
        {
          transactionId: 12,
          txid: 'ab'.repeat(32),
          status: 'completed',
          satoshis: 42,
          updated_at: new Date('2026-07-29T00:00:00.000Z')
        }
      ])
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletDiagnosticsCommand.execute(
      new Map(),
      operatorPlan('wallet-diagnostics', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        report: 'recent-transactions',
        userId: 7,
        txids: '',
        rawTransactionFile: '',
        maxRecords: 10
      })
    )
    expect(evidence.result).toMatchObject({
      chain: 'test',
      report: 'recent-transactions',
      records: 1
    })
    expect(JSON.parse(evidence.result.reportJson as string)).toEqual({
      userId: 7,
      transactions: [
        {
          transactionId: 12,
          txid: 'ab'.repeat(32),
          status: 'completed',
          satoshis: 42,
          updatedAt: '2026-07-29T00:00:00.000Z'
        }
      ]
    })
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('reports merged BEEF request and proof state', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const txid = 'cd'.repeat(32)
    const storage = createStorage({
      getReqsAndBeefToShareWithWorld: jest.fn().mockResolvedValue({
        details: [
          {
            txid,
            status: 'completed',
            req: { status: 'unmined' },
            proven: { provenTxId: 1 }
          }
        ],
        beef: {
          txs: [{ txid }]
        }
      })
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletDiagnosticsCommand.execute(
      new Map(),
      operatorPlan('wallet-diagnostics', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        report: 'merged-beef',
        userId: 0,
        txids: txid,
        rawTransactionFile: '',
        maxRecords: 10
      })
    )
    expect(evidence.result).toMatchObject({
      report: 'merged-beef',
      records: 1
    })
    expect(JSON.parse(evidence.result.reportJson as string)).toMatchObject({
      requestedTxids: [txid],
      beefTransactionIds: [txid],
      details: [
        {
          txid,
          requestStatus: 'unmined',
          proven: true
        }
      ]
    })
  })

  test('finds downstream spends from bounded stored request data', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const sourceTxid = '11'.repeat(32)
    const spendingTxid = '22'.repeat(32)
    const storage = createStorage({
      findTransactions: jest.fn().mockResolvedValue([
        {
          txid: spendingTxid
        }
      ]),
      findProvenTxReqs: jest.fn().mockResolvedValue([
        {
          rawTx: [1, 2, 3]
        }
      ])
    })
    mockState.storageFactory.mockReturnValue(storage)
    mockState.beefFactory.mockReturnValue({
      mergeRawTx: jest.fn(),
      txs: [
        {
          txid: spendingTxid,
          tx: {
            inputs: [
              {
                sourceTXID: sourceTxid,
                sourceOutputIndex: 3
              }
            ]
          }
        }
      ]
    })

    const evidence = await walletDiagnosticsCommand.execute(
      new Map(),
      operatorPlan('wallet-diagnostics', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        report: 'downstream-spends',
        userId: 7,
        txids: sourceTxid,
        rawTransactionFile: '',
        maxRecords: 10
      })
    )
    expect(evidence.result).toMatchObject({
      report: 'downstream-spends',
      records: 1
    })
    expect(JSON.parse(evidence.result.reportJson as string).spends).toEqual([
      {
        sourceTxid,
        sourceVout: 3,
        spendingTxid,
        vin: 0
      }
    ])
  })

  test('checks every input UTXO from one bounded transaction file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-diagnostics-'))
    const input = path.join(directory, 'raw.hex')
    const sourceTxid = '33'.repeat(32)
    const sourceTransaction = {
      outputs: [
        {
          lockingScript: {
            toHex: jest.fn().mockReturnValue('51')
          }
        }
      ]
    }
    mockState.transactionFromHex.mockReturnValue({
      id: jest.fn().mockReturnValue('transaction-id'),
      inputs: [
        {
          sourceTXID: sourceTxid,
          sourceOutputIndex: 0
        }
      ]
    })
    mockState.transactionFromBinary.mockReturnValue(sourceTransaction)
    const services = createServices({
      getRawTx: jest.fn().mockResolvedValue({ rawTx: [1, 2, 3] }),
      getUtxoStatus: jest.fn().mockResolvedValue({
        isUtxo: true,
        name: 'mock-provider',
        status: 'success'
      })
    })
    mockState.servicesFactory.mockReturnValue(services)
    try {
      await fs.writeFile(input, '00')
      const evidence = await walletDiagnosticsCommand.execute(
        new Map(),
        operatorPlan('wallet-diagnostics', {
          chain: 'test',
          databaseEnvironment: 'UNUSED_DATABASE',
          whatsonchainApiKeyEnvironment: 'TEST_WOC',
          report: 'input-utxos',
          userId: 0,
          txids: '',
          rawTransactionFile: input,
          maxRecords: 10
        })
      )
      expect(evidence.result).toMatchObject({
        report: 'input-utxos',
        records: 1
      })
      expect(JSON.parse(evidence.result.reportJson as string).inputs).toEqual([
        {
          outpoint: `${sourceTxid}.0`,
          isUtxo: true,
          status: 'success',
          provider: 'mock-provider'
        }
      ])
    } finally {
      await fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('copies one legacy wallet identity into an isolated SQLite fixture', async () => {
    process.env.TEST_SOURCE = 'source'
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-legacy-copy-'))
    const destinationPath = path.join(directory, 'fixture.sqlite')
    const source = createStorage()
    const destination = createStorage({
      findUserByIdentityKey: jest.fn().mockResolvedValue({
        userId: 88
      })
    })
    mockState.storageFactory.mockReturnValueOnce(source).mockReturnValueOnce(destination)
    const manager = {
      makeAvailable: jest.fn().mockResolvedValue(undefined),
      syncFromReader: jest.fn().mockResolvedValue({
        inserts: 5,
        updates: 2
      })
    }
    mockState.walletStorageManagerFactory.mockReturnValue(manager)
    try {
      const evidence = await walletLegacyFixtureCommand.execute(
        new Map(),
        operatorPlan('wallet-legacy-fixture', {
          mode: 'copy',
          identityKey: `02${'44'.repeat(32)}`,
          sourceEnvironment: 'TEST_SOURCE',
          destinationEnvironment: '',
          destinationSqlite: destinationPath,
          dropExisting: false,
          storageName: 'legacy-fixture'
        })
      )
      expect(evidence.result).toMatchObject({
        mode: 'copy',
        destination: destinationPath,
        inserts: 5,
        updates: 2,
        destinationUserId: 88
      })
      expect(source.destroy).toHaveBeenCalledTimes(1)
      expect(destination.destroy).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('runs the bounded legacy-fixture purge task and closes storage', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage()
    const manager = {
      makeAvailable: jest.fn().mockResolvedValue(undefined),
      setServices: jest.fn()
    }
    const purge = {
      runTask: jest.fn().mockResolvedValue('purged fixture records')
    }
    mockState.storageFactory.mockReturnValue(storage)
    mockState.walletStorageManagerFactory.mockReturnValue(manager)
    mockState.monitorFactory.mockReturnValue({ monitor: true })
    mockState.purgeTaskFactory.mockReturnValue(purge)

    const evidence = await walletLegacyFixtureCommand.execute(
      new Map(),
      operatorPlan('wallet-legacy-fixture', {
        mode: 'purge',
        identityKey: `03${'55'.repeat(32)}`,
        databaseEnvironment: 'TEST_DATABASE',
        maxAgeDays: 7
      })
    )
    expect(evidence.result).toMatchObject({
      mode: 'purge',
      maxAgeDays: 7,
      changed: true,
      log: 'purged fixture records'
    })
    expect(purge.runTask).toHaveBeenCalledTimes(1)
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('analyzes a bounded proof-history artifact without database access', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-proof-analysis-'))
    const input = path.join(directory, 'proof-history.json')
    try {
      await fs.writeFile(
        input,
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: '2026-07-29T00:00:00.000Z',
          records: [
            {
              provenTxReqId: 12,
              txid: '66'.repeat(32),
              status: 'doubleSpend',
              history: JSON.stringify({
                notes: [
                  { what: 'status', status_now: 'unmined' },
                  { what: 'status', status_now: 'doubleSpend' }
                ]
              })
            },
            {
              provenTxReqId: 13,
              txid: '77'.repeat(32),
              status: 'invalid',
              history: '{'
            }
          ]
        })
      )
      const evidence = await walletProofHistoryCommand.execute(
        new Map(),
        operatorPlan('wallet-proof-history', {
          mode: 'analyze',
          chain: 'test',
          input,
          maxRecords: 10
        })
      )
      expect(evidence.result).toMatchObject({
        mode: 'analyze',
        records: 2,
        invalidHistories: 1
      })
      expect(JSON.parse(evidence.result.classificationJson as string)).toEqual({
        'unmined-then-failed': [12]
      })
    } finally {
      await fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('exports paged proof history to a new JSON artifact', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-proof-export-'))
    const output = path.join(directory, 'proof-history.json')
    const query = queryReturning([
      {
        provenTxReqId: 21,
        txid: '88'.repeat(32),
        status: 'completed',
        history: '{}'
      }
    ])
    const storage = createStorage({
      toDb: jest.fn().mockReturnValue(jest.fn().mockReturnValue(query))
    })
    mockState.storageFactory.mockReturnValue(storage)
    try {
      const evidence = await walletProofHistoryCommand.execute(
        new Map(),
        operatorPlan('wallet-proof-history', {
          mode: 'export',
          chain: 'test',
          databaseEnvironment: 'TEST_DATABASE',
          whatsonchainApiKeyEnvironment: 'TEST_WOC',
          output,
          overwrite: false,
          minRequestId: 1,
          pageSize: 2,
          maxRecords: 10
        })
      )
      expect(evidence.result).toMatchObject({
        mode: 'export',
        records: 1,
        finalRequestId: 21,
        output
      })
      const artifact = JSON.parse(await fs.readFile(output, 'utf8'))
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        records: [
          {
            provenTxReqId: 21
          }
        ]
      })
      expect(storage.destroy).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('counts missing proof requests during exact verification', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage({
      findProvenTxReqById: jest.fn().mockResolvedValue(undefined)
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletProofHistoryCommand.execute(
      new Map(),
      operatorPlan('wallet-proof-history', {
        mode: 'verify',
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        requestIds: '1,2'
      })
    )
    expect(evidence.result).toMatchObject({
      mode: 'verify',
      requested: 2,
      missingRequests: 2,
      missingInputs: 0,
      scriptFailures: 0,
      verified: 0
    })
  })

  test('verifies complete proof requests and classifies script and input failures', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const txids = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)]
    const sourceTxid = '44'.repeat(32)
    const storage = createStorage({
      findProvenTxReqById: jest.fn().mockImplementation(async (id: number) => ({
        provenTxReqId: id,
        txid: txids[id - 1],
        rawTx: [id],
        inputBEEF: id === 2 ? [9] : undefined
      })),
      getBeefForTransaction: jest.fn().mockResolvedValue({
        toBinary: jest.fn().mockReturnValue([7, 8])
      })
    })
    const missingInputsBeef = {
      findAtomicTransaction: jest.fn(),
      findTxid: jest.fn().mockReturnValue(undefined),
      mergeBeef: jest.fn(),
      mergeRawTx: jest.fn()
    }
    const verifiedBeef = {
      findAtomicTransaction: jest.fn().mockReturnValue({
        verify: jest.fn().mockResolvedValue(true)
      }),
      findTxid: jest.fn().mockImplementation((txid: string) =>
        txid === txids[1]
          ? {
              tx: {
                inputs: [{ sourceTXID: sourceTxid }]
              }
            }
          : undefined
      ),
      mergeBeef: jest.fn(),
      mergeRawTx: jest.fn()
    }
    const scriptFailureBeef = {
      findAtomicTransaction: jest.fn().mockReturnValue({
        verify: jest.fn().mockResolvedValue(false)
      }),
      findTxid: jest.fn().mockReturnValue({
        tx: { inputs: [] }
      }),
      mergeBeef: jest.fn(),
      mergeRawTx: jest.fn()
    }
    mockState.beefFactory
      .mockReturnValueOnce(missingInputsBeef)
      .mockReturnValueOnce(verifiedBeef)
      .mockReturnValueOnce(scriptFailureBeef)
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletProofHistoryCommand.execute(
      new Map(),
      operatorPlan('wallet-proof-history', {
        mode: 'verify',
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        requestIds: '1,2,3'
      })
    )
    expect(evidence.result).toMatchObject({
      requested: 3,
      missingInputs: 1,
      scriptFailures: 1,
      verified: 1,
      missingRequests: 0
    })
    expect(verifiedBeef.mergeBeef).toHaveBeenCalledWith([9])
    expect(verifiedBeef.mergeBeef).toHaveBeenCalledWith([7, 8])
  })

  test('reviews and repairs one exact stale unknown transaction', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const txid = '99'.repeat(32)
    const storage = createStorage({
      findTransactions: jest.fn().mockResolvedValue([
        {
          transactionId: 31,
          txid,
          status: 'sending',
          updated_at: new Date('2020-01-01T00:00:00.000Z')
        }
      ]),
      updateTransactionStatus: jest.fn().mockResolvedValue(1),
      findTransactionById: jest.fn().mockResolvedValue({
        transactionId: 31,
        status: 'failed'
      })
    })
    const services = createServices({
      getStatusForTxids: jest.fn().mockResolvedValue({
        status: 'success',
        results: [{ txid, status: 'unknown' }]
      })
    })
    mockState.storageFactory.mockReturnValue(storage)
    mockState.servicesFactory.mockReturnValue(services)

    const evidence = await walletReconcileStuckCommand.execute(
      new Map(),
      operatorPlan('wallet-reconcile-stuck', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        status: 'sending',
        olderThanHours: 24,
        maxRecords: 10,
        exactTransaction: true,
        transactionId: 31,
        repair: true
      })
    )
    expect(evidence.result).toMatchObject({
      reviewed: 1,
      eligible: 1,
      markedFailed: 1,
      createdRequests: 0
    })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('failed', 31)
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('pages export candidates and records invalid instructions without mutation', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const query = queryReturning([{ outputId: 90 }])
    const storage = createStorage({
      findOutputById: jest.fn().mockResolvedValue(undefined),
      findUsers: jest
        .fn()
        .mockResolvedValueOnce([{ userId: 2, identityKey: `02${'11'.repeat(32)}` }])
        .mockResolvedValueOnce([{ userId: 3, identityKey: `03${'22'.repeat(32)}` }]),
      toDb: jest.fn().mockReturnValue(jest.fn().mockReturnValue(query))
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletReinternalizeExportsCommand.execute(
      new Map(),
      operatorPlan('wallet-reinternalize-exports', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        fromUserId: 2,
        toUserIds: '3',
        afterOutputId: 0,
        pageSize: 2,
        maxRecords: 10,
        internalize: false
      })
    )
    expect(evidence.result).toMatchObject({
      reviewed: 1,
      finalOutputId: 90,
      invalidInstructions: 1,
      internalized: 0
    })
    expect(storage.internalizeAction).not.toHaveBeenCalled()
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('counts unavailable external proofs across the bounded repair range', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage({
      findProvenTxs: jest.fn().mockResolvedValue([
        {
          provenTxId: 41,
          txid: 'aa'.repeat(32),
          merklePath: [1]
        }
      ])
    })
    const services = createServices({
      getMerklePath: jest.fn().mockResolvedValue({})
    })
    mockState.storageFactory.mockReturnValue(storage)
    mockState.servicesFactory.mockReturnValue(services)

    const evidence = await walletRepairProvenTransactionsCommand.execute(
      new Map(),
      operatorPlan('wallet-repair-proven-transactions', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        heightStart: 100,
        heightEnd: 100,
        maxRecords: 10,
        repair: false
      })
    )
    expect(evidence.result).toMatchObject({
      reviewed: 1,
      unavailable: 1,
      verified: 0,
      repaired: 0
    })
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('reviews one custom output as a verified UTXO without restoring it', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const query = queryReturning([{ outputId: 51 }])
    const storage = createStorage({
      findOutputById: jest.fn().mockResolvedValue({
        outputId: 51,
        txid: 'bb'.repeat(32),
        vout: 1,
        lockingScript: [0x51]
      }),
      toDb: jest.fn().mockReturnValue(jest.fn().mockReturnValue(query))
    })
    const services = createServices({
      getUtxoStatus: jest.fn().mockResolvedValue({
        status: 'success',
        isUtxo: true
      })
    })
    mockState.storageFactory.mockReturnValue(storage)
    mockState.servicesFactory.mockReturnValue(services)

    const evidence = await walletReviewCustomOutputsCommand.execute(
      new Map(),
      operatorPlan('wallet-review-custom-outputs', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        afterOutputId: 0,
        pageSize: 2,
        maxRecords: 10,
        restore: false
      })
    )
    expect(evidence.result).toMatchObject({
      reviewed: 1,
      verifiedUtxos: 1,
      restored: 0,
      finalOutputId: 51
    })
    expect(storage.updateOutput).not.toHaveBeenCalled()
  })

  test('aggregates invalid outputs across explicitly selected wallet users', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const storage = createStorage({
      findUsers: jest.fn().mockResolvedValue([{ userId: 61 }]),
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 2,
        outputs: [{ satoshis: 3 }, { satoshis: 5 }]
      })
    })
    mockState.storageFactory.mockReturnValue(storage)

    const evidence = await walletReviewOutputsCommand.execute(
      new Map(),
      operatorPlan('wallet-review-outputs', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        userIds: '61',
        scope: 'change',
        release: false
      })
    )
    expect(evidence.result).toMatchObject({
      reviewedUsers: 1,
      invalidOutputs: 2,
      invalidSatoshis: 8,
      release: false
    })
    expect(storage.listOutputs).toHaveBeenCalledWith(
      { userId: 61, identityKey: '' },
      expect.objectContaining({
        basket: 'invalid-change',
        tags: []
      })
    )
  })

  test('unfails only verified false-failure proof requests and verifies persistence', async () => {
    process.env.TEST_DATABASE = 'mysql'
    const request = {
      provenTxReqId: 71,
      txid: 'cc'.repeat(32),
      rawTx: [1, 2, 3]
    }
    const storage = createStorage({
      findProvenTxReqs: jest.fn().mockResolvedValue([request]),
      findProvenTxReqById: jest.fn().mockResolvedValue({
        ...request,
        status: 'unfail'
      }),
      updateProvenTxReq: jest.fn().mockResolvedValue(1)
    })
    const services = createServices({
      getStatusForTxids: jest.fn().mockResolvedValue({
        results: [{ txid: request.txid, status: 'mined' }]
      })
    })
    mockState.storageFactory.mockReturnValue(storage)
    mockState.servicesFactory.mockReturnValue(services)

    const evidence = await walletReviewProofRequestsCommand.execute(
      new Map(),
      operatorPlan('wallet-review-proof-requests', {
        chain: 'test',
        databaseEnvironment: 'TEST_DATABASE',
        whatsonchainApiKeyEnvironment: 'TEST_WOC',
        status: 'invalid',
        offset: 0,
        pageSize: 2,
        maxRecords: 10,
        unfail: true
      })
    )
    expect(evidence.result).toMatchObject({
      reviewed: 1,
      candidates: 1,
      unfail: true,
      updated: 1
    })
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith(71, { status: 'unfail' })
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })
})
