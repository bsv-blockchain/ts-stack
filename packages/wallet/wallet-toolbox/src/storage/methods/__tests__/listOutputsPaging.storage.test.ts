import type { Validation } from '@bsv/sdk'
import 'fake-indexeddb/auto'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { StorageIdb } from '../../StorageIdb'
import { StorageProvider } from '../../StorageProvider'
import type { TableOutput, TableUser } from '../../schema/tables'

/**
 * `totalOutputs` describes the whole result set, not the returned page: a full
 * page reports the count of every matching row. Paging to the end must not
 * change that number, and both storage backends must agree.
 */
describe('listOutputs paging reports a stable total', () => {
  jest.setTimeout(30_000)
  const seededOutputs = 5
  const pageLimit = 2
  let storages: { name: string; storage: StorageProvider }[] = []

  beforeEach(async () => {
    const sqlite = await _tu.createFreshSQLiteStorage({
      databasePrefix: 'listOutputsPaging',
      migrationName: 'listOutputs paging total'
    })
    const idb = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
    await idb.dropAllData()
    await idb.migrate(`list-outputs-paging-${Date.now()}`, '1'.repeat(64))
    await idb.makeAvailable()
    storages = [
      { name: 'sqlite', storage: sqlite },
      { name: 'idb', storage: idb }
    ]
  })

  afterEach(async () => {
    for (const { storage } of storages) await storage.destroy()
  })

  function args(offset: number): Validation.ValidListOutputsArgs {
    return {
      basket: 'default',
      tags: [],
      tagQueryMode: 'all',
      includeLockingScripts: false,
      includeTransactions: false,
      includeCustomInstructions: false,
      includeTags: false,
      includeLabels: false,
      limit: pageLimit,
      offset,
      seekPermission: false,
      knownTxids: []
    }
  }

  async function seedOutput(
    storage: StorageProvider,
    user: TableUser,
    index: number
  ): Promise<TableOutput> {
    const { tx } = await _tu.insertTestTransaction(storage, user, false, {
      status: 'completed',
      txid: `${index + 1}`.padStart(64, '0')
    })
    const basket = await storage.findOrInsertOutputBasket(user.userId, 'default')
    return await _tu.insertTestOutput(storage, tx, 0, 1_000 + index, basket, false, {
      txid: tx.txid,
      lockingScript: [0],
      scriptLength: 1,
      scriptOffset: undefined,
      spendable: true,
      spentBy: undefined
    })
  }

  /** Pages the seeded basket at each offset, per backend. */
  async function totalsByBackend(
    offsets: number[],
    seed = seededOutputs
  ): Promise<Record<string, { lengths: number[]; totals: number[] }>> {
    const byBackend: Record<string, { lengths: number[]; totals: number[] }> = {}
    for (const { name, storage } of storages) {
      const user = await _tu.insertTestUser(storage)
      for (let index = 0; index < seed; index++) {
        await seedOutput(storage, user, index)
      }
      const auth = { userId: user.userId, identityKey: user.identityKey }
      const pages = await Promise.all(
        offsets.map(offset => storage.listOutputs(auth, args(offset)))
      )
      byBackend[name] = {
        lengths: pages.map(page => page.outputs.length),
        totals: pages.map(page => page.totalOutputs)
      }
    }
    return byBackend
  }

  test('every ascending page reports the full count, including the short last page', async () => {
    // Offsets 0 and 2 return full pages; offset 4 returns the final short page,
    // which previously reported its own length as the grand total.
    const expected = { lengths: [2, 2, 1], totals: [5, 5, 5] }
    expect(await totalsByBackend([0, 2, 4])).toEqual({
      sqlite: expected,
      idb: expected
    })
  })

  test('newest-first paging by negative offset also reports the full count', async () => {
    // A negative offset selects descending order starting at `-offset - 1`, so
    // -1, -3 and -5 walk the same five rows newest first.
    const expected = { lengths: [2, 2, 1], totals: [5, 5, 5] }
    expect(await totalsByBackend([-1, -3, -5])).toEqual({
      sqlite: expected,
      idb: expected
    })
  })

  test('an empty page past the end counts the total instead of echoing the offset', async () => {
    const expected = { lengths: [0, 0], totals: [5, 5] }
    expect(await totalsByBackend([seededOutputs, 100])).toEqual({
      sqlite: expected,
      idb: expected
    })
  })

  test('an empty basket still reports a zero total', async () => {
    const expected = { lengths: [0], totals: [0] }
    expect(await totalsByBackend([0], 0)).toEqual({
      sqlite: expected,
      idb: expected
    })
  })
})
