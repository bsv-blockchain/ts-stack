import { createSyncMap, sdk, SyncMap, TableOutputTag } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityOutputTag } from '../EntityOutputTag'

describe('OutputTag class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('OutputTagTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('OutputTagTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('OutputTagTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('OutputTagTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  test('0_mergeExisting merges and updates entity when ei.updated_at > this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputTag record with valid userId
    const initialData: TableOutputTag = {
      outputTagId: 401,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag1',
      userId: 1,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTag(initialData)

    // Create an OutputTag entity from the initial data
    const entity = new EntityOutputTag(initialData)

    // Simulate the `ei` argument with a later `updated_at`
    const updatedData: TableOutputTag = {
      ...initialData,
      updated_at: new Date('2023-01-03'), // Later timestamp
      isDeleted: true // Simulate a change in `isDeleted`
    }

    const syncMap = createSyncMap()
    syncMap.outputTag.idMap[401] = 401

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      updatedData,
      syncMap,
      undefined
    )

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is true
    expect(wasMerged).toBe(true)

    // Verify that the entity is updated
    expect(entity.isDeleted).toBe(1)

    // Verify that the database is updated
    const updatedRecord = await ctx.activeStorage.findOutputTags({
      partial: { outputTagId: 401 }
    })
    expect(updatedRecord.length).toBe(1)
    expect(updatedRecord[0]).toBeDefined()
    expect(updatedRecord[0].isDeleted).toBe(true)
  })

  test('1_mergeExisting does not merge when ei.updated_at <= this.updated_at', async () => {
    const ctx = ctxs[0]

    // Insert initial OutputTag record with valid userId
    const initialData: TableOutputTag = {
      outputTagId: 402,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag2',
      userId: 1, // Valid user ID
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTag(initialData)

    // Create an OutputTag entity from the initial data
    const entity = new EntityOutputTag(initialData)

    // Simulate the `ei` argument with an earlier or equal `updated_at`
    const earlierData: TableOutputTag = {
      ...initialData,
      updated_at: new Date('2023-01-01'), // Earlier timestamp
      isDeleted: true // Simulate a change in `isDeleted`
    }

    const syncMap = createSyncMap()
    syncMap.outputTag.idMap[1] = 1

    // Call mergeExisting
    const wasMergedRaw = await entity.mergeExisting(
      ctx.activeStorage,
      undefined, // `since` is not used in this method
      earlierData,
      syncMap,
      undefined
    )

    const wasMerged = Boolean(wasMergedRaw)

    // Verify that wasMerged is false
    expect(wasMerged).toBe(false)

    // Verify that the entity is not updated
    expect(entity.isDeleted).toBe(0)

    // Verify that the database is not updated
    const record = await ctx.activeStorage.findOutputTags({
      partial: { outputTagId: 1 }
    })
    expect(record.length).toBe(1)
    expect(record[0].isDeleted).toBe(false)
  })

  test('2_equals identifies matching entities without syncMap', async () => {
    const ctx = ctxs[0]

    // Insert matching OutputTag record into the database
    const data: TableOutputTag = {
      outputTagId: 403,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag3',
      userId: 1,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTag(data)

    // Create OutputTag entities
    const entity1 = new EntityOutputTag(data)
    const entity2 = new EntityOutputTag(data)

    // Verify that equals returns true for matching entities
    expect(entity1.equals(entity2.toApi())).toBe(true)
  })

  test('3_equals identifies non-matching entities when tags differ', async () => {
    const ctx = ctxs[0]

    // Insert differing OutputTag records into the database
    const data1: TableOutputTag = {
      outputTagId: 404,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag4',
      userId: 1,
      isDeleted: false
    }
    const data2 = { ...data1, tag: 'tag2' }

    await ctx.activeStorage.insertOutputTag(data1)

    // Create OutputTag entities
    const entity1 = new EntityOutputTag(data1)
    const entity2 = new EntityOutputTag(data2)

    // Verify that equals returns false when tags differ
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  test('4_equals identifies non-matching entities when isDeleted differs', async () => {
    const ctx = ctxs[0]

    // Insert differing OutputTag records into the database
    const data1: TableOutputTag = {
      outputTagId: 405,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag5',
      userId: 1,
      isDeleted: false
    }
    const data2 = { ...data1, isDeleted: true }

    await ctx.activeStorage.insertOutputTag(data1)

    // Create OutputTag entities
    const entity1 = new EntityOutputTag(data1)
    const entity2 = new EntityOutputTag(data2)

    // Verify that equals returns false when isDeleted differs
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  test('5_equals identifies matching entities with syncMap', async () => {
    const ctx = ctxs[0]

    // Insert matching OutputTag record into the database
    const data: TableOutputTag = {
      outputTagId: 406,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag6',
      userId: 1,
      isDeleted: false
    }
    await ctx.activeStorage.insertOutputTag(data)

    // Create OutputTag entities
    const entity1 = new EntityOutputTag(data)
    const entity2 = new EntityOutputTag(data)

    const syncMap = createSyncMap()
    syncMap.outputTag.idMap[1] = 1

    // Verify that equals returns true with syncMap
    expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
  })

  test('6_equals identifies non-matching entities when userIds differ and no syncMap is provided', async () => {
    const ctx = ctxs[0]

    // Insert differing OutputTag records into the database
    const data1: TableOutputTag = {
      outputTagId: 407,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      tag: 'tag7',
      userId: 1,
      isDeleted: false
    }
    const data2 = { ...data1, userId: 2 }

    await ctx.activeStorage.insertOutputTag(data1)

    // Create OutputTag entities
    const entity1 = new EntityOutputTag(data1)
    const entity2 = new EntityOutputTag(data2)

    // Verify that equals returns false when userIds differ and no syncMap is provided
    expect(entity1.equals(entity2.toApi())).toBe(false)
  })

  test('7_getters and setters work as expected for OutputTag', () => {
    const now = new Date()
    const later = new Date(now.getTime() + 1000)

    // Create an OutputTag instance
    const outputTag = new EntityOutputTag()

    // Set values using setters
    outputTag.outputTagId = 123
    outputTag.created_at = now
    outputTag.updated_at = later
    outputTag.tag = 'Test Tag'
    outputTag.userId = 456
    outputTag.isDeleted = true

    // Validate values using getters
    expect(outputTag.outputTagId).toBe(123)
    expect(outputTag.created_at).toBe(now)
    expect(outputTag.updated_at).toBe(later)
    expect(outputTag.tag).toBe('Test Tag')
    expect(outputTag.userId).toBe(456)
    expect(outputTag.isDeleted).toBe(true)

    // Validate id, entityName, and entityTable
    expect(outputTag.id).toBe(123)
    expect(outputTag.entityName).toBe('outputTag')
    expect(outputTag.entityTable).toBe('output_tags')

    // Update id using override setter
    outputTag.id = 789

    // Validate id again
    expect(outputTag.id).toBe(789)
  })
})
