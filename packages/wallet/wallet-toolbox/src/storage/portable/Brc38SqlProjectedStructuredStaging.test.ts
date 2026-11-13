import type { Knex } from 'knex'
import {
  installBrc38SqlProjectedStructuredSchema,
  beginBrc38SqlProjectedStructuredField,
  appendBrc38SqlProjectedStructuredField,
  finishBrc38SqlProjectedStructuredField,
  verifyBrc38SqlProjectedStructuredCompleteField,
  readBrc38SqlProjectedStructuredDescriptors
} from './Brc38SqlProjectedStructuredStaging'

test('copied read/writer labels cannot install, append, seal or read private projection content', async () => {
  const sql = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: class OwnedNativeSqliteClient {} }, dialect: 'sqlite3' },
      raw: sql
    }) as unknown as Knex.Transaction
  await expect(installBrc38SqlProjectedStructuredSchema(trx)).rejects.toThrow()
  await expect(
    beginBrc38SqlProjectedStructuredField(trx, 'provenTxReqs', 0, 'notify', 'utf8-json', 1000, 10000, 10, {
      field: 'notify',
      encoding: 'utf8-json',
      bytes: 2,
      sha256: 'a'.repeat(64)
    })
  ).rejects.toThrow()
  await expect(
    appendBrc38SqlProjectedStructuredField(trx, 'provenTxReqs', 0, 'notify', 0, new Uint8Array([123, 125]), 10000)
  ).rejects.toThrow()
  await expect(
    finishBrc38SqlProjectedStructuredField(
      trx,
      'provenTxReqs',
      0,
      { field: 'notify', encoding: 'utf8-json', bytes: 2, sha256: 'a'.repeat(64) },
      () => {}
    )
  ).rejects.toThrow()
  await expect(readBrc38SqlProjectedStructuredDescriptors(trx, 'provenTxReqs', 0)).rejects.toThrow(
    'authenticated published-profile'
  )
  await expect(
    verifyBrc38SqlProjectedStructuredCompleteField(
      trx,
      'provenTxReqs',
      0,
      { field: 'notify', encoding: 'utf8-json', bytes: 2, sha256: 'a'.repeat(64) },
      () => {}
    )
  ).rejects.toThrow()
  expect(sql).not.toHaveBeenCalled()
})
