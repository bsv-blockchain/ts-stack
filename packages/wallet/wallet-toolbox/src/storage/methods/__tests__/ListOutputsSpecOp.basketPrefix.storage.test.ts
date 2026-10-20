import type { Validation } from '@bsv/sdk'
import 'fake-indexeddb/auto'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { specOpBasketPrefixOutputs, TransactionStatus } from '../../../sdk/types'
import { StorageIdb } from '../../StorageIdb'
import { StorageProvider } from '../../StorageProvider'
import type { TableOutput, TableTransaction, TableUser } from '../../schema/tables'

describe('basket-prefix special-operation storage parity', () => {
  jest.setTimeout(30_000)
  let storages: StorageProvider[] = []

  beforeEach(async () => {
    const sqlite = await _tu.createFreshSQLiteStorage({
      databasePrefix: 'basketPrefixSpecOp',
      migrationName: 'basket-prefix spec-op storage parity'
    })
    const idb = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
    await idb.dropAllData()
    await idb.migrate(`basket-prefix-${Date.now()}`, '1'.repeat(64))
    await idb.makeAvailable()
    storages = [sqlite, idb]
  })

  afterEach(async () => {
    for (const storage of storages) await storage.destroy()
  })

  function args(tags: string[]): Validation.ValidListOutputsArgs {
    return {
      basket: specOpBasketPrefixOutputs,
      tags,
      tagQueryMode: 'any',
      includeLockingScripts: true,
      includeTransactions: false,
      includeCustomInstructions: true,
      includeTags: false,
      includeLabels: false,
      limit: 10,
      offset: 0,
      seekPermission: false,
      knownTxids: []
    }
  }

  async function seedTransaction(
    storage: StorageProvider,
    user: TableUser,
    n: number,
    status: TransactionStatus
  ): Promise<TableTransaction> {
    const { tx } = await _tu.insertTestTransaction(storage, user, false, {
      status,
      txid: `${n}`.padStart(64, '0')
    })
    return tx
  }

  async function seedOutput(
    storage: StorageProvider,
    user: TableUser,
    tx: TableTransaction,
    basketName: string,
    partial: Partial<TableOutput> = {}
  ): Promise<TableOutput> {
    const basket = await storage.findOrInsertOutputBasket(user.userId, basketName)
    return await _tu.insertTestOutput(storage, tx, 0, 1, basket, false, {
      txid: tx.txid,
      lockingScript: [0x51],
      scriptLength: 1,
      scriptOffset: undefined,
      customInstructions: basketName,
      spendable: true,
      spentBy: undefined,
      ...partial
    })
  }

  test('SQLite and IndexedDB list unspent and reserved outputs from every basket in the namespace', async () => {
    for (const storage of storages) {
      const user = await _tu.insertTestUser(storage)
      const auth = { userId: user.userId, identityKey: user.identityKey }
      const pendingSpender = await seedTransaction(storage, user, 90, 'unsigned')
      const completedSpender = await seedTransaction(storage, user, 91, 'completed')

      await seedOutput(storage, user, await seedTransaction(storage, user, 3, 'completed'), 'p color aaa')
      await seedOutput(storage, user, await seedTransaction(storage, user, 1, 'unproven'), 'p color bbb authority', {
        spendable: false,
        spentBy: pendingSpender.transactionId
      })
      await seedOutput(storage, user, await seedTransaction(storage, user, 2, 'completed'), 'p color aaa', {
        spendable: false,
        spentBy: completedSpender.transactionId
      })
      await seedOutput(storage, user, await seedTransaction(storage, user, 4, 'unsigned'), 'p color aaa')
      await seedOutput(storage, user, await seedTransaction(storage, user, 8, 'unprocessed'), 'p color ccc')
      await seedOutput(storage, user, await seedTransaction(storage, user, 5, 'completed'), 'p colorful aaa')
      await seedOutput(storage, user, await seedTransaction(storage, user, 6, 'completed'), 'p btms aaa')
      await seedOutput(storage, user, await seedTransaction(storage, user, 7, 'completed'), 'default')

      const result = await storage.listOutputs(auth, args(['p color']))

      expect(result.totalOutputs).toBe(3)
      expect(result.outputs).toEqual([
        {
          outpoint: `${'1'.padStart(64, '0')}.0`,
          satoshis: 1,
          spendable: false,
          lockingScript: '51',
          customInstructions: 'p color bbb authority'
        },
        {
          outpoint: `${'3'.padStart(64, '0')}.0`,
          satoshis: 1,
          spendable: true,
          lockingScript: '51',
          customInstructions: 'p color aaa'
        },
        {
          outpoint: `${'8'.padStart(64, '0')}.0`,
          satoshis: 1,
          spendable: true,
          lockingScript: '51',
          customInstructions: 'p color ccc'
        }
      ])
    }
  })

  test('SQLite and IndexedDB require a basket namespace', async () => {
    for (const storage of storages) {
      const user = await _tu.insertTestUser(storage)
      await expect(
        storage.listOutputs({ userId: user.userId, identityKey: user.identityKey }, args([]))
      ).rejects.toThrow('basket namespace')
    }
  })
})
