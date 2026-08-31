import { randomUUID } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '../../Setup'
import { SetupClient } from '../../SetupClient'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider, StorageProviderOptions } from '../StorageProvider'
import {
  TableOutput,
  TableOutputBasket,
  TableProvenTx,
  TableProvenTxReq,
  TableSyncState,
  TableTransaction,
  TableUser
} from '../schema/tables'
import { TableActionBatch } from '../schema/tables/TableActionBatch'
import { StorageIdbSchema } from '../schema/StorageIdbSchema'
import { openDB } from 'idb'
import 'fake-indexeddb/auto'
import { createSyncMap } from '../schema/entities'

describe('StorageIdb tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions('main')
    const storage = new StorageIdb(options)
    await resetStorage(storage)
    try {
      const r = await storage.migrate(`storageIdbTest-${Date.now()}`, '42'.repeat(32))
      const db = storage.db
      expect(r).toBe('5')
      expect(db).toBeTruthy()
      expect(db?.transaction('outputs').objectStore('outputs').indexNames.contains('userId_basketId')).toBe(true)
      expect(db?.transaction('outputs').objectStore('outputs').indexNames.contains('txid_vout_userId')).toBe(true)
      expect(db?.transaction('transactions').objectStore('transactions')
        .indexNames.contains('noSendExpiryState')).toBe(true)
      expect(db?.transaction('transactions').objectStore('transactions')
        .indexNames.contains('noSendExpiryReclaimTxid')).toBe(true)
      expect(db?.transaction('certificates').objectStore('certificates')
        .indexNames.contains('userId_basketId')).toBe(false)
    } finally {
      await resetStorage(storage)
    }
  })

  test('upgrades a version 2 outputs store with the funding compound index', async () => {
    const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions('main')
    const storage = new StorageIdb(options)
    storage.dbName = `storageIdbUpgrade-${randomUUID()}`
    const legacy = await openDB<StorageIdbSchema>(storage.dbName, 2, {
      upgrade (db) {
        const outputs = db.createObjectStore('outputs', { keyPath: 'outputId', autoIncrement: true })
        outputs.createIndex('userId', 'userId')
        outputs.createIndex('transactionId', 'transactionId')
        outputs.createIndex('basketId', 'basketId')
        outputs.createIndex('spentBy', 'spentBy')
        outputs.createIndex('transactionId_vout_userId', ['transactionId', 'vout', 'userId'], { unique: true })
      }
    })
    legacy.close()

    try {
      const upgraded = await storage.initDB('version 2 upgrade test', '42'.repeat(32))
      expect(upgraded.version).toBe(5)
      expect(upgraded.transaction('outputs').objectStore('outputs')
        .indexNames.contains('userId_basketId')).toBe(true)
      expect(upgraded.transaction('outputs').objectStore('outputs')
        .indexNames.contains('txid_vout_userId')).toBe(true)
      expect(upgraded.transaction('transactions').objectStore('transactions')
        .indexNames.contains('noSendExpiryState')).toBe(true)
      expect(upgraded.transaction('transactions').objectStore('transactions')
        .indexNames.contains('noSendExpiryReclaimTxid')).toBe(true)
      upgraded.close()
    } finally {
      await resetStorage(storage)
    }
  })

  test('funding candidates exclude invalid source statuses and active batch reservations', async () => {
    const storage = await makeStorage()
    try {
      const userId = await insertUser(storage)
      const basketId = await insertBasket(storage, userId)
      const availableTxId = await insertTransaction(storage, userId, {
        status: 'completed', txid: '11'.repeat(32)
      })
      const reservedTxId = await insertTransaction(storage, userId, {
        status: 'completed', txid: '12'.repeat(32)
      })
      const failedTxId = await insertTransaction(storage, userId, {
        status: 'failed', txid: '13'.repeat(32)
      })
      const availableOutputId = await insertOutput(storage, userId, availableTxId, basketId, {
        txid: '11'.repeat(32), satoshis: 100
      })
      const reservedOutputId = await insertOutput(storage, userId, reservedTxId, basketId, {
        txid: '12'.repeat(32), satoshis: 200
      })
      await insertOutput(storage, userId, failedTxId, basketId, {
        txid: '13'.repeat(32), satoshis: 300
      })
      const batch = makeActionBatch(userId, 'funding-candidate-reservation')
      await storage.insertActionBatch(batch)
      const now = new Date()
      await storage.reserveActionBatchOutputs([{
        actionBatchId: batch.actionBatchId,
        outputId: reservedOutputId,
        created_at: now,
        updated_at: now
      }])

      const available = await storage.findAvailableManagedChangeInputs(userId, basketId, true)
      expect(available.map(output => output.outputId)).toEqual([availableOutputId])
      await expect(storage.countChangeInputs(userId, basketId, true)).resolves.toBe(1)
    } finally {
      await resetStorage(storage)
    }
  })

  test('migrates only untouched legacy managed-change defaults', async () => {
    const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions('main')
    const storage = new StorageIdb(options)
    storage.dbName = `storageIdbManagedChangeUpgrade-${randomUUID()}`
    await storage.migrate('managed change migration', '42'.repeat(32))
    const userId = await insertUser(storage)
    const customMinimumUserId = await insertUser(storage, '03'.repeat(33))
    const customTargetUserId = await insertUser(storage, '04'.repeat(33))
    const now = new Date()
    const insert = async (basketUserId: number, name: string, target: number, minimum: number): Promise<number> => await storage.insertOutputBasket({
      basketId: 0,
      userId: basketUserId,
      name,
      numberOfDesiredUTXOs: target,
      minimumDesiredUTXOValue: minimum,
      isDeleted: false,
      created_at: now,
      updated_at: now
    })
    const untouchedId = await insert(userId, 'default', 144, 32)
    const customizedMinimumId = await insert(customMinimumUserId, 'default', 144, 64)
    const customizedTargetId = await insert(customTargetUserId, 'default', 100, 32)
    await storage.destroy()

    const reopened = new StorageIdb(options)
    reopened.dbName = storage.dbName
    try {
      await reopened.migrate('managed change migration', '42'.repeat(32))
      const baskets = await reopened.findOutputBaskets({ partial: {} })
      const byId = new Map(baskets.map(basket => [basket.basketId, basket]))
      expect(byId.get(untouchedId)?.minimumDesiredUTXOValue).toBe(5_000)
      expect(byId.get(customizedMinimumId)?.minimumDesiredUTXOValue).toBe(64)
      expect(byId.get(customizedTargetId)?.minimumDesiredUTXOValue).toBe(32)
    } finally {
      await resetStorage(reopened)
    }
  })

  test('batches user-scoped transaction statuses and indexed outpoint reads', async () => {
    const storage = await makeStorage()
    try {
      const userId = await insertUser(storage)
      const otherUserId = await insertUser(storage, '03'.repeat(33))
      const basketId = await insertBasket(storage, userId)
      const txid = '14'.repeat(32)
      const transactionId = await insertTransaction(storage, userId, { status: 'completed', txid })
      const otherTransactionId = await insertTransaction(storage, otherUserId, {
        status: 'unproven', txid: '15'.repeat(32)
      })
      const outputId = await insertOutput(storage, userId, transactionId, basketId, { txid, satoshis: 400 })

      await expect(storage.findTransactionStatusesByIds(userId, [])).resolves.toEqual(new Map())
      const statuses = await storage.findTransactionStatusesByIds(
        userId,
        [transactionId, transactionId, otherTransactionId, 999_999]
      )
      expect([...statuses.entries()]).toEqual([[transactionId, 'completed']])
      await expect(storage.findOutputsByOutpoints(userId, [])).resolves.toEqual({})

      const outpoint = { txid, vout: 0 }
      const found = await storage.findOutputsByOutpoints(userId, [outpoint, outpoint, { txid: 'ff'.repeat(32), vout: 1 }])
      expect(found[`${txid}.0`]?.outputId).toBe(outputId)

      await storage.transaction(async trx => {
        const inTransactionStatuses = await storage.findTransactionStatusesByIds(userId, [transactionId], trx)
        expect(inTransactionStatuses.get(transactionId)).toBe('completed')
        const locked = await storage.findOutputsByOutpointsForUpdate(userId, [outpoint], trx, true)
        expect(locked[`${txid}.0`]?.outputId).toBe(outputId)
      })
    } finally {
      await resetStorage(storage)
    }
  })

  test('atomically compares and sets BRC-177 expiry state', async () => {
    const storage = await makeStorage()
    try {
      const userId = await insertUser(storage)
      const transactionId = await insertTransaction(storage, userId, {
        status: 'nosend',
        txid: '16'.repeat(32)
      })
      await storage.updateTransaction(transactionId, { noSendExpiryState: 'signed' })

      const contenders = await Promise.all([
        storage.compareAndSetNoSendExpiryState(transactionId, 'signed', 'reclaiming'),
        storage.compareAndSetNoSendExpiryState(transactionId, 'signed', 'reclaiming')
      ])
      expect(contenders.filter(Boolean)).toHaveLength(1)
      await expect(storage.compareAndSetNoSendExpiryState(transactionId, 'signed', 'conflicted')).resolves.toBe(false)
      const [transaction] = await storage.findTransactions({ partial: { transactionId } })
      expect(transaction.noSendExpiryState).toBe('reclaiming')
    } finally {
      await resetStorage(storage)
    }
  })

  test('processes an entire sync page in one IndexedDB transaction', async () => {
    const storage = await makeStorage()
    try {
      const identityKey = '05'.repeat(33)
      const userId = await insertUser(storage, identityKey)
      const now = new Date()
      const syncState: TableSyncState = {
        syncStateId: 0,
        userId,
        storageIdentityKey: 'from-storage',
        storageName: 'remote source',
        status: 'unknown',
        init: true,
        refNum: 'atomic-sync-page',
        syncMap: JSON.stringify(createSyncMap()),
        created_at: now,
        updated_at: now
      }
      await storage.insertSyncState(syncState)
      const transaction = jest.spyOn(storage, 'transaction')
      const transactions: TableTransaction[] = Array.from({ length: 300 }, (_, index) => ({
        transactionId: index + 1,
        userId: 999,
        status: 'completed',
        reference: Buffer.from(`synced-transaction-${index}`).toString('base64'),
        isOutgoing: true,
        satoshis: index,
        description: `synced transaction ${index}`,
        txid: (index + 1).toString(16).padStart(64, '0'),
        created_at: now,
        updated_at: now
      }))

      const result = await storage.processSyncChunk({
        identityKey,
        maxRoughSize: 20_000_000,
        maxItems: 1000,
        offsets: [],
        since: undefined,
        fromStorageIdentityKey: 'from-storage',
        toStorageIdentityKey: 'to-storage'
      }, {
        fromStorageIdentityKey: 'from-storage',
        toStorageIdentityKey: 'to-storage',
        userIdentityKey: identityKey,
        provenTxs: [],
        provenTxReqs: [],
        outputBaskets: [],
        txLabels: [],
        outputTags: [],
        transactions,
        txLabelMaps: [],
        commissions: [],
        outputs: [],
        outputTagMaps: [],
        certificates: [],
        certificateFields: []
      })

      expect(transaction).toHaveBeenCalledTimes(1)
      expect(result.inserts).toBe(transactions.length)
      await expect(storage.countTransactions({ partial: { userId } })).resolves.toBe(transactions.length)
    } finally {
      await resetStorage(storage)
    }
  })

  test('preserves the original error when aborting an IndexedDB transaction', async () => {
    const storage = await makeStorage()
    try {
      const identityKey = '06'.repeat(33)
      const originalError = new Error('original transaction failure')
      const now = new Date()

      await expect(storage.transaction(async trx => {
        await storage.insertUser({
          userId: 0,
          identityKey,
          activeStorage: '42'.repeat(32),
          created_at: now,
          updated_at: now
        }, trx)
        throw originalError
      })).rejects.toBe(originalError)

      await expect(storage.findUserByIdentityKey(identityKey)).resolves.toBeUndefined()
    } finally {
      await resetStorage(storage)
    }
  })

  test('batch-loads proven, usable raw, and missing transaction records', async () => {
    const storage = await makeStorage()
    try {
      const now = new Date()
      const provenTxid = '16'.repeat(32)
      const rawTxid = '17'.repeat(32)
      const rawWithoutBeefTxid = '18'.repeat(32)
      const unusableTxid = '19'.repeat(32)
      const proven: TableProvenTx = {
        provenTxId: 0,
        txid: provenTxid,
        height: 900_000,
        index: 0,
        merklePath: [1, 2, 3],
        rawTx: [4, 5, 6],
        blockHash: '20'.repeat(32),
        merkleRoot: '21'.repeat(32),
        created_at: now,
        updated_at: now
      }
      const request = (txid: string, status: TableProvenTxReq['status'], inputBEEF?: number[]): TableProvenTxReq => ({
        provenTxReqId: 0,
        txid,
        status,
        attempts: 0,
        notified: false,
        history: '{}',
        notify: '{}',
        rawTx: [7, 8, 9],
        inputBEEF,
        created_at: now,
        updated_at: now
      })
      await storage.insertProvenTx(proven)
      await storage.insertProvenTxReq(request(rawTxid, 'nosend', [10, 11]))
      await storage.insertProvenTxReq(request(rawWithoutBeefTxid, 'unmined'))
      await storage.insertProvenTxReq(request(unusableTxid, 'invalid', [12]))

      await expect(storage.getProvenOrRawTxs([])).resolves.toEqual(new Map())
      const result = await storage.getProvenOrRawTxs([
        provenTxid,
        rawTxid,
        rawWithoutBeefTxid,
        unusableTxid,
        'ff'.repeat(32),
        provenTxid
      ])

      expect(result.get(provenTxid)?.proven?.txid).toBe(provenTxid)
      expect(result.get(rawTxid)).toEqual({ proven: undefined, rawTx: [7, 8, 9], inputBEEF: [10, 11] })
      expect(result.get(rawWithoutBeefTxid)).toEqual({ proven: undefined, rawTx: [7, 8, 9], inputBEEF: undefined })
      expect(result.get(unusableTxid)).toEqual({ proven: undefined, rawTx: undefined, inputBEEF: undefined })
      expect(result.get('ff'.repeat(32))).toEqual({ proven: undefined, rawTx: undefined, inputBEEF: undefined })

      await storage.transaction(async trx => {
        const inTransaction = await storage.getProvenOrRawTxs([provenTxid], trx)
        expect(inTransaction.get(provenTxid)?.proven?.txid).toBe(provenTxid)
      })
    } finally {
      await resetStorage(storage)
    }
  })

  test('reviewStatus releases outputs reserved by failed transactions', async () => {
    const storage = await makeStorage()
    try {
      const { userId, basketId, outputId } = await seedSpendableOutputHeldByFailedTx(storage)

      const review = await storage.reviewStatus({ agedLimit: new Date(0) })
      const outputs = await storage.findOutputs({ partial: { userId, basketId }, noScript: true })

      expect(review.log).toContain(`output ${outputId} updated to spendable because spentBy is failed`)
      expect(outputs).toHaveLength(1)
      expect(outputs[0].spendable).toBe(true)
      expect(outputs[0].spentBy).toBeUndefined()
    } finally {
      await resetStorage(storage)
    }
  })

  test('allocateChangeInput ignores spendable outputs that are still held by another transaction', async () => {
    const storage = await makeStorage()
    try {
      const { userId, basketId, holderTxId } = await seedSpendableOutputHeldByFailedTx(storage)
      const cleanTxId = await insertTransaction(storage, userId, { status: 'completed', txid: '02'.repeat(32) })
      const cleanOutputId = await insertOutput(storage, userId, cleanTxId, basketId, {
        txid: '02'.repeat(32),
        satoshis: 500
      })
      const newTxId = await insertTransaction(storage, userId, { status: 'unsigned', txid: '03'.repeat(32) })

      const allocated = await storage.allocateChangeInput(userId, basketId, 200, undefined, true, newTxId)
      const lockedOutputs = await storage.findOutputs({ partial: { userId }, noScript: true })
      const staleOutput = lockedOutputs.find(o => o.spentBy === holderTxId)

      expect(allocated?.outputId).toBe(cleanOutputId)
      expect(allocated?.spentBy).toBeUndefined()
      expect(staleOutput?.satoshis).toBe(300)
      expect(staleOutput?.spendable).toBe(true)
    } finally {
      await resetStorage(storage)
    }
  })

  test('sumSpendableSatoshisInBasket excludes outputs that still have spentBy set', async () => {
    const storage = await makeStorage()
    try {
      const { userId, basketId } = await seedSpendableOutputHeldByFailedTx(storage)
      const cleanTxId = await insertTransaction(storage, userId, { status: 'completed', txid: '04'.repeat(32) })
      await insertOutput(storage, userId, cleanTxId, basketId, {
        txid: '04'.repeat(32),
        satoshis: 700
      })

      const total = await storage.sumSpendableSatoshisInBasket(userId, basketId, true)

      expect(total).toBe(700)
    } finally {
      await resetStorage(storage)
    }
  })

  test('action batch stores enforce unique output reservations and retain blobs', async () => {
    const storage = await makeStorage()
    try {
      const userId = await insertUser(storage)
      const basketId = await insertBasket(storage, userId)
      const transactionId = await insertTransaction(storage, userId, { status: 'completed', txid: '06'.repeat(32) })
      const outputId = await insertOutput(storage, userId, transactionId, basketId, {
        txid: '06'.repeat(32), satoshis: 100
      })
      const first = makeActionBatch(userId, 'idb-action-batch-1')
      const second = makeActionBatch(userId, 'idb-action-batch-2')
      await storage.insertActionBatch(first)
      await storage.insertActionBatch(second)
      expect(first.actionBatchId).not.toBe(second.actionBatchId)

      const now = new Date()
      await storage.reserveActionBatchOutputs([{
        actionBatchId: first.actionBatchId, outputId, created_at: now, updated_at: now
      }])
      expect(await storage.findReservedActionBatchOutputIds([outputId])).toEqual([outputId])
      await storage.putActionBatchBlobRecord({
        actionBatchBlobId: 0,
        actionBatchId: first.actionBatchId,
        digest: '07'.repeat(32),
        bytes: [1, 2, 3],
        created_at: now,
        updated_at: now
      })
      const storedBlob = await storage.findActionBatchBlobRecord(first.actionBatchId, '07'.repeat(32))
      expect(storedBlob?.bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(storedBlob?.bytes ?? [])).toEqual([1, 2, 3])
    } finally {
      await resetStorage(storage)
    }
  })

  test('action batch ids are unique within a user, not across users', async () => {
    const storage = await makeStorage()
    try {
      const firstUserId = await insertUser(storage)
      const secondUserId = await insertUser(storage, '03'.repeat(33))
      const first = makeActionBatch(firstUserId, 'shared-batch-id')
      const second = makeActionBatch(secondUserId, 'shared-batch-id')
      await storage.insertActionBatch(first)
      await storage.insertActionBatch(second)

      expect(await storage.findActionBatch(firstUserId, first.batchId)).toMatchObject({ userId: firstUserId })
      expect(await storage.findActionBatch(secondUserId, second.batchId)).toMatchObject({ userId: secondUserId })
    } finally {
      await resetStorage(storage)
    }
  })

  test.skip('1', async () => {
    // Final QA issue #400; owner: wallet-maintainers; review by 2026-10-27.
    // The isolated case passes but the full suite retains an IndexedDB handle.
    if (Setup.noEnv('test')) return
    const env = Setup.getEnv('test')
    const wallet = await SetupClient.createWalletClientNoEnv({
      chain: env.chain,
      rootKeyHex: env.devKeys[env.identityKey]
    })
    const stores = wallet.storage.getStores()
    const options = StorageIdb.createStorageBaseOptions(wallet.chain)
    const store = new StorageIdb(options)
    await store.migrate(store.dbName, PrivateKey.fromRandom().toHex())
    await store.makeAvailable()
    await wallet.storage.addWalletStorageProvider(store)
    expect(wallet.storage.getStores()).toHaveLength(stores.length + 1)
    const setActiveLog = await wallet.storage.setActive(stores[0].storageIdentityKey, s => {
      console.log(s)
      return s
    })
    const backupLog = await wallet.storage.updateBackups(undefined, s => {
      console.log(s)
      return s
    })
    expect(wallet.storage.getActiveStore()).toBe(stores[0].storageIdentityKey)
    expect(setActiveLog).toContain('unchanged')
    expect(backupLog).toContain('BACKUP CURRENT ACTIVE')
    await wallet.destroy()
  })
})

async function makeStorage (): Promise<StorageIdb> {
  const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions('main')
  const storage = new StorageIdb(options)
  await resetStorage(storage)
  await storage.migrate(`storageIdbTest-${Date.now()}-${randomUUID()}`, '42'.repeat(32))
  await storage.makeAvailable()
  return storage
}

async function resetStorage (storage: StorageIdb): Promise<void> {
  await storage.destroy()
  await storage.dropAllData()
}

async function seedSpendableOutputHeldByFailedTx (
  storage: StorageIdb
): Promise<{ userId: number, basketId: number, holderTxId: number, outputId: number }> {
  const userId = await insertUser(storage)
  const basketId = await insertBasket(storage, userId)
  const sourceTxId = await insertTransaction(storage, userId, { status: 'completed', txid: '01'.repeat(32) })
  const holderTxId = await insertTransaction(storage, userId, { status: 'failed', txid: '05'.repeat(32) })
  const outputId = await insertOutput(storage, userId, sourceTxId, basketId, {
    txid: '01'.repeat(32),
    satoshis: 300,
    spentBy: holderTxId
  })
  return { userId, basketId, holderTxId, outputId }
}

async function insertUser (storage: StorageIdb, identityKey = '02'.repeat(33)): Promise<number> {
  const now = new Date()
  const user: TableUser = {
    created_at: now,
    updated_at: now,
    userId: 0,
    identityKey,
    activeStorage: '42'.repeat(32)
  }
  return await storage.insertUser(user)
}

function makeActionBatch (userId: number, batchId: string): TableActionBatch {
  const now = new Date()
  return {
    actionBatchId: 0,
    userId,
    batchId,
    status: 'active',
    expiresAt: new Date(now.getTime() + 60_000),
    hardExpiresAt: new Date(now.getTime() + 120_000),
    created_at: now,
    updated_at: now
  }
}

async function insertBasket (storage: StorageIdb, userId: number): Promise<number> {
  const now = new Date()
  const basket: TableOutputBasket = {
    created_at: now,
    updated_at: now,
    basketId: 0,
    userId,
    name: 'default',
    numberOfDesiredUTXOs: 32,
    minimumDesiredUTXOValue: 1,
    isDeleted: false
  }
  return await storage.insertOutputBasket(basket)
}

async function insertTransaction (
  storage: StorageIdb,
  userId: number,
  partial: Pick<TableTransaction, 'status' | 'txid'>
): Promise<number> {
  const now = new Date()
  const transaction: TableTransaction = {
    created_at: now,
    updated_at: now,
    transactionId: 0,
    userId,
    status: partial.status,
    reference: RandomDefault.reference(),
    isOutgoing: true,
    satoshis: 0,
    description: 'storage state test transaction',
    txid: partial.txid
  }
  return await storage.insertTransaction(transaction)
}

async function insertOutput (
  storage: StorageIdb,
  userId: number,
  transactionId: number,
  basketId: number,
  partial: Pick<TableOutput, 'txid' | 'satoshis'> & Pick<Partial<TableOutput>, 'spentBy'>
): Promise<number> {
  const now = new Date()
  const output: TableOutput = {
    created_at: now,
    updated_at: now,
    outputId: 0,
    userId,
    transactionId,
    basketId,
    spendable: true,
    change: true,
    outputDescription: 'Test Output',
    vout: 0,
    satoshis: partial.satoshis,
    providedBy: 'storage',
    purpose: 'change',
    type: 'P2PKH',
    txid: partial.txid,
    derivationPrefix: RandomDefault.reference(),
    derivationSuffix: RandomDefault.reference(),
    spentBy: partial.spentBy,
    lockingScript: [0x51],
    scriptLength: 1,
    scriptOffset: 0
  }
  return await storage.insertOutput(output)
}

const RandomDefault = {
  counter: 0,
  reference (): string {
    this.counter++
    return Buffer.from(`storage-test-reference-${this.counter}`).toString('base64')
  }
}
