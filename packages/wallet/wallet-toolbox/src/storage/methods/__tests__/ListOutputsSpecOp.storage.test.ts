import type { Validation } from '@bsv/sdk'
import 'fake-indexeddb/auto'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { specOpInvalidChange } from '../../../sdk/types'
import type { WalletServices } from '../../../sdk/WalletServices.interfaces'
import { StorageIdb } from '../../StorageIdb'
import { StorageProvider } from '../../StorageProvider'
import type { TableOutput, TableUser } from '../../schema/tables'

describe('invalid-change special-operation storage parity', () => {
  jest.setTimeout(30_000)
  let storages: StorageProvider[] = []

  beforeEach(async () => {
    const sqlite = await _tu.createFreshSQLiteStorage({
      databasePrefix: 'invalidChangeSpecOp',
      migrationName: 'invalid-change spec-op storage parity'
    })
    const idb = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
    await idb.dropAllData()
    await idb.migrate(`invalid-change-${Date.now()}`, '1'.repeat(64))
    await idb.makeAvailable()
    storages = [sqlite, idb]
  })

  afterEach(async () => {
    for (const storage of storages) await storage.destroy()
  })

  function args(release: boolean): Validation.ValidListOutputsArgs {
    return {
      basket: specOpInvalidChange,
      tags: release ? ['release'] : [],
      tagQueryMode: 'all',
      includeLockingScripts: false,
      includeTransactions: false,
      includeCustomInstructions: false,
      includeTags: false,
      includeLabels: false,
      limit: 0,
      offset: 0,
      seekPermission: false,
      knownTxids: []
    }
  }

  async function seedOutput(storage: StorageProvider, user: TableUser, vout: number): Promise<TableOutput> {
    const { tx } = await _tu.insertTestTransaction(storage, user, false, {
      status: 'completed',
      txid: `${vout + 1}`.padStart(64, '0')
    })
    const basket = await storage.findOrInsertOutputBasket(user.userId, 'default')
    return await _tu.insertTestOutput(storage, tx, vout, 1_000 + vout, basket, false, {
      txid: tx.txid,
      lockingScript: [0],
      scriptLength: 1,
      scriptOffset: undefined,
      spendable: true,
      spentBy: undefined
    })
  }

  function setVerdicts(storage: StorageProvider, spentTxids: Set<string>): void {
    storage.setServices({
      hashOutputScript: () => 'aa'.repeat(32),
      getUtxoStatus: async (_hash, _format, outpoint) => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: !spentTxids.has(outpoint!.split('.')[0])
      })
    } as unknown as WalletServices)
  }

  test('SQLite and IndexedDB scan and atomically release the same confirmed-spent subset', async () => {
    for (const storage of storages) {
      const user = await _tu.insertTestUser(storage)
      const spent = await seedOutput(storage, user, 0)
      const unspent = await seedOutput(storage, user, 1)
      setVerdicts(storage, new Set([spent.txid!]))
      const auth = { userId: user.userId, identityKey: user.identityKey }

      const scan = await storage.listOutputs(auth, args(false))
      expect(scan.totalOutputs).toBe(1)
      expect(scan.outputs.map(output => output.outpoint)).toEqual([`${spent.txid}.0`])
      expect((await storage.findOutputById(spent.outputId))!.spendable).toBe(true)

      const release = await storage.listOutputs(auth, args(true))
      expect(release.totalOutputs).toBe(1)
      expect(release.outputs[0].spendable).toBe(false)
      expect((await storage.findOutputById(spent.outputId))!.spendable).toBe(false)
      expect((await storage.findOutputById(unspent.outputId))!.spendable).toBe(true)
      const events = await storage.findMonitorEvents({ partial: { event: 'InvalidChangeRelease' } })
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0].details!)).toMatchObject({
        userId: user.userId,
        confirmedSpent: 1,
        confirmedUnspent: 1,
        unknown: 0,
        released: 1
      })
    }
  })

  test('SQLite and IndexedDB roll back every output and audit write on a mid-release failure', async () => {
    for (const storage of storages) {
      const user = await _tu.insertTestUser(storage)
      const first = await seedOutput(storage, user, 0)
      const second = await seedOutput(storage, user, 1)
      setVerdicts(storage, new Set([first.txid!, second.txid!]))
      const originalUpdateOutput = storage.updateOutput.bind(storage)
      let updateCount = 0
      const updateSpy = jest.spyOn(storage, 'updateOutput').mockImplementation(async (...parameters) => {
        updateCount++
        if (updateCount === 2) throw new Error('injected write failure')
        return await originalUpdateOutput(...parameters)
      })

      await expect(
        storage.listOutputs({ userId: user.userId, identityKey: user.identityKey }, args(true))
      ).rejects.toThrow()
      updateSpy.mockRestore()

      expect((await storage.findOutputById(first.outputId))!.spendable).toBe(true)
      expect((await storage.findOutputById(second.outputId))!.spendable).toBe(true)
      await expect(
        storage.findMonitorEvents({
          partial: { event: 'InvalidChangeRelease' }
        })
      ).resolves.toHaveLength(0)
    }
  })
})
