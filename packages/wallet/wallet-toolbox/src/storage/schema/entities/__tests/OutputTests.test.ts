import { createSyncMap, sdk, SyncMap, TableOutput } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityOutput } from '../EntityOutput'

describe('Output class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('OutputTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('OutputTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('OutputBTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('OutputTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  // Test: equals identifies matching entities with and without SyncMap
  test('0_equals identifies matching entities with and without SyncMap', async () => {
    const ctx = ctxs[0]

    // Insert initial record into the database
    const initialData: TableOutput = {
      outputId: 601,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      transactionId: 100,
      basketId: 1,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Test Output',
      vout: 40,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'testing',
      txid: 'txid123',
      spendingDescription: 'Test Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key123',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0
    }

    await ctx.activeStorage.insertOutput(initialData)

    // Create two Output entities from the same data
    const entity1 = new EntityOutput(initialData)
    const entity2 = new EntityOutput(initialData)

    const syncMap = createSyncMap()
    syncMap.transaction.idMap[100] = 100
    syncMap.outputBasket.idMap[1] = 1

    // Verify equals with and without SyncMap
    expect(entity1.equals(entity2.toApi())).toBe(true)
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
  })

  // Test: equals identifies non-matching entities
  test('1_equals identifies non-matching entities', async () => {
    const ctx = ctxs[0]

    // Insert initial record into the database
    const initialData: TableOutput = {
      outputId: 602,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      transactionId: 101,
      basketId: 2,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Test Output',
      vout: 41,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'testing',
      txid: 'txid124',
      spendingDescription: 'Test Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key124',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0
    }

    await ctx.activeStorage.insertOutput(initialData)

    // Create two Output entities with differing data
    const entity1 = new EntityOutput(initialData)
    const entity2 = new EntityOutput({
      ...initialData,
      satoshis: 2000
    })

    // Verify equals returns false for different entities
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  // Test: equals identifies non-matching entities with optional fields and arrays
  test('2_equals handles optional fields and arrays', async () => {
    const ctx = ctxs[0]

    // Insert initial record into the database
    const initialData: TableOutput = {
      outputId: 603,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      transactionId: 102,
      basketId: 3,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Test Output',
      vout: 42,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'testing',
      txid: 'txid125',
      spendingDescription: 'Test Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key125',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0
    }

    await ctx.activeStorage.insertOutput(initialData)

    // Create two Output entities with differing array data
    const entity1 = new EntityOutput(initialData)
    const entity2 = new EntityOutput({
      ...initialData,
      lockingScript: [1, 2, 4]
    })

    // Verify equals returns false for different arrays
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  // Test: mergeExisting updates entity and database when ei.updated_at > this.updated_at
  test('3_mergeExisting updates entity and database when ei.updated_at > this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial Output record
    const initialData: TableOutput = {
      outputId: 701,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      transactionId: 103,
      basketId: 1,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Initial Output',
      vout: 50,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'initial',
      txid: 'txid201',
      spendingDescription: 'Initial Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key201',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0,
      spentBy: undefined
    }

    await ctx.activeStorage.insertOutput(initialData)

    // Create an Output entity from the initial data
    const entity = new EntityOutput(initialData)

    // Simulate the `ei` argument with a later `updated_at`
    const updatedData: TableOutput = {
      ...initialData,
      updated_at: new Date('2023-01-03'), // Later timestamp
      spendable: false,
      change: true,
      type: 'p2sh',
      providedBy: 'storage',
      purpose: 'updated',
      outputDescription: 'Updated Output',
      spendingDescription: 'Updated Spending',
      senderIdentityKey: 'key202',
      customInstructions: 'new instructions',
      scriptLength: 15,
      scriptOffset: 5,
      lockingScript: [4, 5, 6],
      spentBy: 105
    }

    const syncMap = createSyncMap()
    syncMap.transaction.idMap = { 103: 103, 105: 105 }
    syncMap.outputBasket.idMap[1] = 1

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
    expect(entity.spentBy).toBe(105)
    expect(entity.spendable).toBe(false)
    expect(entity.change).toBe(true)
    expect(entity.type).toBe('p2sh')
    expect(entity.providedBy).toBe('storage')
    expect(entity.purpose).toBe('updated')
    expect(entity.outputDescription).toBe('Updated Output')
    expect(entity.spendingDescription).toBe('Updated Spending')
    expect(entity.senderIdentityKey).toBe('key202')
    expect(entity.customInstructions).toBe('new instructions')
    expect(entity.scriptLength).toBe(15)
    expect(entity.scriptOffset).toBe(5)

    // Convert Buffer to array for comparison
    if (entity.lockingScript instanceof Buffer) {
      expect([...entity.lockingScript]).toEqual([4, 5, 6])
    } else {
      expect(entity.lockingScript).toEqual([4, 5, 6])
    }

    // Verify that the database is updated
    const updatedRecord = await ctx.activeStorage.findOutputs({
      partial: { outputId: 701 }
    })
    expect(updatedRecord.length).toBe(1)
    expect(updatedRecord[0]).toBeDefined()
    expect(updatedRecord[0].spendable).toBe(false)
    expect(updatedRecord[0].type).toBe('p2sh')

    // Handle undefined lockingScript gracefully
    if (updatedRecord[0].lockingScript) {
      expect(Buffer.from(updatedRecord[0].lockingScript).toJSON().data).toEqual([4, 5, 6])
    } else {
      throw new Error('lockingScript is undefined')
    }
  })

  // Test: mergeExisting does not update when ei.updated_at <= this.updated_at
  test('4_mergeExisting does not update when ei.updated_at <= this.updated_at', async () => {
    const ctx = ctxs[0]

    // Use the same initialData as before
    const initialData: TableOutput = {
      outputId: 702,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      userId: 1,
      transactionId: 104,
      basketId: 1,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Initial Output',
      vout: 50,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'initial',
      txid: 'txid202',
      spendingDescription: 'Initial Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key202',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0,
      spentBy: undefined
    }

    await ctx.activeStorage.insertOutput(initialData)

    // Create an Output entity from the initial data
    const entity = new EntityOutput(initialData)

    // Simulate the `ei` argument with an earlier `updated_at`
    const earlierData: TableOutput = {
      ...initialData,
      updated_at: new Date('2023-01-01'), // Earlier timestamp
      spendable: false
    }

    const syncMap = createSyncMap()
    syncMap.transaction.idMap = { 104: 104 }
    syncMap.outputBasket.idMap[1] = 1

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(ctx.activeStorage, undefined, earlierData, syncMap, undefined)

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is false
    expect(wasMerged).toBe(false)

    // Verify that the entity is not updated
    expect(entity.spendable).toBe(true)

    // Verify that the database is not updated
    const unchangedRecord = await ctx.activeStorage.findOutputs({
      partial: { outputId: 702 }
    })
    expect(unchangedRecord.length).toBe(1)
    expect(unchangedRecord[0].spendable).toBe(true)
  })

  // Test: Output entity getters and setters
  test('Output entity getters and setters', async () => {
    const now = new Date()

    // Initial test data
    const initialData: TableOutput = {
      outputId: 701,
      created_at: now,
      updated_at: now,
      userId: 1,
      transactionId: 103,
      basketId: 1,
      spendable: true,
      change: false,
      satoshis: 1000,
      outputDescription: 'Initial Output',
      vout: 50,
      type: 'p2pkh',
      providedBy: 'you',
      purpose: 'initial',
      txid: 'txid201',
      spendingDescription: 'Initial Spending',
      derivationPrefix: 'm/44',
      derivationSuffix: '/0/0',
      senderIdentityKey: 'key201',
      customInstructions: 'none',
      lockingScript: [1, 2, 3],
      scriptLength: 10,
      scriptOffset: 0,
      spentBy: 200
    }

    // Create the Output entity
    const entity = new EntityOutput(initialData)

    // Validate getters
    expect(entity.outputId).toBe(initialData.outputId)
    expect(entity.created_at).toEqual(initialData.created_at)
    expect(entity.updated_at).toEqual(initialData.updated_at)
    expect(entity.userId).toBe(initialData.userId)
    expect(entity.transactionId).toBe(initialData.transactionId)
    expect(entity.basketId).toBe(initialData.basketId)
    expect(entity.spentBy).toBe(initialData.spentBy)
    expect(entity.vout).toBe(initialData.vout)
    expect(entity.satoshis).toBe(initialData.satoshis)
    expect(entity.outputDescription).toBe(initialData.outputDescription)
    expect(entity.spendable).toBe(initialData.spendable)
    expect(entity.change).toBe(initialData.change)
    expect(entity.txid).toBe(initialData.txid)
    expect(entity.type).toBe(initialData.type)
    expect(entity.providedBy).toBe(initialData.providedBy)
    expect(entity.purpose).toBe(initialData.purpose)
    expect(entity.spendingDescription).toBe(initialData.spendingDescription)
    expect(entity.derivationPrefix).toBe(initialData.derivationPrefix)
    expect(entity.derivationSuffix).toBe(initialData.derivationSuffix)
    expect(entity.senderIdentityKey).toBe(initialData.senderIdentityKey)
    expect(entity.customInstructions).toBe(initialData.customInstructions)
    expect(entity.lockingScript).toEqual(initialData.lockingScript)
    expect(entity.scriptLength).toBe(initialData.scriptLength)
    expect(entity.scriptOffset).toBe(initialData.scriptOffset)

    // Validate setters
    entity.outputId = 800
    entity.created_at = new Date('2024-01-01')
    entity.updated_at = new Date('2024-01-02')
    entity.userId = 2
    entity.transactionId = 104
    entity.basketId = 2
    entity.spentBy = 300
    entity.vout = 60
    entity.satoshis = 2000
    entity.outputDescription = 'Updated Output'
    entity.spendable = false
    entity.change = true
    entity.txid = 'txid202'
    entity.type = 'p2sh'
    entity.providedBy = 'storage'
    entity.purpose = 'updated'
    entity.spendingDescription = 'Updated Spending'
    entity.derivationPrefix = 'm/45'
    entity.derivationSuffix = '/1/0'
    entity.senderIdentityKey = 'key202'
    entity.customInstructions = 'new instructions'
    entity.lockingScript = [4, 5, 6]
    entity.scriptLength = 15
    entity.scriptOffset = 5

    expect(entity.outputId).toBe(800)
    expect(entity.created_at).toEqual(new Date('2024-01-01'))
    expect(entity.updated_at).toEqual(new Date('2024-01-02'))
    expect(entity.userId).toBe(2)
    expect(entity.transactionId).toBe(104)
    expect(entity.basketId).toBe(2)
    expect(entity.spentBy).toBe(300)
    expect(entity.vout).toBe(60)
    expect(entity.satoshis).toBe(2000)
    expect(entity.outputDescription).toBe('Updated Output')
    expect(entity.spendable).toBe(false)
    expect(entity.change).toBe(true)
    expect(entity.txid).toBe('txid202')
    expect(entity.type).toBe('p2sh')
    expect(entity.providedBy).toBe('storage')
    expect(entity.purpose).toBe('updated')
    expect(entity.spendingDescription).toBe('Updated Spending')
    expect(entity.derivationPrefix).toBe('m/45')
    expect(entity.derivationSuffix).toBe('/1/0')
    expect(entity.senderIdentityKey).toBe('key202')
    expect(entity.customInstructions).toBe('new instructions')
    expect(entity.lockingScript).toEqual([4, 5, 6])
    expect(entity.scriptLength).toBe(15)
    expect(entity.scriptOffset).toBe(5)

    // Validate `id` setter and getter
    entity.id = 900
    expect(entity.id).toBe(900)
    expect(entity.outputId).toBe(900)

    // Validate `entityName` and `entityTable`
    expect(entity.entityName).toBe('output')
    expect(entity.entityTable).toBe('outputs')
  })
})
