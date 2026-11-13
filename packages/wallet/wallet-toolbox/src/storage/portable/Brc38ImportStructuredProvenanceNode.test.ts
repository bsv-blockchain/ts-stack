import type { Knex } from 'knex'
import {
  installBrc38ImportStructuredProvenanceSchema,
  verifyBrc38ImportStructuredProvenanceSchema,
  readBrc38ImportStructuredOriginal
} from './Brc38ImportStructuredProvenanceNode'

test('structured provenance cannot use copied backend or transaction labels before SQL access', async () => {
  const sql = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } },
      raw: sql
    }) as unknown as Knex.Transaction
  await expect(installBrc38ImportStructuredProvenanceSchema(trx)).rejects.toThrow()
  await expect(verifyBrc38ImportStructuredProvenanceSchema(trx)).rejects.toThrow()
  await expect(
    readBrc38ImportStructuredOriginal(
      trx,
      {
        importId: 'f7fc9300-9b15-4d8d-8b1c-a3bead817342',
        bindingSha256: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        userId: 1
      },
      0,
      1000
    )
  ).rejects.toThrow()
  expect(sql).not.toHaveBeenCalled()
})
