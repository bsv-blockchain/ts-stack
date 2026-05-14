import { createSyncMap, sdk, SyncMap, TableOutputBasket } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityOutputBasket } from '../EntityOutputBasket'

describe('OutputBasket class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('OutputBasketTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('OutputBasketTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('OutputBasketTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('OutputBasketTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  test('1_mergeExisting merges and updates entity when ei.updated_at > this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputBasket record with valid data
    const initialData: TableOutputBasket = {
      basketId: 100,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Basket1',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 5000,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputBasket(initialData)

    // Create an OutputBasket entity from the initial data
    const entity = new EntityOutputBasket(initialData)

    // Simulate the `ei` argument with a later `updated_at`
    const updatedData: TableOutputBasket = {
      ...initialData,
      updated_at: new Date('2023-01-03'), // Later timestamp
      numberOfDesiredUTXOs: 20, // Update this field
      minimumDesiredUTXOValue: 10000, // Update this field
      isDeleted: true // Simulate a change in `isDeleted`
    }

    const syncMap = createSyncMap()
    syncMap.outputBasket.idMap[100] = 100

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      updatedData,
      syncMap,
      undefined // `trx` is not used
    )

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is true
    expect(wasMerged).toBe(true)

    // Verify that the entity is updated
    expect(entity.numberOfDesiredUTXOs).toBe(20)
    expect(entity.minimumDesiredUTXOValue).toBe(10000)
    expect(entity.isDeleted).toBe(1)

    // Verify that the database is updated
    const updatedRecord = await ctx.activeStorage.findOutputBaskets({
      partial: { basketId: 100 }
    })
    expect(updatedRecord.length).toBe(1)
    expect(updatedRecord[0]).toBeDefined() // Ensure record exists
    expect(updatedRecord[0].numberOfDesiredUTXOs).toBe(20)
    expect(updatedRecord[0].minimumDesiredUTXOValue).toBe(10000)
    expect(updatedRecord[0].isDeleted).toBe(true)
  })

  test('2_mergeExisting does not merge when ei.updated_at <= this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputBasket record with valid data
    const initialData: TableOutputBasket = {
      basketId: 200,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Basket2',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 5000,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputBasket(initialData)

    // Create an OutputBasket entity from the initial data
    const entity = new EntityOutputBasket(initialData)

    // Simulate the `ei` argument with an earlier `updated_at`
    const earlierData: TableOutputBasket = {
      ...initialData,
      updated_at: new Date('2023-01-01'), // Earlier timestamp
      numberOfDesiredUTXOs: 20, // Simulate a change
      minimumDesiredUTXOValue: 10000, // Simulate a change
      isDeleted: true // Simulate a change
    }

    const syncMap = createSyncMap()
    syncMap.outputBasket.idMap[200] = 200

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      earlierData,
      syncMap,
      undefined // `trx` is not used
    )

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is false
    expect(wasMerged).toBe(false)

    // Verify that the entity is not updated
    expect(entity.numberOfDesiredUTXOs).toBe(10)
    expect(entity.minimumDesiredUTXOValue).toBe(5000)
    expect(entity.isDeleted).toBe(0)

    // Verify that the database is not updated
    const updatedRecord = await ctx.activeStorage.findOutputBaskets({
      partial: { basketId: 200 }
    })
    expect(updatedRecord.length).toBe(1)
    expect(updatedRecord[0]).toBeDefined() // Ensure record exists
    expect(updatedRecord[0].numberOfDesiredUTXOs).toBe(10)
    expect(updatedRecord[0].minimumDesiredUTXOValue).toBe(5000)
    expect(updatedRecord[0].isDeleted).toBe(false)
  })

  test('equals identifies matching entities with and without SyncMap', async () => {
    const ctx = ctxs[0]

    // Insert two identical OutputBasket records in the database
    const basketData: TableOutputBasket = {
      basketId: 401,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Test Basket',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 1000,
      isDeleted: false
    }

    await ctx.activeStorage.insertOutputBasket(basketData)

    // Create two identical entities
    const entity1 = new EntityOutputBasket(basketData)
    const entity2 = new EntityOutputBasket(basketData)

    // Test: equals returns true for identical entities without SyncMap
    expect(entity1.equals(entity2.toApi())).toBe(true)

    const syncMap = createSyncMap()
    syncMap.outputBasket.idMap[401] = 401

    // Test: equals returns true for identical entities with SyncMap
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
  })

  test('equals identifies non-matching entities', async () => {
    const ctx = ctxs[0]

    // Insert two different OutputBasket records in the database
    const basketData1: TableOutputBasket = {
      basketId: 402,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Test Basket 1',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 1000,
      isDeleted: false
    }

    const basketData2: TableOutputBasket = {
      basketId: 403,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Test Basket 2',
      numberOfDesiredUTXOs: 5,
      minimumDesiredUTXOValue: 500,
      isDeleted: true
    }

    await ctx.activeStorage.insertOutputBasket(basketData1)
    await ctx.activeStorage.insertOutputBasket(basketData2)

    // Create entities
    const entity1 = new EntityOutputBasket(basketData1)
    const entity2 = new EntityOutputBasket(basketData2)

    // Test: equals returns false for different entities without SyncMap
    expect(entity1.equals(entity2.toApi())).toBe(false)

    const syncMap = createSyncMap()
    syncMap.outputBasket.idMap[1] = 2

    // Test: equals returns false for different entities with SyncMap
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(false)
  })

  test('OutputBasket getters, setters, and updateApi', () => {
    // Create a mock OutputBasket instance
    const initialData: TableOutputBasket = {
      basketId: 123,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      name: 'Test Basket',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 1000,
      isDeleted: false
    }

    const entity = new EntityOutputBasket(initialData)

    // Test getters
    expect(entity.basketId).toBe(123)
    expect(entity.created_at.getTime()).toBe(new Date('2023-01-01').getTime())
    expect(entity.updated_at.getTime()).toBe(new Date('2023-01-02').getTime())
    expect(entity.userId).toBe(1)
    expect(entity.name).toBe('Test Basket')
    expect(entity.numberOfDesiredUTXOs).toBe(10)
    expect(entity.minimumDesiredUTXOValue).toBe(1000)
    expect(entity.isDeleted).toBe(false)
    expect(entity.id).toBe(123)
    expect(entity.entityName).toBe('outputBasket')
    expect(entity.entityTable).toBe('output_baskets')

    // Test setters
    entity.basketId = 456
    entity.created_at = new Date('2023-02-01')
    entity.updated_at = new Date('2023-02-02')
    entity.userId = 2
    entity.name = 'Updated Basket'
    entity.numberOfDesiredUTXOs = 20
    entity.minimumDesiredUTXOValue = 2000
    entity.isDeleted = true
    entity.id = 456

    expect(entity.basketId).toBe(456)
    expect(entity.created_at.getTime()).toBe(new Date('2023-02-01').getTime())
    expect(entity.updated_at.getTime()).toBe(new Date('2023-02-02').getTime())
    expect(entity.userId).toBe(2)
    expect(entity.name).toBe('Updated Basket')
    expect(entity.numberOfDesiredUTXOs).toBe(20)
    expect(entity.minimumDesiredUTXOValue).toBe(2000)
    expect(entity.isDeleted).toBe(true)
    expect(entity.id).toBe(456)

    // Test updateApi (even though it does nothing)
    expect(() => entity.updateApi()).not.toThrow()
  })
})
