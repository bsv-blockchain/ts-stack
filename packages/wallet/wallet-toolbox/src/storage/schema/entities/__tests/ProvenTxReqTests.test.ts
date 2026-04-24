import * as bsv from '@bsv/sdk'
import { createSyncMap, sdk, SyncMap, TableProvenTxReq } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityProvenTxReq, ProvenTxReqHistorySummaryApi } from '../EntityProvenTxReq'

describe('ProvenTxReq class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('ProvenTxReqTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('ProvenTxReqTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('ProvenTxReqTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('ProvenTxReqTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  // Test: apiNotify getter and setter
  test('0_apiNotify_getter_and_setter', () => {
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: '',
      rawTx: [],
      history: '{}',
      notify: '{}',
      attempts: 0,
      status: 'unknown',
      notified: false
    })

    const notifyData = { transactionIds: [1, 2, 3] }
    provenTxReq.apiNotify = JSON.stringify(notifyData)

    expect(provenTxReq.apiNotify).toBe(JSON.stringify(notifyData))
    expect(provenTxReq.notify.transactionIds).toEqual([1, 2, 3])
  })

  // Test: getHistorySummary method
  test('1_getHistorySummary', () => {})

  // Test: parseHistoryNote method
  test('2_parseHistoryNote', () => {
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: '',
      rawTx: [],
      history: '{}',
      notify: '{}',
      attempts: 0,
      status: 'unknown',
      notified: false
    })
  })

  // Test: updateStorage method
  test('3_updateStorage', async () => {
    const ctx = ctxs[0]
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: 'test-txid',
      rawTx: [1, 2, 3],
      history: '{}',
      notify: '{}',
      attempts: 0,
      status: 'unknown',
      notified: false
    })

    await provenTxReq.updateStorage(ctx.activeStorage)

    const fetchedProvenTxReqs = await ctx.activeStorage.findProvenTxReqs({
      partial: { txid: 'test-txid' }
    })
    expect(fetchedProvenTxReqs.length).toBe(1)
    expect(fetchedProvenTxReqs[0].txid).toBe('test-txid')
  })

  // Test: insertOrMerge method
  test('4_insertOrMerge', async () => {
    const ctx = ctxs[0]
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: 'test-txid-merge',
      rawTx: [1, 2, 3],
      history: '{}',
      notify: '{}',
      attempts: 0,
      status: 'unknown',
      notified: false
    })

    const result = await provenTxReq.insertOrMerge(ctx.activeStorage)

    expect(result.txid).toBe('test-txid-merge')
  })

  // Test: equals method identifies matching ProvenTxReq entities
  test('5_equals_identifies_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Create current time for consistency
    const currentTime = new Date()

    // ProvenTxReq in the first database
    const provenTxReq1 = new EntityProvenTxReq({
      provenTxReqId: 405,
      created_at: currentTime,
      updated_at: currentTime,
      txid: 'test-equals',
      rawTx: [1, 2, 3],
      history: JSON.stringify({
        notes: { '2025-01-01T00:00:00.000Z': 'test-note-1' }
      }),
      notify: JSON.stringify({ transactionIds: [100] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    })
    await ctx1.activeStorage.insertProvenTxReq(provenTxReq1.toApi())

    // ProvenTxReq in the second database
    const provenTxReq2 = new EntityProvenTxReq({
      provenTxReqId: 406,
      created_at: currentTime,
      updated_at: currentTime,
      txid: 'test-equals',
      rawTx: [1, 2, 3],
      history: JSON.stringify({
        notes: { '2025-01-01T00:00:00.000Z': 'test-note-1' }
      }),
      notify: JSON.stringify({ transactionIds: [200] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    })
    await ctx2.activeStorage.insertProvenTxReq(provenTxReq2.toApi())

    const syncMap = createSyncMap()
    syncMap.provenTxReq.idMap = { 406: 405 }

    // Assert entities are equal
    expect(provenTxReq1.equals(provenTxReq2.toApi(), syncMap)).toBe(true)
  })

  // Test: equals method identifies non-matching ProvenTxReq entities
  test('6_equals_identifies_non_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    const currentTime = new Date()

    // ProvenTxReq in the first database
    const provenTxReq1 = new EntityProvenTxReq({
      provenTxReqId: 407,
      created_at: currentTime,
      updated_at: currentTime,
      txid: 'test-equals-1', // Different txid
      rawTx: [1, 2, 3],
      history: JSON.stringify({
        notes: { '2025-01-01T00:00:00.000Z': 'test-note-1' }
      }),
      notify: JSON.stringify({ transactionIds: [100] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    })
    await ctx1.activeStorage.insertProvenTxReq(provenTxReq1.toApi())

    // ProvenTxReq in the second database
    const provenTxReq2 = new EntityProvenTxReq({
      provenTxReqId: 408,
      created_at: currentTime,
      updated_at: currentTime,
      txid: 'test-equals-2', // Different txid
      rawTx: [1, 2, 3],
      history: JSON.stringify({
        notes: { '2025-01-01T00:00:00.000Z': 'test-note-1' }
      }),
      notify: JSON.stringify({ transactionIds: [200] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    })
    await ctx2.activeStorage.insertProvenTxReq(provenTxReq2.toApi())

    const syncMap = createSyncMap()
    syncMap.provenTxReq.idMap = { 406: 405 }

    // Assert entities are not equal
    expect(provenTxReq1.equals(provenTxReq2.toApi(), syncMap)).toBe(false)
  })

  // Test: mergeNotifyTransactionIds method
  test('7_mergeNotifyTransactionIds', () => {
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: '',
      rawTx: [],
      history: JSON.stringify({ notes: {} }),
      notify: JSON.stringify({ transactionIds: [100] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    })

    const syncMap = createSyncMap()
    syncMap.transaction.idMap = { 100: 200 }

    const inputProvenTxReq: TableProvenTxReq = {
      provenTxReqId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      txid: '',
      rawTx: [],
      history: JSON.stringify({ notes: {} }),
      notify: JSON.stringify({ transactionIds: [100] }),
      attempts: 0,
      status: 'unknown',
      notified: false
    }

    // Call mergeNotifyTransactionIds
    provenTxReq.mergeNotifyTransactionIds(inputProvenTxReq, syncMap)

    // Assert that transaction IDs include both original and mapped values
    expect(provenTxReq.notify.transactionIds).toEqual([100, 200])
  })

  // Test: Getters and Setters
  test('8_getters_and_setters', () => {
    const currentTime = new Date()
    const provenTxReq = new EntityProvenTxReq({
      provenTxReqId: 123,
      created_at: currentTime,
      updated_at: currentTime,
      txid: 'test-txid',
      inputBEEF: [1, 2, 3],
      rawTx: [4, 5, 6],
      attempts: 3,
      provenTxId: 456,
      notified: true,
      batch: 'test-batch',
      history: '{}', // Valid JSON
      notify: '{}', // Valid JSON
      status: 'completed'
    })

    // Verify getters
    expect(provenTxReq.provenTxReqId).toBe(123)
    expect(provenTxReq.created_at).toBe(currentTime)
    expect(provenTxReq.updated_at).toBe(currentTime)
    expect(provenTxReq.txid).toBe('test-txid')
    expect(provenTxReq.inputBEEF).toEqual([1, 2, 3])
    expect(provenTxReq.rawTx).toEqual([4, 5, 6])
    expect(provenTxReq.attempts).toBe(3)
    expect(provenTxReq.provenTxId).toBe(456)
    expect(provenTxReq.notified).toBe(true)
    expect(provenTxReq.batch).toBe('test-batch')
    expect(provenTxReq.id).toBe(123)
    expect(provenTxReq.entityName).toBe('provenTxReq')
    expect(provenTxReq.entityTable).toBe('proven_tx_reqs')

    // Verify setters
    const newTime = new Date()
    provenTxReq.provenTxReqId = 789
    provenTxReq.created_at = newTime
    provenTxReq.updated_at = newTime
    provenTxReq.txid = 'new-txid'
    provenTxReq.inputBEEF = [7, 8, 9]
    provenTxReq.rawTx = [10, 11, 12]
    provenTxReq.attempts = 5
    provenTxReq.provenTxId = 789
    provenTxReq.notified = false
    provenTxReq.batch = 'new-batch'
    provenTxReq.id = 789

    // Verify that setters updated the api object correctly
    expect(provenTxReq.api.provenTxReqId).toBe(789)
    expect(provenTxReq.api.created_at).toBe(newTime)
    expect(provenTxReq.api.updated_at).toBe(newTime)
    expect(provenTxReq.api.txid).toBe('new-txid')
    expect(provenTxReq.api.inputBEEF).toEqual([7, 8, 9])
    expect(provenTxReq.api.rawTx).toEqual([10, 11, 12])
    expect(provenTxReq.api.attempts).toBe(5)
    expect(provenTxReq.api.provenTxId).toBe(789)
    expect(provenTxReq.api.notified).toBe(false)
    expect(provenTxReq.api.batch).toBe('new-batch')
  })

  // Test: parseHistoryNote method
  test('9_parseHistoryNote', () => {})

  // Test: mergeHistory method
  test('10_mergeHistory', () => {})

  test('12_isTerminalStatus_with_real_data', async () => {
    // Assuming `ctxs[0]` contains the necessary setup and `sdk.ProvenTxReqTerminalStatus` is already defined
    const ctx = ctxs[0]

    // Fetch terminal statuses if they are stored in the database or available via context
    const terminalStatuses: sdk.ProvenTxReqStatus[] = sdk.ProvenTxReqTerminalStatus

    // Test cases for valid and invalid statuses
    const testCases: { status: sdk.ProvenTxReqStatus; expected: boolean }[] = [
      { status: terminalStatuses[0] || 'completed', expected: true }, // Use the first valid terminal status
      { status: terminalStatuses[1] || 'doubleSpend', expected: true }, // Use another valid terminal status
      { status: 'nonExistentStatus' as sdk.ProvenTxReqStatus, expected: false } // A status that is not in the terminal statuses
    ]

    for (const { status, expected } of testCases) {
      expect(EntityProvenTxReq.isTerminalStatus(status)).toBe(expected)
    }
  })

  test('13_mergeExisting_real_data', async () => {})
})
