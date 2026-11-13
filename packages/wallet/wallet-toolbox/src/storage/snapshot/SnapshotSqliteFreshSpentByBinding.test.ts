import createKnex from 'knex'
import { rebindFreshSnapshotSqliteSpentByIndex } from '../schema/snapshotSqliteIndexGeneration'

test('ordinary SQLite cannot authorize private spentBy source rebinding', async () => {
  const k = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  let invoked = false
  try {
    await k.transaction(async trx => {
      await trx.raw('CREATE TABLE outputs(outputId INTEGER PRIMARY KEY,spentBy INTEGER)')
      await trx.raw('CREATE INDEX idx_outputs_spentby ON outputs(spentBy)')
      const before = await trx('sqlite_schema').orderBy('name')
      await expect(
        rebindFreshSnapshotSqliteSpentByIndex(trx, async () => {
          invoked = true
          await trx.raw('DROP INDEX idx_outputs_spentby')
        })
      ).rejects.toThrow('fresh private native writer')
      expect(invoked).toBe(false)
      expect(await trx('sqlite_schema').orderBy('name')).toEqual(before)
    })
  } finally {
    await k.destroy()
  }
})
