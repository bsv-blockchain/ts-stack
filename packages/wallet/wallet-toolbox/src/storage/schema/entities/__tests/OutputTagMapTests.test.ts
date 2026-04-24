import * as bsv from '@bsv/sdk'
import { createSyncMap, sdk, SyncMap, TableOutputTagMap } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityOutputTagMap } from '../EntityOutputTagMap'

describe('OutputTagMap class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('OutputTagMapTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('OutputTagMapTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('OutputTagMapTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('OutputTagMapTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  test('0_OutputTagMap getters and setters', async () => {
    const now = new Date()
    const initialData: TableOutputTagMap = {
      created_at: now,
      updated_at: now,
      outputId: 1,
      outputTagId: 2,
      isDeleted: false
    }

    const outputTagMap = new EntityOutputTagMap(initialData)

    // Test getters
    expect(outputTagMap.outputTagId).toBe(2)
    expect(outputTagMap.outputId).toBe(1)
    expect(outputTagMap.created_at).toBe(now)
    expect(outputTagMap.updated_at).toBe(now)
    expect(outputTagMap.isDeleted).toBe(false)
    expect(outputTagMap.entityName).toBe('outputTagMap')
    expect(outputTagMap.entityTable).toBe('output_tags_map')

    // Test setters
    const newDate = new Date()
    outputTagMap.outputTagId = 3
    outputTagMap.outputId = 4
    outputTagMap.created_at = newDate
    outputTagMap.updated_at = newDate
    outputTagMap.isDeleted = true

    expect(outputTagMap.outputTagId).toBe(3)
    expect(outputTagMap.outputId).toBe(4)
    expect(outputTagMap.created_at).toBe(newDate)
    expect(outputTagMap.updated_at).toBe(newDate)
    expect(outputTagMap.isDeleted).toBe(true)

    // Test id throws an error
    expect(() => outputTagMap.id).toThrow(sdk.WERR_INVALID_OPERATION)
  })

  test('1_equals returns true for matching entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert matching OutputTagMap records into both databases
    const outputTagMapData: TableOutputTagMap = {
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      outputId: 1,
      outputTagId: 8,
      isDeleted: false
    }

    await ctx1.activeStorage.insertOutputTagMap(outputTagMapData)
    await ctx2.activeStorage.insertOutputTagMap(outputTagMapData)

    // Create entities from the records
    const entity1 = new EntityOutputTagMap(outputTagMapData)
    const entity2 = new EntityOutputTagMap(outputTagMapData)

    const syncMap = createSyncMap()
    syncMap.output.idMap[1] = 1
    syncMap.outputTag.idMap[8] = 8

    // Verify that equals returns true
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
  })

  test('2_equals returns false for non-matching entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert mismatched OutputTagMap records into both databases
    const outputTagMapData1: TableOutputTagMap = {
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      outputId: 1,
      outputTagId: 9,
      isDeleted: false
    }

    const outputTagMapData2: TableOutputTagMap = {
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      outputId: 1, // Mismatched outputId
      outputTagId: 21, // Mismatched outputTagId
      isDeleted: true // Mismatched isDeleted
    }

    await ctx1.activeStorage.insertOutputTagMap(outputTagMapData1)
    await ctx2.activeStorage.insertOutputTagMap(outputTagMapData2)

    // Create entities from the records
    const entity1 = new EntityOutputTagMap(outputTagMapData1)
    const entity2 = new EntityOutputTagMap(outputTagMapData2)

    const syncMap = createSyncMap()
    syncMap.output.idMap[101] = 101

    // Verify that equals returns false due to mismatched properties
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(false)

    // Test without a sync map to hit another branch
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  test('3_mergeExisting merges and updates entity when ei.updated_at > this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputTagMap record with valid foreign key IDs
    const initialData: TableOutputTagMap = {
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      outputId: 2,
      outputTagId: 8,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTagMap(initialData)

    // Create an OutputTagMap entity from the initial data
    const entity = new EntityOutputTagMap(initialData)

    // Create a new record to simulate the `ei` argument with a later `updated_at`
    const updatedData: TableOutputTagMap = {
      ...initialData,
      updated_at: new Date('2023-01-03'), // Later timestamp
      isDeleted: true // Simulate a change in `isDeleted`
    }

    const syncMap = createSyncMap()
    syncMap.output.idMap[1] = 1

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      updatedData,
      syncMap
    )

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is true
    expect(wasMerged).toBe(true)

    // Verify that the entity is updated
    expect(entity.isDeleted).toBe(1)

    // Debugging: Log the updated record query
    const updatedRecord = await ctx.activeStorage.findOutputTagMaps({
      partial: { outputId: 2, outputTagId: 8 }
    })
    //console.log('Updated Record:', updatedRecord)
    //console.log('Updated Record isDeleted:', updatedRecord[0].isDeleted)
    //console.log('Updted Redord length:', updatedRecord.length)

    // Verify that the database is updated
    expect(updatedRecord.length).toBe(1)
    expect(updatedRecord[0]).toBeDefined()
    expect(updatedRecord[0].isDeleted).toBe(true)
  })

  test('4_mergeExisting does not merge when ei.updated_at <= this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputTagMap record
    const initialData: TableOutputTagMap = {
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      outputId: 2,
      outputTagId: 11,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTagMap(initialData)

    // Create an OutputTagMap entity from the initial data
    const entity = new EntityOutputTagMap(initialData)

    // Create a new record to simulate the `ei` argument with an earlier `updated_at`
    const earlierData: TableOutputTagMap = {
      ...initialData,
      updated_at: new Date('2023-01-01'), // Earlier timestamp
      isDeleted: true // Simulate a change in `isDeleted`
    }

    const syncMap = createSyncMap()
    syncMap.output.idMap[101] = 101

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      earlierData,
      syncMap
    )

    // Normalize the result
    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is false
    expect(wasMerged).toBe(false)

    // Verify that the entity is not updated
    expect(entity.isDeleted).toBe(0)

    // Verify that the database is not updated
    const record = await ctx.activeStorage.findOutputTagMaps({
      partial: { outputId: 2, outputTagId: 11 }
    })
    expect(record.length).toBe(1)
    expect(record[0].isDeleted).toBe(false)
  })
})
