import type { Knex } from 'knex'
import {
  requireBrc38StructuredProjectionRead,
  withBrc38PublishedStructuredFieldSource
} from './Brc38PublishedStructuredSourceNode'

test('a copied published/read-only SQLite label cannot acquire a structured source or touch SQL', async () => {
  const sql = jest.fn(),
    k = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } },
      raw: jest.fn()
    }) as unknown as Knex.Transaction,
    callback = jest.fn(async () => undefined)
  expect(() => requireBrc38StructuredProjectionRead(k)).toThrow()
  await expect(
    withBrc38PublishedStructuredFieldSource(
      k,
      'provenTxReqs',
      0,
      'notify',
      {
        privateIndexParent: '/tmp',
        maximumTemporaryIndexBytes: 1048576,
        maximumIndexMembers: 100,
        maximumStructuredBytes: 1000,
        maximumCanonicalBytes: 1000,
        maximumCombinedTemporaryBytes: 3145728,
        expiresAt: Date.now() + 60000
      },
      callback
    )
  ).rejects.toThrow()
  expect(sql).not.toHaveBeenCalled()
  expect(k.raw).not.toHaveBeenCalled()
  expect(callback).not.toHaveBeenCalled()
})
