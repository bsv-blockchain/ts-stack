import fc from 'fast-check'
import { installMembershipDraft } from '../../../test/utils/snapshotSqliteMaintenanceFixture'
import { membershipTriggers, numeric } from '../schema/snapshotSqliteMembership'
import { readIdentities } from '../schema/snapshotSqliteIdentity'
import { fixture, exact, value, keyOf, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'

/** Execute the fresh layout in ordinary SQLite against the independent source
 * oracle. This is semantic feedback, not owned-native resource qualification. */
async function reducedFixture(collation: string, recursive: boolean) {
  const k = await fixture(collation, recursive, false)
  try {
    const identities = await readIdentities(k, numeric)
    const before = membershipTriggers(identities).join('')
    const after = membershipTriggers(identities, undefined, true).join('')
    expect(Buffer.byteLength(after)).toBeLessThan(Buffer.byteLength(before))
    await installMembershipDraft(k, true)
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}

test.each([false, true])(
  'reduced observers: all families retain exact memberships through replacements and nested ownership, recursive=%s',
  async recursive => {
    const k = await reducedFixture('BINARY', recursive)
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
  'reduced observers: all-family independent source oracle survives %s conflict schedules',
  async collation => {
    const k = await reducedFixture(collation, false)
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

test('reduced proof guards preserve missing rows, NULL pointers and shared proof references through rollback', async () => {
  const k = await reducedFixture('BINARY', true)
  try {
    await k('transactions').insert({ transactionId: 1, userId: 1, reference: 'r1', txid: null, provenTxId: null })
    await exact(k)
    await k('proven_tx_reqs').insert({ provenTxReqId: 1, txid: 't1', provenTxId: 9 })
    await k('transactions').insert({ transactionId: 2, userId: 2, reference: 'r2', txid: 't1', provenTxId: 9 })
    await exact(k)
    await k('proven_txs').insert({ provenTxId: 9, txid: 'proof9' })
    await exact(k)
    await k.transaction(async trx => {
      await trx('transactions').where('transactionId', 2).update({ txid: null, provenTxId: null })
      await exact(trx)
      await trx.rollback()
    })
    await exact(k)
    await k('proven_tx_reqs').where('provenTxReqId', 1).update({ provenTxId: null })
    await exact(k)
    await k('proven_txs').where('provenTxId', 9).delete()
    await exact(k)
    await k('transactions').where('transactionId', 2).delete()
    await exact(k)
  } finally {
    await k.destroy()
  }
}, 30000)
