import { _tu } from '../utils/TestUtilsWalletStorage'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { selectReqReview } from '../../src/storage/adminServer/reqReviewQuery'
import { WalletServices } from '../../src/sdk/WalletServices.interfaces'

const day = 24 * 60 * 60 * 1000

describe('adminStats and admin req review', () => {
  jest.setTimeout(99999999)

  let storages: StorageProvider[] = []

  beforeEach(async () => {
    storages = await _tu.createTestStorages({ databasePrefix: 'adminstats', migrationName: 'adminStats tests' })
    for (const storage of storages) {
      storage.setServices({ getServicesCallHistory: () => ({}) } as unknown as WalletServices)
    }
  })

  afterEach(async () => {
    for (const storage of storages) await storage.destroy()
  })

  test('adminStats counts by period on MySQL and Postgres and is not implemented on SQLite', async () => {
    const env = _tu.getEnvFlags('test')
    expect(storages.map(s => s.dbtype)).toEqual([
      'SQLite',
      ...(env.runMySQL ? ['MySQL'] : []),
      ...(env.runPostgres ? ['Postgres'] : [])
    ])
    for (const storage of storages) {
      const old = new Date(Date.now() - 40 * day)
      const user = await _tu.insertTestUser(storage)
      const basket = await _tu.insertTestOutputBasket(storage, user)
      const { tx: completed } = await _tu.insertTestTransaction(storage, user, false, { status: 'completed' })
      await _tu.insertTestOutput(storage, completed, 0, 1000, basket, false, { change: true })
      await _tu.insertTestOutput(storage, completed, 1, 500, basket, false, { change: false })
      await _tu.insertTestTransaction(storage, user, false, { status: 'failed' })
      await _tu.insertTestTransaction(storage, user, false, { status: 'failed', txid: undefined })
      await _tu.insertTestTransaction(storage, user, false, { status: 'unproven' })
      const { tx: oldCompleted } = await _tu.insertTestTransaction(storage, user, false, {
        status: 'completed',
        created_at: old
      })
      await _tu.insertTestOutput(storage, oldCompleted, 0, 300, basket, false, { change: true, created_at: old })

      if (storage.dbtype === 'SQLite') {
        await expect(storage.adminStats('admin')).rejects.toThrow('only MySQL and Postgres are supported')
        continue
      }

      const r = await storage.adminStats('admin')
      expect(r.requestedBy).toBe('admin')
      expect(r).toMatchObject({
        usersDay: 1,
        usersTotal: 1,
        transactionsDay: 4,
        transactionsMonth: 4,
        transactionsTotal: 5,
        txCompletedDay: 1,
        txCompletedTotal: 2,
        txFailedDay: 1,
        txFailedTotal: 1,
        txAbandonedDay: 1,
        txAbandonedTotal: 1,
        txUnprovenWeek: 1,
        txSendingTotal: 0,
        satoshisDefaultDay: 1000,
        satoshisDefaultMonth: 1000,
        satoshisDefaultTotal: 1300,
        satoshisOtherDay: 500,
        satoshisOtherTotal: 500,
        basketsTotal: 1,
        labelsTotal: 0,
        tagsTotal: 0
      })
      const names = [
        'users',
        'transactions',
        'txCompleted',
        'txFailed',
        'txAbandoned',
        'txUnprocessed',
        'txSending',
        'txUnproven',
        'txUnsigned',
        'txNosend',
        'txNonfinal',
        'txUnfail',
        'satoshisDefault',
        'satoshisOther',
        'baskets',
        'labels',
        'tags'
      ].flatMap(name => ['Day', 'Week', 'Month', 'Total'].map(period => `${name}${period}`))
      for (const name of names) expect(typeof (r as unknown as Record<string, unknown>)[name]).toBe('number')
    }
  })

  test('req review reports age and hex columns on MySQL and Postgres', async () => {
    for (const storage of storages) {
      if (storage.dbtype === 'SQLite') continue
      const knex = (storage as StorageKnex).knex
      const user = await _tu.insertTestUser(storage)
      const { tx } = await _tu.insertTestTransaction(storage, user, false, { status: 'unproven' })
      // Server clock: the driver writes Dates in the client time zone, which may differ from the server's.
      const created = knex.raw(
        storage.dbtype === 'Postgres' ? "now() - interval '125 minutes'" : 'NOW() - INTERVAL 125 MINUTE'
      )
      await _tu.insertTestProvenTxReq(storage, tx.txid!, undefined, false)
      await knex('proven_tx_reqs').where({ txid: tx.txid }).update({ created_at: created, rawTx: Buffer.from([1, 2, 0xab]) })

      const { total, rows } = await selectReqReview(knex, { txid: tx.txid, minTransactionId: 0, limit: 25, offset: 0 })
      expect(total).toBe(1)
      expect(rows).toHaveLength(1)
      expect(rows[0].rawTxHex).toBe('0102AB')
      expect(Number(rows[0].hoursOld)).toBe(2)
      expect(Number(rows[0].minutesOld)).toBeGreaterThanOrEqual(125)
      expect(Number(rows[0].minutesOld)).toBeLessThan(135)
    }
  })
})
