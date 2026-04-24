import { createSyncMap, sdk, SyncMap, TableCommission, TableTransaction } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityCommission } from '../EntityCommission'

describe('Commission class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('CommissionTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('CommissionTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('CommissionTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('CommissionTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })
  // Test: equals returns true for identical Commission entities
  test('0_equals identifies matching Commission entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Generate a unique transactionId
      const transactionId = 192

      // Insert the transaction to satisfy the foreign key constraint
      const now = new Date()
      const transactionData: TableTransaction = {
        transactionId,
        created_at: now,
        updated_at: now,
        userId: 1,
        txid: 'unique-txid',
        status: 'sending',
        reference: 'test-transaction',
        isOutgoing: false,
        satoshis: 1000,
        description: 'Test transaction'
      }

      await activeStorage.insertTransaction(transactionData)

      // Insert initial Commission record
      const initialData: TableCommission = {
        commissionId: 801,
        created_at: now,
        updated_at: now,
        transactionId,
        userId: 1,
        isRedeemed: false,
        keyOffset: 'offset123',
        lockingScript: [1, 2, 3],
        satoshis: 500
      }

      await activeStorage.insertCommission(initialData)

      // Create two Commission entities from the same data
      const entity1 = new EntityCommission(initialData)
      const entity2 = new EntityCommission(initialData)

      const syncMap = createSyncMap()
      syncMap.transaction.idMap[transactionId] = transactionId

      // Test: equals returns true for identical entities without SyncMap
      expect(entity1.equals(entity2.toApi())).toBe(true)

      // Test: equals returns true for identical entities with SyncMap
      expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
    }
  })

  // Test: equals identifies non-matching Commission entities
  test('1_equals identifies non-matching Commission entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Generate unique transactionIds
      const transactionId1 = 200
      const transactionId2 = 201

      // Insert the first transaction to satisfy the foreign key constraint
      const now = new Date()
      const transactionData1: TableTransaction = {
        transactionId: transactionId1,
        created_at: now,
        updated_at: now,
        userId: 1,
        txid: 'unique-txid-1',
        status: 'sending',
        reference: 'test-transaction-1',
        isOutgoing: false,
        satoshis: 1000,
        description: 'Test transaction 1'
      }
      await activeStorage.insertTransaction(transactionData1)

      // Insert the second transaction to satisfy the foreign key constraint for mismatched data
      const transactionData2: TableTransaction = {
        transactionId: transactionId2,
        created_at: now,
        updated_at: now,
        userId: 1,
        txid: 'unique-txid-2',
        status: 'sending',
        reference: 'test-transaction-2',
        isOutgoing: false,
        satoshis: 2000,
        description: 'Test transaction 2'
      }
      await activeStorage.insertTransaction(transactionData2)

      // Insert initial Commission record
      const initialData: TableCommission = {
        commissionId: 802,
        created_at: now,
        updated_at: now,
        transactionId: transactionId1,
        userId: 1,
        isRedeemed: false,
        keyOffset: 'offset123',
        lockingScript: [1, 2, 3],
        satoshis: 500
      }
      await activeStorage.insertCommission(initialData)

      // Create a Commission entity from the initial data
      const entity1 = new EntityCommission(initialData)

      // Create mismatched entities and test each condition
      const mismatchedEntities: Partial<TableCommission>[] = [
        { isRedeemed: true },
        { transactionId: transactionId2 }, // Requires valid transaction
        { keyOffset: 'offset456' },
        { lockingScript: [4, 5, 6] },
        { satoshis: 1000 }
      ]

      for (const mismatch of mismatchedEntities) {
        const mismatchedEntity = new EntityCommission({
          ...initialData,
          ...mismatch
        })
        expect(entity1.equals(mismatchedEntity.toApi())).toBe(false)

        const syncMap = createSyncMap()
        syncMap.transaction.idMap[transactionId1] = transactionId1
        syncMap.transaction.idMap[transactionId2] = transactionId2

        expect(entity1.equals(mismatchedEntity.toApi(), syncMap)).toBe(false)
      }
    }
  })

  // Test: mergeExisting updates entity and database when ei.updated_at > this.updated_at
  test('2_mergeExisting updates entity and database when ei.updated_at > this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Generate unique transactionId
      const transactionId = 203

      // Insert a valid transaction to satisfy foreign key constraints
      const now = new Date()
      const transactionData: TableTransaction = {
        transactionId,
        created_at: now,
        updated_at: now,
        userId: 1,
        txid: 'unique-txid',
        status: 'sending',
        reference: 'test-transaction-5',
        isOutgoing: false,
        satoshis: 1000,
        description: 'Test transaction'
      }
      await activeStorage.insertTransaction(transactionData)

      // Insert the initial Commission record
      const initialData: TableCommission = {
        commissionId: 803,
        created_at: now,
        updated_at: now,
        transactionId,
        userId: 1,
        isRedeemed: false,
        keyOffset: 'offset123',
        lockingScript: [1, 2, 3],
        satoshis: 500
      }
      await activeStorage.insertCommission(initialData)

      // Create a Commission entity from the initial data
      const entity = new EntityCommission(initialData)

      // Simulate the `ei` argument with a later `updated_at`
      const updatedData: TableCommission = {
        ...initialData,
        updated_at: new Date(now.getTime() + 1000),
        isRedeemed: true
      }

      const syncMap = createSyncMap()
      syncMap.transaction.idMap[transactionId] = transactionId

      // Call mergeExisting
      const wasMergedRaw = await entity.mergeExisting(
        activeStorage,
        undefined, // `since` is not used
        updatedData,
        syncMap,
        undefined // `trx` is not used
      )

      const wasMerged = Boolean(wasMergedRaw)

      // Verify that wasMerged is true
      expect(wasMerged).toBe(true)

      // Verify that the entity is updated
      expect(entity.isRedeemed).toBe(true)

      // Verify that the database is updated
      const updatedRecord = await activeStorage.findCommissions({
        partial: { commissionId: 803 }
      })
      expect(updatedRecord.length).toBe(1)
      expect(updatedRecord[0]).toBeDefined()
      expect(updatedRecord[0].isRedeemed).toBe(true)
    }
  })

  // Test: mergeExisting does not update when ei.updated_at <= this.updated_at
  test('3_mergeExisting does not update when ei.updated_at <= this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Generate unique transactionId
      const transactionId = 193

      // Insert a valid transaction to satisfy foreign key constraints
      const now = new Date()
      const transactionData: TableTransaction = {
        transactionId,
        created_at: now,
        updated_at: now,
        userId: 1,
        txid: 'unique-txid-193',
        status: 'sending',
        reference: 'test-transaction-6',
        isOutgoing: false,
        satoshis: 1000,
        description: 'Test transaction'
      }
      await activeStorage.insertTransaction(transactionData)

      // Insert the initial Commission record
      const initialData: TableCommission = {
        commissionId: 804,
        created_at: now,
        updated_at: now,
        transactionId,
        userId: 1,
        isRedeemed: false,
        keyOffset: 'offset123',
        lockingScript: [1, 2, 3],
        satoshis: 500
      }
      await activeStorage.insertCommission(initialData)

      // Create a Commission entity from the initial data
      const entity = new EntityCommission(initialData)

      // Simulate the `ei` argument with an earlier or equal `updated_at`
      const olderOrEqualData: TableCommission = {
        ...initialData,
        updated_at: new Date(now.getTime()),
        isRedeemed: true
      }

      const syncMap = createSyncMap()
      syncMap.transaction.idMap[transactionId] = transactionId

      // Call mergeExisting
      const wasMergedRaw = await entity.mergeExisting(
        activeStorage,
        undefined,
        olderOrEqualData,
        syncMap,
        undefined // `trx` is not used
      )

      const wasMerged = Boolean(wasMergedRaw)

      // Verify that wasMerged is false
      expect(wasMerged).toBe(false)

      // Verify that the entity is not updated
      expect(entity.isRedeemed).toBe(false)

      // Verify that the database is not updated
      const record = await activeStorage.findCommissions({
        partial: { commissionId: 802 }
      })
      expect(record.length).toBe(1)
      expect(record[0]).toBeDefined()
      expect(record[0].isRedeemed).toBe(false)
    }
  })

  // Test: Commission entity getters and setters
  test('4_Commission entity getters and setters', async () => {
    const now = new Date()

    // Initial test data
    const initialData: TableCommission = {
      commissionId: 801,
      created_at: now,
      updated_at: now,
      transactionId: 101,
      userId: 1,
      isRedeemed: false,
      keyOffset: 'offset123',
      lockingScript: [1, 2, 3],
      satoshis: 500
    }

    // Create the Commission entity
    const entity = new EntityCommission(initialData)

    // Validate getters
    expect(entity.commissionId).toBe(initialData.commissionId)
    expect(entity.created_at).toEqual(initialData.created_at)
    expect(entity.updated_at).toEqual(initialData.updated_at)
    expect(entity.transactionId).toBe(initialData.transactionId)
    expect(entity.userId).toBe(initialData.userId)
    expect(entity.isRedeemed).toBe(initialData.isRedeemed)
    expect(entity.keyOffset).toBe(initialData.keyOffset)
    expect(entity.lockingScript).toEqual(initialData.lockingScript)
    expect(entity.satoshis).toBe(initialData.satoshis)
    expect(entity.id).toBe(initialData.commissionId)
    expect(entity.entityName).toBe('commission')
    expect(entity.entityTable).toBe('commissions')

    // Validate setters
    entity.commissionId = 900
    entity.created_at = new Date('2024-01-01')
    entity.updated_at = new Date('2024-01-02')
    entity.transactionId = 202
    entity.userId = 2
    entity.isRedeemed = true
    entity.keyOffset = 'offset456'
    entity.lockingScript = [4, 5, 6]
    entity.satoshis = 1000
    entity.id = 900

    expect(entity.commissionId).toBe(900)
    expect(entity.created_at).toEqual(new Date('2024-01-01'))
    expect(entity.updated_at).toEqual(new Date('2024-01-02'))
    expect(entity.transactionId).toBe(202)
    expect(entity.userId).toBe(2)
    expect(entity.isRedeemed).toBe(true)
    expect(entity.keyOffset).toBe('offset456')
    expect(entity.lockingScript).toEqual([4, 5, 6])
    expect(entity.satoshis).toBe(1000)
    expect(entity.id).toBe(900)
  })
})
