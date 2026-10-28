import fc from 'fast-check'
import { installMembershipDraft } from '../../../test/utils/snapshotSqliteMaintenanceFixture'
import { membershipTriggers, sharedMembershipTriggers, numeric } from '../schema/snapshotSqliteMembership'
import { readIdentities, sharedIdentityLayout, sharedIdentityTable } from '../schema/snapshotSqliteIdentity'
import { fixture, exact, value, keyOf, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'

describe.each([false, true, 'shared-witnesses'] as const)('complete shared BEFORE/composite events=%s', mode => {
  const completeEvents = mode !== false
  const sharedWitnesses = mode === 'shared-witnesses'
  test('shared observers retain quoted unique columns and SQL NULL conflicts without retaining event rows', async () => {
    const k = await fixture('NOCASE', true, false)
    try {
      const column = 'event " n0'
      await k.schema.alterTable('transactions', table => table.string(column, 200).nullable())
      await k.raw('CREATE UNIQUE INDEX quoted_identity ON transactions(?? COLLATE NOCASE)', [column])
      await installMembershipDraft(k, true, true, completeEvents, sharedWitnesses)
      for (const id of [1, 2])
        await k('transactions').insert({
          transactionId: id,
          userId: id,
          reference: 'r' + id,
          txid: null,
          provenTxId: null,
          [column]: null
        })
      await exact(k)
      await replace(k, 'transactions', {
        transactionId: 3,
        userId: 3,
        reference: 'r3',
        txid: null,
        provenTxId: null,
        [column]: 'Alpha'
      })
      await replace(k, 'transactions', {
        transactionId: 4,
        userId: 1,
        reference: 'r4',
        txid: null,
        provenTxId: null,
        [column]: 'aLPHa'
      })
      await exact(k)
      expect(await k('transactions').select('transactionId').orderBy('transactionId')).toEqual([
        { transactionId: 1 },
        { transactionId: 2 },
        { transactionId: 4 }
      ])
      for (const source of numeric) expect(await k('snapshot_identity_events_' + source.table)).toEqual([])
      await k.transaction(async trx => {
        await trx('transactions').where('transactionId', 4).update({ transactionId: 5, userId: 2 })
        await exact(trx)
        await trx.rollback()
      })
      await exact(k)
    } finally {
      await k.destroy()
    }
  })

  if (sharedWitnesses)
    test('shared witness tree preserves type slots, source isolation and indexed unique conflicts', async () => {
      const k = await fixture('BINARY', false, false)
      try {
        const definitions = await readIdentities(k, numeric),
          layout = sharedIdentityLayout(definitions)!
        expect(layout.definitions).toHaveLength(10)
        expect(layout.ddl.filter(sql => sql.startsWith('CREATE TABLE'))).toHaveLength(1)
        expect(layout.ddl.filter(sql => sql.startsWith('CREATE INDEX')).length).toBeLessThan(
          definitions.reduce((sum, identity) => sum + identity.unique.length, 0)
        )
        await installMembershipDraft(k, true, true, true, true)
        const stored: Array<{ name: string; type: string }> = await k.raw('PRAGMA table_xinfo(??)', [
          sharedIdentityTable
        ])
        for (const identity of layout.definitions)
          for (const [ordinal, column] of identity.columns.entries())
            if (column.name !== identity.source.key && column.name !== identity.source.owner)
              expect(
                stored.find(value => value.name === identity.sharedStorage!.columns[ordinal])?.type.toLowerCase()
              ).toBe(column.type.toLowerCase())
        expect(
          (await k.raw('PRAGMA table_list(??)', [sharedIdentityTable])).find(
            (row: { name: string }) => row.name === sharedIdentityTable
          ).wr
        ).toBe(1)
        for (const source of numeric) {
          const id = numeric.indexOf(source)
          await k(source.table).insert(value(source.table, 1, 1, 1))
          const row = await k(sharedIdentityTable).where({ tag: id, id: 1 }).first()
          expect(row.id).toBe(1)
          expect(row.owner).toBe(source.owner === undefined ? 0 : 1)
        }
        await exact(k)
        for (const identity of layout.definitions)
          for (const [index, parts] of identity.unique.entries()) {
            const fields = parts.map(
              part => identity.sharedStorage!.columns[identity.columns.findIndex(column => column.name === part.name)]
            )
            const name = identity.sharedStorage!.indexes[index]
            const query = await k.raw(
              `EXPLAIN QUERY PLAN SELECT id FROM ${sharedIdentityTable} INDEXED BY "${name}" WHERE tag=? AND ${fields.map((field, position) => `"${field}" COLLATE ${parts[position].collation}=?`).join(' AND ')}`,
              [identity.sharedStorage!.tag, ...parts.map(part => value(identity.source.table, 1, 1, 1)[part.name])]
            )
            expect(
              query.some((row: { detail: string }) => row.detail.includes('SEARCH') && row.detail.includes(name))
            ).toBe(true)
          }
        await k.transaction(async trx => {
          await trx('transactions').where({ transactionId: 1 }).update({ transactionId: 2, userId: 2 })
          await exact(trx)
          await trx.rollback()
        })
        await exact(k)
      } finally {
        await k.destroy()
      }
    })

  /** Execute the fresh layout in ordinary SQLite against the independent source
   * oracle. This is semantic feedback, not owned-native resource qualification. */
  async function sharedFixture(collation: string, recursive: boolean) {
    const k = await fixture(collation, recursive, false)
    try {
      const identities = await readIdentities(k, numeric)
      const before = membershipTriggers(identities).join('')
      const layout = sharedWitnesses ? sharedIdentityLayout(identities) : undefined
      const after = sharedMembershipTriggers(layout?.definitions ?? identities, undefined, completeEvents).join('')
      expect(Buffer.byteLength(after)).toBeLessThan(Buffer.byteLength(before))
      await installMembershipDraft(k, true, true, completeEvents, sharedWitnesses)
      return k
    } catch (error) {
      await k.destroy()
      throw error
    }
  }

  test.each([false, true])(
    'shared observers: all families retain exact memberships through replacements and nested ownership, recursive=%s',
    async recursive => {
      const k = await sharedFixture('BINARY', recursive)
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
    'shared observers: all-family independent source oracle survives %s conflict schedules',
    async collation => {
      const k = await sharedFixture(collation, false)
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

  test('shared proof guards preserve missing rows, NULL pointers and shared proof references through rollback', async () => {
    const k = await sharedFixture('BINARY', true)
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
})
