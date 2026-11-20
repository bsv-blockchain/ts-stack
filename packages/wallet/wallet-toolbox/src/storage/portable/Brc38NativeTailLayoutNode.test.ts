import type { Knex } from 'knex'
import { installBrc38NativeTailLayout } from './Brc38NativeTailLayoutNode'

test('fresh layout rejects a counterfeit native writer before inspecting or mutating schema', async () => {
  const sql = jest.fn(),
    counterfeit = Object.assign(() => {}, {
      isTransaction: true,
      raw: sql,
      client: { config: { client: 'OwnedNativeSqliteClient' } }
    })
  await expect(installBrc38NativeTailLayout(counterfeit as unknown as Knex.Transaction)).rejects.toThrow(
    'Fresh private native'
  )
  expect(sql).not.toHaveBeenCalled()
})
// Actual SQLite DDL equivalence, large consecutive-zero reservations, preserved
// constraints/indexes/IDs/journal and failed-transaction rollback are independent
// fresh packaged Linux qualification cases after implementation is complete.
