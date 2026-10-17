import fc from 'fast-check'
import createKnex from 'knex'
import { installBrc38ImportJournalSchema, verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchemaBody'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

describe('private journal schema enforces durable mapping scope and accounting', () => {
  test('generated reservations charge exactly once and require owned immutable cleanup', async () => {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await db.raw('PRAGMA foreign_keys=ON')
      await db.transaction(async trx => {
        await installBrc38ImportJournalSchema(trx)
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: -16, max: 16 }),
            fc.integer({ min: 0, max: 8 }),
            async (userId, capacity) => {
              const scope = {
                importId: 'generated-owned-import',
                bindingSha256: 'b'.repeat(64),
                archiveSha256: 'a'.repeat(64),
                userId
              }
              await trx('brc38_import_journal').insert({
                ...scope,
                maximumMappedIds: capacity,
                admissionJson: '{}',
                admissionSha256: 'c'.repeat(64),
                receiptJson: '{}',
                receiptSha256: 'd'.repeat(64)
              })
              const mapping = { ...scope, entity: 'transaction', incomingId: '0', localId: 100 }
              await expect(trx('brc38_import_ids').insert({ ...mapping, userId: userId + 1 })).rejects.toThrow(
                'scope or quota differs'
              )
              for (let index = 0; index < capacity; index++) {
                await trx('brc38_import_ids').insert({
                  ...mapping,
                  incomingId: String(index),
                  localId: 100 + index
                })
                expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(
                  index + 1
                )
                expect(await trx('brc38_import_ids').where(scope).count({ count: '*' })).toEqual([{ count: index + 1 }])
                await expect(
                  trx('brc38_import_ids')
                    .where({ ...scope, incomingId: String(index) })
                    .update({ localId: 999 })
                ).rejects.toThrow('immutable')
              }
              await expect(trx('brc38_import_ids').insert({ ...mapping, incomingId: 'over-capacity' })).rejects.toThrow(
                'scope or quota differs'
              )
              if (capacity > 0) {
                await expect(trx('brc38_import_ids').where(scope).del()).rejects.toThrow('owned cleanup')
                expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(
                  capacity
                )
              }
              await trx('brc38_import_journal').where({ importId: scope.importId }).update({ cleanupAllowed: 1 })
              await expect(trx('brc38_import_ids').insert({ ...mapping, incomingId: 'after-cleanup' })).rejects.toThrow(
                'scope or quota differs'
              )
              await trx('brc38_import_ids').where(scope).del()
              expect((await trx('brc38_import_journal').where({ importId: scope.importId }).first()).mappedIds).toBe(0)
              expect(await trx('brc38_import_ids').count({ count: '*' })).toEqual([{ count: 0 }])
              await verifyBrc38ImportJournalSchema(trx)
              await trx('brc38_import_journal').where({ importId: scope.importId }).del()
            }
          ),
          {
            interruptAfterTimeLimit: 150000,
            markInterruptAsFailure: true,
            path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
          }
        )
      })
    } finally {
      await db.destroy()
    }
  }, 30000)
})
