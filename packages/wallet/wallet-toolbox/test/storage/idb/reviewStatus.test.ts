import { _tu } from '../../utils/TestUtilsWalletStorage'
import { sdk, StorageProviderOptions, verifyOne } from '../../../src/index.client'
import { setLogging } from '../../utils/TestUtilsWalletStorage'
import { StorageIdb } from '../../../src/storage/StorageIdb'

import 'fake-indexeddb/auto'

setLogging(false)

describe('idb reviewStatus tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  let storage: StorageIdb

  beforeEach(async () => {
    const options: StorageProviderOptions = StorageIdb.createStorageBaseOptions(chain)
    storage = new StorageIdb(options)
    await storage.dropAllData()
    await storage.migrate('idb reviewStatus tests', '1'.repeat(64))
    await storage.makeAvailable()
  })

  afterEach(async () => {
    await storage.destroy()
  })

  test('restores failed transaction inputs and neutralizes failed transaction outputs', async () => {
    const { tx: fundingTx, user } = await _tu.insertTestTransaction(storage, undefined, false, {
      status: 'completed',
      txid: 'b'.repeat(64)
    })
    const { tx: failedTx } = await _tu.insertTestTransaction(storage, user, false, {
      status: 'failed',
      txid: 'c'.repeat(64)
    })
    const inputOutput = await _tu.insertTestOutput(storage, fundingTx, 0, 1000, undefined, false, {
      spendable: false,
      spentBy: failedTx.transactionId
    })
    const generatedOutput = await _tu.insertTestOutput(storage, failedTx, 0, 900, undefined, false, {
      spendable: true,
      spentBy: failedTx.transactionId
    })

    await storage.reviewStatus({ agedLimit: new Date() })

    const inputAfter = verifyOne(await storage.findOutputs({ partial: { outputId: inputOutput.outputId } }))
    expect(inputAfter.spendable).toBe(true)
    expect(inputAfter.spentBy).toBeUndefined()

    const generatedAfter = verifyOne(await storage.findOutputs({ partial: { outputId: generatedOutput.outputId } }))
    expect(generatedAfter.spendable).toBe(false)
    expect(generatedAfter.spentBy).toBeUndefined()
  })
})
