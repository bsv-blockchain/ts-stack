import {
  installBrc38StructuredNativeReceiverSchema,
  verifyBrc38StructuredNativeReceiverSchema
} from './Brc38StructuredNativeReceiverSchemaNode'
import type { Knex } from 'knex'

test('copied SQLite configuration cannot install or verify a structured native receiver schema', async () => {
  const sql = jest.fn(),
    forged = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } },
      raw: jest.fn()
    }) as unknown as Knex.Transaction
  await expect(installBrc38StructuredNativeReceiverSchema(forged)).rejects.toThrow('receiver schema differs')
  await expect(verifyBrc38StructuredNativeReceiverSchema(forged)).rejects.toThrow('receiver schema differs')
  expect(sql).not.toHaveBeenCalled()
  expect(forged.raw).not.toHaveBeenCalled()
})
