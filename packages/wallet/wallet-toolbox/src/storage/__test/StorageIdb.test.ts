import { randomUUID } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '../../Setup'
import { SetupClient } from '../../SetupClient'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider, StorageProviderOptions } from '../StorageProvider'
import { TableOutput, TableOutputBasket, TableTransaction, TableUser } from '../schema/tables'
import { TableActionBatch } from '../schema/tables/TableActionBatch'
import 'fake-indexeddb/auto'

describe('StorageIdb tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions('main')
    const storage = new StorageIdb(options)
    await resetStorage(storage)
    try {
      const r = await storage.migrate(`storageIdbTest-${Date.now()}`, '42'.repeat(32))
      const db = storage.db
      expect(r).toBe('2')
      expect(db).toBeTruthy()
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
