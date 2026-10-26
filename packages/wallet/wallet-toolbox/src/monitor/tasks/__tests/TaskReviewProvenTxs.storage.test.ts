import { randomUUID } from 'node:crypto'
import { knex } from 'knex'
import { deleteDB } from 'idb'
import 'fake-indexeddb/auto'
import { StorageKnex } from '../../../storage/StorageKnex'
import { StorageIdb } from '../../../storage/StorageIdb'
import { StorageProvider } from '../../../storage/StorageProvider'
import { WalletStorageManager } from '../../../storage/WalletStorageManager'
import { Monitor, MonitorOptions } from '../../Monitor'
import { TaskReviewProvenTxs } from '../TaskReviewProvenTxs'

const root = 'ab'.repeat(32)
const identity = `02${'11'.repeat(32)}`

async function open(kind: string): Promise<StorageProvider> {
  const provider =
    kind === 'sqlite'
      ? new StorageKnex({
          ...StorageKnex.defaultOptions(),
          chain: 'main',
          knex: knex({
            client: 'better-sqlite3',
            connection: { filename: ':memory:' },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 }
          })
        })
      : new StorageIdb(StorageProvider.createStorageBaseOptions('main'))
  if (provider instanceof StorageIdb) provider.dbName = `review-proof-${randomUUID()}`
  await provider.migrate('Proof review checkpoint fixture', '42'.repeat(32))
  return provider
}

async function insert(provider: StorageProvider, height: number, id: number): Promise<void> {
  await provider.insertProvenTx({
    provenTxId: 0,
    created_at: new Date(),
    updated_at: new Date(),
    txid: id.toString(16).padStart(64, '0'),
    height,
    index: 0,
    merklePath: [0],
    rawTx: [0],
    blockHash: 'cd'.repeat(32),
    merkleRoot: root
  })
}

function monitor(storage: WalletStorageManager, tipHeight = 971500): Monitor {
  const result = new Monitor({
    chain: 'main',
    storage,
    services: { chain: 'main' },
    chaintracks: {
      currentHeight: async () => tipHeight,
      findHeaderForHeight: async (height: number) => ({ height, merkleRoot: root })
    },
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 0,
    unprovenAttemptsLimitTest: 0,
    unprovenAttemptsLimitMain: 0,
    maxRebroadcastAttempts: 0
  } as unknown as MonitorOptions)
  result.addTask(new TaskReviewProvenTxs(result, 0, 100, 100, 1))
  return result
}

async function checkpoint(provider: StorageProvider): Promise<Record<string, unknown> | undefined> {
  const events = await provider.findMonitorEvents({
    partial: { event: 'ReviewProvenTxs' },
    orderDescending: true,
    paged: { limit: 1 }
  })
  return events[0]?.details === undefined ? undefined : JSON.parse(events[0].details)
}

describe.each(['sqlite', 'indexeddb'])(
  'proof audit checkpoint through actual %s storage and Monitor scheduler',
  kind => {
    let provider: StorageProvider
    let storage: WalletStorageManager
    beforeEach(async () => {
      provider = await open(kind)
      storage = new WalletStorageManager(identity, provider)
      await storage.makeAvailable()
    })
    afterEach(async () => {
      await storage.destroy()
      if (provider instanceof StorageIdb) await deleteDB(provider.dbName)
    })

    test('empty startup leaves no checkpoint, then a restarted Monitor begins at the minimum height despite insertion order', async () => {
      await monitor(storage).runOnce()
      expect(await checkpoint(provider)).toBeUndefined()
      await insert(provider, 971225, 1)
      await insert(provider, 971200, 2)
      expect(await provider.getProvenTxsReviewStartHeight()).toBe(971200)
      expect(await StorageProvider.prototype.getProvenTxsReviewStartHeight.call(provider)).toBe(0)
      await monitor(storage).runOnce()
      expect(await checkpoint(provider)).toMatchObject({ startHeight: 971200, reviewedThroughHeight: 971299 })
      await monitor(storage).runOnce()
      expect(await checkpoint(provider)).toMatchObject({ startHeight: 971300, reviewedThroughHeight: 971399 })
    })

    test('an existing empty-prefix checkpoint is repaired and its old retry survives the actual event persistence path', async () => {
      await provider.insertMonitorEvent({
        id: 0,
        created_at: new Date(),
        updated_at: new Date(),
        event: 'ReviewProvenTxs',
        details: JSON.stringify({ reviewedThroughHeight: 99, retryHeights: [17] })
      })
      await insert(provider, 971225, 1)
      await monitor(storage).runOnce()
      expect(await checkpoint(provider)).toMatchObject({
        startHeight: 971225,
        reviewedThroughHeight: 971324,
        retryHeights: [],
        reviewedHeights: 101
      })
    })

    test('a minimum proof newer than the age window does not create a premature checkpoint', async () => {
      await insert(provider, 971450, 1)
      await monitor(storage).runOnce()
      expect(await checkpoint(provider)).toBeUndefined()
      await monitor(storage, 971550).runOnce()
      expect(await checkpoint(provider)).toMatchObject({ startHeight: 971450, reviewedThroughHeight: 971450 })
    })
  }
)
