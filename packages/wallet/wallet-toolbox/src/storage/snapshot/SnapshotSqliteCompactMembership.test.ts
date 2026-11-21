import { installMembershipDraft } from '../../../test/utils/snapshotSqliteMaintenanceFixture'
import { sharedMembershipTriggers, numeric } from '../schema/snapshotSqliteMembership'
import { readIdentities, readIdentity, identityDDL, observeSharedIdentity } from '../schema/snapshotSqliteIdentity'
import { fixture, exact, value, keyOf, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'

const schedules = ['BINARY', 'NOCASE', 'RTRIM'].flatMap(collation =>
  [false, true].map(recursive => ({ collation, recursive }))
)

describe('compact native witness key UPSERTs', () => {
  test.each(schedules)(
    'complete independent source trace $collation recursive=$recursive',
    async ({ collation, recursive }) => {
      const k = await fixture(collation, recursive, false)
      try {
        const quoted = 'event " n0'
        await k.schema.alterTable('transactions', table => table.string(quoted, 200).nullable())
        await k.raw('CREATE UNIQUE INDEX quoted_identity ON transactions(?? COLLATE NOCASE)', [quoted])
        await installMembershipDraft(k, true, true, true)
        const identities = await readIdentities(k, numeric),
          oldDefinitions = sharedMembershipTriggers(identities, undefined, true),
          newDefinitions = sharedMembershipTriggers(identities, undefined, true, false, true)
        expect(newDefinitions).toHaveLength(oldDefinitions.length)
        expect(newDefinitions.filter(sql => sql.startsWith('CREATE VIEW'))).toEqual(
          oldDefinitions.filter(sql => sql.startsWith('CREATE VIEW'))
        )
        expect(newDefinitions.reduce((n, sql) => n + Buffer.byteLength(sql), 0)).toBeLessThan(
          oldDefinitions.reduce((n, sql) => n + Buffer.byteLength(sql), 0)
        )
        await k.transaction(async trx => {
          for (const sql of newDefinitions) {
            const name = /^CREATE TRIGGER "([^"]+)"/.exec(sql)?.[1]
            if (name === undefined) continue
            await trx.raw('DROP TRIGGER ??', [name])
            await trx.raw(sql)
          }
        })
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
          const ignored = k(table)
            .where(keyOf(table, 2, 2))
            .update(value(table, 1, 1, 3))
            .toSQL()
          await k.raw(ignored.sql.replace(/^update/i, 'UPDATE OR IGNORE'), ignored.bindings)
          await exact(k)
          await k.transaction(async trx => {
            await trx(table)
              .where(keyOf(table, 1, 1))
              .delete()
            await exact(trx)
            await trx.rollback()
          })
          await exact(k)
        }
        await k('transactions')
          .where({ transactionId: 1 })
          .update({ [quoted]: 'Alpha' })
        await replace(k, 'transactions', { ...value('transactions', 3, 3, 1), [quoted]: 'aLPHa' })
        await exact(k)
        expect(await k('transactions').where({ transactionId: 1 }).first()).toBeUndefined()
        await k('transactions')
          .where({ transactionId: 3 })
          .update({ transactionId: -3, [quoted]: null })
        await exact(k)
        await k('transactions').insert({ ...value('transactions', 4, 4, 1), [quoted]: null })
        await exact(k)
        for (const source of numeric) expect(await k('snapshot_identity_events_' + source.table)).toEqual([])
        for (const table of [...tables].reverse()) await k(table).delete()
        await exact(k)
      } finally {
        await k.destroy()
      }
    },
    30000
  )

  test('historical factories retain their exact explicit-default definitions', async () => {
    const k = await fixture('BINARY', false, false)
    try {
      const identities = await readIdentities(k, numeric)
      for (const complete of [false, true])
        for (const cells of [false, true])
          expect(sharedMembershipTriggers(identities, undefined, complete, cells)).toEqual(
            sharedMembershipTriggers(identities, undefined, complete, cells, false)
          )
      for (const identity of identities) {
        const before = observeSharedIdentity(identity),
          compact = observeSharedIdentity(identity, true)
        expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(before))
        for (const key of [
          identity.source.key,
          ...(identity.source.owner === undefined ? [] : [identity.source.owner])
        ])
          expect(compact).not.toContain('"' + key + '"=excluded."' + key + '"')
      }
    } finally {
      await k.destroy()
    }
  }, 30000)

  test('a key-only conflict keeps the same row without an empty UPDATE clause', async () => {
    const k = await fixture('BINARY', false, false)
    try {
      await k.raw('CREATE TABLE key_only(id INTEGER PRIMARY KEY)')
      const identity = await readIdentity(k, { table: 'key_only', key: 'id' })
      for (const sql of identityDDL(identity)) await k.raw(sql)
      await k.raw('CREATE VIEW key_event(event,n0,o0) AS SELECT NULL,NULL,NULL WHERE 0')
      await k.raw(
        'CREATE TRIGGER observe_key INSTEAD OF INSERT ON key_event BEGIN ' +
          observeSharedIdentity(identity, true) +
          ' END'
      )
      await k('key_only').insert({ id: -5 })
      for (let i = 0; i < 2; i++) await k('key_event').insert({ event: 1, n0: -5, o0: null })
      expect(await k('snapshot_identity_key_only').select('*')).toEqual([{ id: -5 }])
    } finally {
      await k.destroy()
    }
  }, 30000)
})
