import { EntityTxLabel } from '../EntityTxLabel'
import { createSyncMap, sdk, SyncMap, TableTxLabel } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'

describe('TxLabel Class Tests', () => {
  jest.setTimeout(99999999) // Extend timeout for database operations

  const env = _tu.getEnv('test') // Test environment
  const ctxs: TestWalletNoSetup[] = [] // Context for primary databases
  const ctxs2: TestWalletNoSetup[] = [] // Context for secondary databases

  beforeAll(async () => {
    // Set up MySQL and SQLite databases for testing
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('txLabelTests_db1'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('txLabelTests_db2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('txLabelTests_db1'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('txLabelTests_db2'))
  })

  afterAll(async () => {
    // Clean up primary databases
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    // Clean up secondary databases
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  // Test: Default constructor behavior
  test('1_creates_txLabel_with_default_values', () => {
    const txLabel = new EntityTxLabel()

    // Default values
    expect(txLabel.txLabelId).toBe(0)
    expect(txLabel.label).toBe('')
    expect(txLabel.userId).toBe(0)
    expect(txLabel.isDeleted).toBe(false)
    expect(txLabel.created_at).toBeInstanceOf(Date)
    expect(txLabel.updated_at).toBeInstanceOf(Date)
    expect(txLabel.created_at <= txLabel.updated_at).toBe(true)
  })

  // Test: Constructor with provided API object
  test('2_creates_txLabel_with_provided_api_object', () => {
    const now = new Date()
    const apiObject: TableTxLabel = {
      txLabelId: 42,
      label: 'Test Label',
      userId: 101,
      isDeleted: false,
      created_at: now,
      updated_at: now
    }
    const txLabel = new EntityTxLabel(apiObject)

    // Verify all properties match the API object
    expect(txLabel.txLabelId).toBe(42)
    expect(txLabel.label).toBe('Test Label')
    expect(txLabel.userId).toBe(101)
    expect(txLabel.isDeleted).toBe(false)
    expect(txLabel.created_at).toBe(now)
    expect(txLabel.updated_at).toBe(now)
  })

  // Test: Getters and setters behavior
  test('3_getters_and_setters_work_correctly', () => {
    const txLabel = new EntityTxLabel()

    const now = new Date()
    txLabel.txLabelId = 1
    txLabel.label = 'New Label'
    txLabel.userId = 200
    txLabel.isDeleted = true
    txLabel.created_at = now
    txLabel.updated_at = now
    txLabel.id = 2

    expect(txLabel.id).toBe(2)
    expect(txLabel.entityName).toBe('txLabel')
    expect(txLabel.entityTable).toBe('tx_labels')
    expect(txLabel.txLabelId).toBe(2)
    expect(txLabel.label).toBe('New Label')
    expect(txLabel.userId).toBe(200)
    expect(txLabel.isDeleted).toBe(true)
    expect(txLabel.created_at).toBe(now)
    expect(txLabel.updated_at).toBe(now)
  })

  // Test: mergeExisting does not update TxLabel when `ei.updated_at` is older
  test('5_mergeExisting_does_not_update_txLabel_when_ei_updated_at_is_older', async () => {
    for (const { activeStorage } of ctxs) {
      const txLabel = new EntityTxLabel({
        txLabelId: 302,
        label: 'Original Label',
        userId: 1,
        isDeleted: false,
        created_at: new Date('2023-01-01'),
        updated_at: new Date('2023-02-01')
      })

      await activeStorage.insertTxLabel(txLabel.toApi())

      const olderEi: TableTxLabel = {
        txLabelId: 302,
        label: 'Outdated Label',
        userId: 1,
        isDeleted: true,
        created_at: new Date('2023-01-01'),
        updated_at: new Date('2023-01-01')
      }

      const result = await txLabel.mergeExisting(activeStorage, undefined, olderEi, {} as any)

      const reloadedTxLabel = await activeStorage.findTxLabelById(txLabel.id)

      expect(result).toBe(false)
      expect(reloadedTxLabel?.label).toBe('Original Label')
      expect(reloadedTxLabel?.isDeleted).toBe(false)
      expect(reloadedTxLabel?.updated_at).toEqual(new Date('2023-02-01'))
    }
  })

  test('6_equals_identifies_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert a TxLabel into the first database
    const txLabel1 = new EntityTxLabel({
      txLabelId: 303,
      userId: 1,
      label: 'Test Label',
      isDeleted: false,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02')
    })

    await ctx1.activeStorage.insertTxLabel(txLabel1.toApi())

    // Insert a matching TxLabel into the second database
    const txLabel2 = new EntityTxLabel({
      txLabelId: 304,
      userId: 1, // Different userId to simulate syncMap usage
      label: 'Test Label',
      isDeleted: false,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02')
    })

    await ctx2.activeStorage.insertTxLabel(txLabel2.toApi())

    const syncMap = createSyncMap()
    syncMap.txLabel.idMap = { [txLabel2.userId]: txLabel1.userId }
    syncMap.txLabel.count = 1

    // Verify the entities match
    expect(txLabel1.equals(txLabel2.toApi(), syncMap)).toBe(true)
  })

  test('7_equals_identifies_non_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert a TxLabel into the first database
    const txLabel1 = new EntityTxLabel({
      txLabelId: 305,
      userId: 1,
      label: 'Label A',
      isDeleted: false,
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02')
    })

    await ctx1.activeStorage.insertTxLabel(txLabel1.toApi())

    // Insert a non-matching TxLabel into the second database
    const txLabel2 = new EntityTxLabel({
      txLabelId: 306, // Different txLabelId
      userId: 1, // Different userId
      label: 'Label B', // Different label
      isDeleted: true, // Different isDeleted value
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02')
    })

    await ctx2.activeStorage.insertTxLabel(txLabel2.toApi())

    const syncMap = createSyncMap()
    syncMap.txLabel.idMap = { [txLabel2.userId]: txLabel1.userId }
    syncMap.txLabel.count = 1

    // Verify the entities do not match
    expect(txLabel1.equals(txLabel2.toApi(), syncMap)).toBe(false)
  })
})
