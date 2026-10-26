import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'

const txid = 'ab'.repeat(32)
const bytes = [0, 1, 2, 128, 255]

async function coldStorage(proven = true): Promise<StorageKnex> {
  const storage = new StorageKnex({
    ...StorageKnex.defaultOptions(),
    chain: 'test',
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 500
    })
  })
  await storage.migrate('committed', '1'.repeat(64))
  if (proven) {
    await storage.knex('proven_txs').insert({
      txid,
      rawTx: Buffer.from(bytes),
      height: 1,
      index: 0,
      merklePath: Buffer.from([0]),
      blockHash: '11'.repeat(32),
      merkleRoot: '22'.repeat(32)
    })
  } else {
    await storage.knex('proven_tx_reqs').insert({ txid, rawTx: Buffer.from(bytes), status: 'completed' })
  }
  expect(storage.isAvailable()).toBe(false)
  return storage
}

describe('cold transaction-owned raw transaction reads', () => {
  test('compiles MySQL slices from transaction-local settings without populating the global cache', async () => {
    const database = knex({ client: 'mysql2' })
    const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'test', knex: database })
    const queries: Knex.Sql[] = []
    jest.spyOn(database.client, 'runner').mockImplementation(query => ({
      run: async () => {
        const compiled = (query as Knex.QueryBuilder).toSQL()
        queries.push(compiled)
        if (compiled.sql.includes('`settings`')) {
          return [
            {
              created_at: new Date('2026-09-01'),
              updated_at: new Date('2026-09-01'),
              storageName: 'transaction-local',
              storageIdentityKey: '1'.repeat(64),
              chain: 'test',
              dbtype: 'MySQL',
              maxOutputScript: 1000
            }
          ]
        }
        return [{ rawTx: Buffer.from([1, 2, 128]) }]
      }
    }))
    try {
      await expect(storage.getRawTxOfKnownValidTransaction(txid, 1, 3, database)).resolves.toEqual([1, 2, 128])
      expect(queries).toHaveLength(2)
      expect(queries[0].sql).toBe('select * from `settings`')
      expect(queries[1].sql).toBe(
        'select substring(`rawTx` from ? for ?) as `rawTx` from `proven_txs` where `txid` = ?'
      )
      expect(queries[1].bindings).toEqual([2, 3, txid])
      expect(storage.isAvailable()).toBe(false)
    } finally {
      await storage.destroy()
    }
  })

  test.each([true, false])('reads full and sliced bytes from proven=%s without a second connection', async proven => {
    const storage = await coldStorage(proven)
    const background = jest.spyOn(storage, 'startPreparedBeefBackfill')
    try {
      await storage.transaction(async trx => {
        await expect(storage.getRawTxOfKnownValidTransaction(txid, undefined, undefined, trx)).resolves.toEqual(bytes)
        await expect(storage.getRawTxOfKnownValidTransaction(txid, 1, 3, trx)).resolves.toEqual([1, 2, 128])
        await expect(storage.getRawTxOfKnownValidTransaction(txid, 0, 0, trx)).resolves.toEqual([])
        await expect(storage.getRawTxOfKnownValidTransaction(txid, 99, 2, trx)).resolves.toEqual([])
        await expect(
          storage.getRawTxOfKnownValidTransaction('cd'.repeat(32), undefined, undefined, trx)
        ).resolves.toBeUndefined()
        await expect(storage.getRawTxOfKnownValidTransaction('cd'.repeat(32), 0, 1, trx)).resolves.toBeUndefined()
        expect(storage.isAvailable()).toBe(false)
      })
      expect(background).not.toHaveBeenCalled()
      await expect(storage.getRawTxOfKnownValidTransaction(txid)).resolves.toEqual(bytes)
      expect(storage.isAvailable()).toBe(true)
      expect(background).toHaveBeenCalledTimes(1)
      await storage.transaction(async trx => {
        await expect(storage.getRawTxOfKnownValidTransaction(txid, 2, 2, trx)).resolves.toEqual([2, 128])
      })
    } finally {
      await storage.destroy()
    }
  })

  test.each([true, false])('keeps transaction-local settings out of the global cache (rollback=%s)', async rollback => {
    const storage = await coldStorage()
    const background = jest.spyOn(storage, 'startPreparedBeefBackfill')
    try {
      const result = storage.knex.transaction(async trx => {
        await trx('settings').update({ storageName: 'uncommitted' })
        await expect(storage.getRawTxOfKnownValidTransaction(txid, 1, 1, trx)).resolves.toEqual([1])
        expect(storage.isAvailable()).toBe(false)
        expect(background).not.toHaveBeenCalled()
        if (rollback) throw new Error('caller rollback')
      })
      if (rollback) await expect(result).rejects.toThrow('caller rollback')
      else await result
      expect(storage.isAvailable()).toBe(false)
      const settings = await storage.makeAvailable()
      expect(settings.storageName).toBe(rollback ? 'committed' : 'uncommitted')
    } finally {
      await storage.destroy()
    }
  })
})
