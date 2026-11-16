import fc from 'fast-check'
import { fixture, exact, value, keyOf, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'

test.each([false, true])(
  'all families retain exact memberships through replacements and nested ownership, recursive=%s',
  async recursive => {
    const k = await fixture('BINARY', recursive)
    try {
      for (const table of tables) for (const id of [1, 2]) await k(table).insert(value(table, id, id, id))
      await exact(k)
      await k.raw(
        'CREATE TRIGGER nested_transaction_owner AFTER INSERT ON transactions WHEN NEW.userId=2 BEGIN UPDATE transactions SET userId=3 WHERE transactionId=NEW.transactionId; END'
      )
      await replace(k, 'transactions', value('transactions', 1, 2, 2))
      await exact(k)
      for (const table of tables) {
        await replace(k, table, value(table, 1, 1, 3))
        await exact(k)
        const query = k(table)
          .where(keyOf(table, 2, 2))
          .update(value(table, 1, 1, 3))
          .toSQL()
        await k.raw(query.sql.replace(/^update/i, 'UPDATE OR IGNORE'), query.bindings)
        await exact(k)
      }
    } finally {
      await k.destroy()
    }
  }
)

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'all-family independent source oracle survives %s conflict schedules',
  async collation => {
    const k = await fixture(collation, false)
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.array(
            fc.record({
              table: fc.integer({ min: 0, max: 12 }),
              kind: fc.integer({ min: 0, max: 4 }),
              id: fc.integer({ min: 1, max: 6 }),
              other: fc.integer({ min: 1, max: 6 }),
              user: fc.integer({ min: 1, max: 3 })
            }),
            { minLength: 1, maxLength: 12 }
          ),
          async (recursive, operations) => {
            await k.raw('PRAGMA recursive_triggers=' + Number(recursive))
            for (const table of [...tables].reverse()) await k(table).delete()
            await exact(k)
            for (const op of operations) {
              const table = tables[op.table]
              if (op.kind === 0) await replace(k, table, value(table, op.id, op.other, op.user))
              else if (op.kind === 1)
                await k(table)
                  .where(keyOf(table, op.id, op.other))
                  .delete()
              else if (op.kind < 4) {
                const query = k(table)
                  .where(keyOf(table, op.id, op.other))
                  .update(value(table, op.other, op.id, op.user))
                  .toSQL()
                await k.raw(
                  query.sql.replace(/^update/i, op.kind === 2 ? 'UPDATE OR REPLACE' : 'UPDATE OR IGNORE'),
                  query.bindings
                )
              } else
                await k.transaction(async trx => {
                  await trx(table)
                    .where(keyOf(table, op.id, op.other))
                    .delete()
                  await trx.rollback()
                })
              await exact(k)
            }
          }
        ),
        { numRuns: 300, seed: 3242026 }
      )
    } finally {
      await k.destroy()
    }
  },
  30000
)
