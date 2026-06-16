import { sdk, StorageProviderOptions } from '../../../src/index.client'
import { setLogging } from '../../utils/TestUtilsWalletStorage'
import { StorageIdb } from '../../../src/storage/StorageIdb'
import {
  expectFailedTransactionOutputStateRepaired,
  seedFailedTransactionOutputState
} from '../failedTransactionOutputHelpers'

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
    const state = await seedFailedTransactionOutputState(storage, 'failed')

    await storage.reviewStatus({ agedLimit: new Date() })
    await expectFailedTransactionOutputStateRepaired(storage, state)
  })
})
