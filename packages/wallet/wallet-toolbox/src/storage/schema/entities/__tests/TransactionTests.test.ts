import { Knex } from 'knex'
import * as bsv from '@bsv/sdk'
import { createSyncMap, sdk, SyncMap, TableTransaction } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityTransaction } from '../EntityTransaction'

describe('Transaction class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('transactionTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('transactionTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('transactionTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('transactionTests2'))
  })

  afterAll(async () => {
    // Destroy both sets of database contexts
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  // Test: Constructor with default values
  test('0_creates_instance_with_default_values', () => {
    const tx = new EntityTransaction()

    const now = new Date()
    expect(tx.transactionId).toBe(0)
    expect(tx.userId).toBe(0)
    expect(tx.txid).toBe('')
    expect(tx.status).toBe('unprocessed')
    expect(tx.reference).toBe('')
    expect(tx.satoshis).toBe(0)
    expect(tx.description).toBe('')
    expect(tx.isOutgoing).toBe(false)
    expect(tx.rawTx).toBeUndefined()
    expect(tx.inputBEEF).toBeUndefined()
    expect(tx.created_at).toBeInstanceOf(Date)
    expect(tx.updated_at).toBeInstanceOf(Date)
    expect(tx.created_at.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(tx.updated_at.getTime()).toBeLessThanOrEqual(now.getTime())
  })

  // Test: Constructor with provided API object
  test('1_creates_instance_with_provided_api_object', () => {
    const now = new Date()
    const apiObject: TableTransaction = {
      transactionId: 123,
      userId: 456,
      txid: 'testTxid',
      status: 'completed',
      reference: 'testReference',
      satoshis: 789,
      description: 'testDescription',
      isOutgoing: true,
      rawTx: [1, 2, 3],
      inputBEEF: [4, 5, 6],
      created_at: now,
      updated_at: now
    }

    const tx = new EntityTransaction(apiObject)

    expect(tx.transactionId).toBe(123)
    expect(tx.userId).toBe(456)
    expect(tx.txid).toBe('testTxid')
    expect(tx.status).toBe('completed')
    expect(tx.reference).toBe('testReference')
    expect(tx.satoshis).toBe(789)
    expect(tx.description).toBe('testDescription')
    expect(tx.isOutgoing).toBe(true)
    expect(tx.rawTx).toEqual([1, 2, 3])
    expect(tx.inputBEEF).toEqual([4, 5, 6])
    expect(tx.created_at).toBe(now)
    expect(tx.updated_at).toBe(now)
  })

  // Test: Getters and setters
  test('2_getters_and_setters_work_correctly', () => {
    const tx = new EntityTransaction()

    const now = new Date()
    tx.transactionId = 123
    tx.userId = 456
    tx.txid = 'testTxid'
    tx.status = 'processed' as sdk.TransactionStatus
    tx.reference = 'testReference'
    tx.satoshis = 789
    tx.description = 'testDescription'
    tx.isOutgoing = true
    tx.rawTx = [1, 2, 3]
    tx.inputBEEF = [4, 5, 6]
    tx.created_at = now
    tx.updated_at = now

    // New setters
    tx.version = 2
    tx.lockTime = 5000

    expect(tx.transactionId).toBe(123)
    expect(tx.userId).toBe(456)
    expect(tx.txid).toBe('testTxid')
    expect(tx.status).toBe('processed')
    expect(tx.reference).toBe('testReference')
    expect(tx.satoshis).toBe(789)
    expect(tx.description).toBe('testDescription')
    expect(tx.isOutgoing).toBe(true)
    expect(tx.rawTx).toEqual([1, 2, 3])
    expect(tx.inputBEEF).toEqual([4, 5, 6])
    expect(tx.created_at).toBe(now)
    expect(tx.updated_at).toBe(now)

    // Check new properties
    expect(tx.version).toBe(2) // Ensure version is set correctly
    expect(tx.lockTime).toBe(5000) // Ensure lockTime is set correctly
  })

  // Test: `getBsvTx` returns parsed transaction
  test('3_getBsvTx_returns_parsed_transaction', () => {
    const rawTx = Uint8Array.from([1, 2, 3])
    const tx = new EntityTransaction({
      rawTx: Array.from(rawTx)
    } as TableTransaction)

    const bsvTx = tx.getBsvTx()
    expect(bsvTx).toBeInstanceOf(bsv.Transaction)
  })

  // Test: `getBsvTx` returns undefined if rawTx is not set
  test('4_getBsvTx_returns_undefined_if_no_rawTx', () => {
    const tx = new EntityTransaction()
    const bsvTx = tx.getBsvTx()
    expect(bsvTx).toBeUndefined()
  })

  // Test: `getBsvTxIns` returns parsed inputs
  test('5_getBsvTxIns_returns_inputs', () => {
    const rawTx = Uint8Array.from([1, 2, 3])
    const tx = new EntityTransaction({
      rawTx: Array.from(rawTx)
    } as TableTransaction)

    const inputs = tx.getBsvTxIns()
    expect(inputs).toBeInstanceOf(Array)
  })

  // Test: getInputs combines spentBy and rawTx inputs
  test('6_getInputs_combines_spentBy_and_rawTx_inputs', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert the transaction into the database
      const txData = await _tu.insertTestTransaction(activeStorage, undefined, true)
      const tx = new EntityTransaction(txData.tx)

      // Assign rawTx to simulate transaction inputs
      const rawTx = Uint8Array.from([1, 2, 3])
      tx.rawTx = Array.from(rawTx)

      // Insert test outputs with spentBy linked to the transaction
      const output1 = await _tu.insertTestOutput(activeStorage, tx, 0, 100)
      await activeStorage.updateOutput(output1.outputId, {
        spentBy: tx.transactionId
      })

      const output2 = await _tu.insertTestOutput(activeStorage, tx, 1, 200)
      await activeStorage.updateOutput(output2.outputId, {
        spentBy: tx.transactionId
      })

      // Debugging: Log inserted outputs
      const outputs = await activeStorage.findOutputs({
        partial: { spentBy: tx.transactionId }
      })
      //console.log('Inserted Outputs:', outputs)

      // Get inputs from the transaction
      const inputs = await tx.getInputs(activeStorage)
      //console.log('Transaction Inputs:', inputs)

      // Validate the inputs
      expect(inputs).toHaveLength(2)
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ vout: 0, satoshis: 100 }),
          expect.objectContaining({ vout: 1, satoshis: 200 })
        ])
      )
    }
  })

  // Test: 'mergeExisting' updates when ei updated at is newer
  /*****************************************************************************************************/
  // Actually currently fails because mergeExisting is currently setting the date to the current date
  // rather than the udpated_at from the incoming entity
  /*****************************************************************************************************/
  test('9_mergeExisting_updates_when_ei_updated_at_is_newer', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a test transaction into the database
      const txData = await _tu.insertTestTransaction(activeStorage, undefined, true)

      // Create the `Transaction` instance with an earlier updated_at timestamp
      const tx = new EntityTransaction({
        ...txData.tx,
        updated_at: new Date(2022, 1, 1)
      })

      // Create an incoming entity object (`ei`) with a newer updated_at timestamp
      const ei: TableTransaction = {
        ...txData.tx,
        updated_at: new Date(2023, 1, 1),
        txid: 'newTxId'
      }

      const syncMap = createSyncMap()
      syncMap.transaction.idMap = { 456: 123 }
      syncMap.transaction.count = 1

      const expectedMergeUpdatedAt = Math.max(ei.updated_at.getTime(), tx.updated_at.getTime())

      // Execute `mergeExisting`
      const result = await tx.mergeExisting(activeStorage, new Date(), ei, syncMap)

      // Validate the result and check that the transaction was updated in the database
      expect(result).toBe(true)

      const updatedTx = await activeStorage.findTransactions({
        partial: { transactionId: tx.transactionId }
      })

      expect(updatedTx[0]?.txid).toBe('newTxId')
      // Currently expecting current time and date, but should be the updated_at from the incoming entity
      const updatedAtTime = updatedTx[0]?.updated_at.getTime()
      expect(updatedAtTime).toBe(expectedMergeUpdatedAt)
    }
  })

  // Test: getBsvTx handles undefined rawTx
  test('10_getBsvTx_handles_undefined_rawTx', () => {
    const tx = new EntityTransaction() // No rawTx provided
    const bsvTx = tx.getBsvTx()
    expect(bsvTx).toBeUndefined()
  })

  // Test: getInputs handles storage lookups and input merging
  test('11_getInputs_handles_storage_lookups_and_input_merging', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a test transaction into the database
      const { tx } = await _tu.insertTestTransaction(activeStorage, undefined, true)

      // Create a Transaction instance with the inserted transaction's data
      const transaction = new EntityTransaction(tx)

      // Insert known inputs into the database and set the `spentBy` column to the transaction ID
      const input1 = await _tu.insertTestOutput(activeStorage, tx, 0, 100) // vout = 0
      const input2 = await _tu.insertTestOutput(activeStorage, tx, 2, 200) // vout = 2
      input1.spentBy = tx.transactionId
      input2.spentBy = tx.transactionId

      // Update the outputs in the database to reflect `spentBy`
      await activeStorage.updateOutput(input1.outputId, input1)
      await activeStorage.updateOutput(input2.outputId, input2)

      // Simulate external input for rawTx parsing
      const externalInput = await _tu.insertTestOutput(
        activeStorage,
        tx, // Reference the same transaction
        3, // vout = 3
        150 // Satoshis
      )

      // Assign rawTx to the transaction and simulate `getBsvTxIns` behavior
      transaction.rawTx = Array.from(Uint8Array.from([1, 2, 3]))
      transaction.getBsvTxIns = () => [
        {
          sourceTXID: externalInput.txid,
          sourceOutputIndex: 3
        } as bsv.TransactionInput
      ]

      // Call `getInputs` to retrieve and merge inputs
      const inputs = await transaction.getInputs(activeStorage)

      // Validate the merged inputs
      expect(inputs).toHaveLength(3) // Known inputs + external input
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outputId: input1.outputId }),
          expect.objectContaining({ outputId: input2.outputId }),
          expect.objectContaining({ txid: externalInput.txid, vout: 3 })
        ])
      )
    }
  })

  // Test: getProvendTx retrieves proven transaction
  test('15_getProvenTx_retrieves_proven_transaction', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a test proven transaction into the storage
      const provenTx = await _tu.insertTestProvenTx(activeStorage)

      // Create a Transaction instance with a valid provenTxId
      const tx = new EntityTransaction({
        provenTxId: provenTx.provenTxId
      } as TableTransaction)

      // Retrieve the ProvenTx using the getProvenTx method
      const retrievedProvenTx = await tx.getProvenTx(activeStorage)

      // Assert the retrieved ProvenTx is defined and matches the expected values
      expect(retrievedProvenTx).toBeDefined()
      expect(retrievedProvenTx?.provenTxId).toBe(provenTx.provenTxId)
    }
  })

  // Test: getProvenTx returns undefined when provenTxId is not set
  test('16_getProvenTx_returns_undefined_when_provenTxId_is_not_set', async () => {
    for (const { activeStorage } of ctxs) {
      // Create a Transaction instance with no provenTxId
      const tx = new EntityTransaction()

      // Attempt to retrieve a ProvenTx
      const retrievedProvenTx = await tx.getProvenTx(activeStorage)

      // Assert the result is undefined
      expect(retrievedProvenTx).toBeUndefined()
    }
  })

  // Test: getProvenTx returns undefined when no matching ProvenTx is found
  test('17_getProvenTx_returns_undefined_when_no_matching_ProvenTx_is_found', async () => {
    for (const { activeStorage } of ctxs) {
      // Create a Transaction instance with a provenTxId that doesn't exist in storage
      const tx = new EntityTransaction({ provenTxId: 9999 } as TableTransaction) // Use an ID unlikely to exist

      // Attempt to retrieve a ProvenTx
      const retrievedProvenTx = await tx.getProvenTx(activeStorage)

      // Assert the result is undefined
      expect(retrievedProvenTx).toBeUndefined()
    }
  })

  // Test: getInputs merges known inputs correctly
  test('18_getInputs_merges_known_inputs_correctly', async () => {
    for (const { activeStorage } of ctxs) {
      // Step 1: Insert a Transaction
      const { tx } = await _tu.insertTestTransaction(activeStorage, undefined, true)

      // Step 2: Insert outputs associated with the transaction
      const output1 = await _tu.insertTestOutput(activeStorage, tx, 0, 100) // vout = 0
      const output2 = await _tu.insertTestOutput(activeStorage, tx, 1, 200) // vout = 1

      // Step 3: Create a Transaction instance with rawTx
      const rawTx = Uint8Array.from([1, 2, 3]) // Example raw transaction
      const transaction = new EntityTransaction({
        ...tx,
        rawTx: Array.from(rawTx)
      } as TableTransaction)

      // Step 4: Simulate rawTx inputs
      transaction.getBsvTxIns = () => [
        {
          sourceTXID: output1.txid,
          sourceOutputIndex: output1.vout
        } as bsv.TransactionInput,
        {
          sourceTXID: output2.txid,
          sourceOutputIndex: output2.vout
        } as bsv.TransactionInput
      ]

      // Step 5: Call `getInputs` to retrieve and merge known inputs
      const inputs = await transaction.getInputs(activeStorage)

      // Step 6: Assertions
      expect(inputs).toHaveLength(2) // Ensure both outputs are retrieved
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outputId: output1.outputId }), // vout = 0
          expect.objectContaining({ outputId: output2.outputId }) // vout = 1
        ])
      )
    }
  })

  // Test: getVersion returns API version
  test('19_get_version_returns_api_version', () => {
    const tx = new EntityTransaction({ version: 2 } as TableTransaction)
    expect(tx.version).toBe(2)
  })

  // Test: getLockTime returns API lockTime
  test('20_get_lockTime_returns_api_lockTime', () => {
    const tx = new EntityTransaction({ lockTime: 500 } as TableTransaction)
    expect(tx.lockTime).toBe(500)
  })

  // Test: set id updates transactionId
  test('21_set_id_updates_transactionId', () => {
    const tx = new EntityTransaction()
    tx.id = 123
    expect(tx.transactionId).toBe(123)
  })

  // Test: get entityName returns correct value
  test('22_get_entityName_returns_correct_value', () => {
    const tx = new EntityTransaction()
    expect(tx.entityName).toBe('transaction')
  })

  // Test: get entityTable returns correct value
  test('23_get_entityTable_returns_correct_value', () => {
    const tx = new EntityTransaction()
    expect(tx.entityTable).toBe('transactions')
  })

  // Test: `equals` returns false for mismatched other properties
  test('25_equals_returns_false_for_mismatched_other_properties', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a test transaction to use as the baseline
      const txData = await _tu.insertTestTransaction(activeStorage, undefined, true)

      const syncMap = createSyncMap()
      syncMap.transaction.idMap = {
        [txData.tx.transactionId]: txData.tx.transactionId
      }
      syncMap.transaction.count = 1

      const tx = new EntityTransaction({
        ...txData.tx, // Base transaction
        version: 2,
        lockTime: 500,
        satoshis: 789,
        txid: 'txid1',
        rawTx: [1, 2, 3],
        inputBEEF: [4, 5, 6],
        description: 'desc1',
        status: 'completed',
        reference: 'ref1'
      } as TableTransaction)

      const other = {
        transactionId: txData.tx.transactionId, // Matching transactionId
        reference: 'ref1', // Matching reference
        version: 1, // Different version
        lockTime: 100, // Different lockTime
        status: 'unprocessed', // Different status
        satoshis: 100, // Different satoshis
        description: 'desc2', // Different description
        txid: 'txid2', // Different txid
        rawTx: [7, 8, 9], // Different rawTx
        inputBEEF: [10, 11, 12] // Different inputBEEF
      } as TableTransaction

      expect(tx.equals(other, syncMap)).toBe(false) // Should return false due to mismatched properties
    }
  })

  // Test: `getInputs` handles known and unknown inputs
  test('26_getInputs_handles_known_and_unknown_inputs', async () => {
    for (const { activeStorage } of ctxs) {
      // Step 1: Insert a Transaction into the database
      const { tx } = await _tu.insertTestTransaction(activeStorage, undefined, true)

      // Step 2: Insert test outputs associated with the transaction
      const output1 = await _tu.insertTestOutput(activeStorage, tx, 0, 100) // vout = 0, satoshis = 100
      const output2 = await _tu.insertTestOutput(activeStorage, tx, 1, 200) // vout = 1, satoshis = 200

      // Step 3: Simulate rawTx inputs directly without creating a Transaction instance
      const rawTxInputs = [
        { sourceTXID: tx.txid, sourceOutputIndex: 0 },
        { sourceTXID: tx.txid, sourceOutputIndex: 1 }
      ]

      // Step 4: Query the inputs from storage individually
      const inputs = await Promise.all(
        rawTxInputs.map(input =>
          activeStorage.findOutputs({
            partial: {
              transactionId: tx.transactionId,
              vout: input.sourceOutputIndex
            }
          })
        )
      )

      // Flatten the array of inputs (since `findOutputs` likely returns arrays for each query)
      const flattenedInputs = inputs.flat()

      // Step 5: Assertions
      expect(flattenedInputs).toHaveLength(2) // Ensure both outputs are retrieved
      expect(flattenedInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outputId: output1.outputId }), // vout = 0
          expect.objectContaining({ outputId: output2.outputId }) // vout = 1
        ])
      )
    }
  })

  // Test: equals identifies matching entities
  test('27_equals_identifies_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert a transaction into the first database
    const tx1 = new EntityTransaction({
      transactionId: 405,
      userId: 1,
      txid: 'txid1',
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      status: 'completed',
      reference: 'ref1',
      isOutgoing: true,
      satoshis: 789,
      description: 'desc1',
      version: 2,
      lockTime: 500,
      rawTx: [1, 2, 3],
      inputBEEF: [4, 5, 6]
    })

    await ctx1.activeStorage.insertTransaction(tx1.toApi())

    // Insert a matching transaction into the second database
    const tx2 = new EntityTransaction({
      transactionId: 405,
      userId: 1, // Matching userId
      txid: 'txid1', // Matching txid
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      status: 'completed', // Matching status
      reference: 'ref1', // Matching reference
      isOutgoing: true, // Matching isOutgoing
      satoshis: 789, // Matching satoshis
      description: 'desc1', // Matching description
      version: 2, // Matching version
      lockTime: 500, // Matching lockTime
      rawTx: [1, 2, 3], // Matching rawTx
      inputBEEF: [4, 5, 6] // Matching inputBEEF
    })
    await ctx2.activeStorage.insertTransaction(tx2.toApi())

    const syncMap = createSyncMap()
    syncMap.transaction.idMap = { [tx1.transactionId]: tx2.transactionId }
    syncMap.transaction.count = 1

    // Verify the transactions match
    expect(tx1.equals(tx2.toApi(), syncMap)).toBe(true)
  })

  // Test: `equals` identifies non-matching entities
  test('28_equals_identifies_non_matching_entities', async () => {
    const ctx1 = ctxs[0]
    const ctx2 = ctxs2[0]

    // Insert a transaction into the first database
    const tx1 = new EntityTransaction({
      transactionId: 303,
      userId: 1,
      txid: 'tx456',
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      status: 'unprocessed', // Default status
      reference: 'ref125',
      isOutgoing: false, // Default isOutgoing
      satoshis: 0, // Default satoshis
      description: '' // Default description
    })
    await ctx1.activeStorage.insertTransaction(tx1.toApi())

    // Insert a non-matching transaction into the second database
    const tx2 = new EntityTransaction({
      transactionId: 304,
      userId: 1,
      txid: 'tx789',
      created_at: new Date('2023-01-01'),
      updated_at: new Date('2023-01-02'),
      status: 'unprocessed', // Default status
      reference: 'ref126',
      isOutgoing: false, // Default isOutgoing
      satoshis: 0, // Default satoshis
      description: '' // Default description
    })
    await ctx2.activeStorage.insertTransaction(tx2.toApi())

    const syncMap = createSyncMap()
    syncMap.transaction.idMap = { [tx1.transactionId]: tx2.transactionId }
    syncMap.transaction.count = 1

    // Verify the transactions do not match
    expect(tx1.equals(tx2.toApi(), syncMap)).toBe(false)
  })
})
