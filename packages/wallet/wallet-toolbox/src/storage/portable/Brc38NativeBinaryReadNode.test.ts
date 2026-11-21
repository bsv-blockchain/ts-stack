import { isBrc38NativeBinaryReadTransaction, readBrc38NativeBinaryExtent } from './Brc38NativeBinaryReadNode'
import type { Knex } from 'knex'

// Entry refusal only. Genuine native view/large-record/postimage cases must run
// later on the fresh admitted packaged Linux engine; no mock grants admission.
test('copied native dialect and transaction flags cannot admit an extent reader', async () => {
  const counterfeit = Object.assign(() => {}, {
    isTransaction: true,
    client: { config: { client: 'OwnedNativeSqliteClient' } }
  })
  expect(isBrc38NativeBinaryReadTransaction(counterfeit)).toBe(false)
  await expect(
    readBrc38NativeBinaryExtent(counterfeit as unknown as Knex.Transaction, {
      table: 'transactions',
      field: 'rawTx',
      rowId: 1,
      offset: 0,
      totalBytes: 1,
      length: 1
    })
  ).rejects.toThrow('actual retained native')
})
test('original cancellation wins before attempting native membership or transport', async () => {
  const reason = new Error('read cancelled'),
    controller = new AbortController()
  controller.abort(reason)
  await expect(
    readBrc38NativeBinaryExtent(
      undefined as unknown as Knex.Transaction,
      { table: 'transactions', field: 'rawTx', rowId: 1, offset: 0, totalBytes: 1, length: 1 },
      controller.signal
    )
  ).rejects.toBe(reason)
})
