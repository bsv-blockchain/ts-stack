import type { Knex } from 'knex'
import { visitBrc38SqlStructuredChunkWindows } from './Brc38SqlStructuredChunkWindowNode'
import { readBrc38SqlStructuredRange } from './Brc38SqlStructuredStaging'
import { readBrc38SqlCanonicalStructuredRange } from './Brc38SqlCanonicalStructuredStaging'
import { readBrc38SqlProjectedStructuredRange } from './Brc38SqlProjectedStructuredStaging'

// Negative copied-actor cases only. No invented flags supply positive native
// execution, resource, source, schema, profile or semantic proof.
test('bounded chunk and range paths refuse counterfeit native actors before SQL', async () => {
  const sql = jest.fn(() => {
      throw new Error('Counterfeit SQL must not run')
    }),
    k = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: 'OwnedNativeSqliteClient' } }
    }) as unknown as Knex.Transaction,
    descriptor = { field: 'history', encoding: 'utf8-json' as const, bytes: 128, sha256: 'a'.repeat(64) },
    visit = jest.fn()
  for (const width of [0, 1, 64, 1024, 65537, NaN]) {
    await expect(
      visitBrc38SqlStructuredChunkWindows(
        k,
        'private_structured_chunks',
        { tableName: 'provenTxReqs', position: 0, field: 'history', offset: 0 },
        width,
        () => {},
        visit
      )
    ).rejects.toThrow('authenticated published-profile')
    for (const read of [
      readBrc38SqlStructuredRange,
      readBrc38SqlCanonicalStructuredRange,
      readBrc38SqlProjectedStructuredRange
    ])
      await expect(read(k, 'provenTxReqs', 0, 'history', 0, 64, descriptor, width)).rejects.toThrow(
        'authenticated published-profile'
      )
  }
  expect(sql).not.toHaveBeenCalled()
  expect(visit).not.toHaveBeenCalled()
})
