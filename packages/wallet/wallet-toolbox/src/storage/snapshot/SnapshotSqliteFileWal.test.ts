import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, exact, value, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'
import { installMembershipDraft } from '../../../test/utils/snapshotSqliteMaintenanceFixture'

test.each([false, true])(
  'independent WAL writer and pinned reader survive trigger replacement, recursive=%s',
  async recursive => {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-identity-wal-'))
    const filename = join(directory, 'fixture.sqlite')
    const source = await fixture('BINARY', true, false, filename)
    const writer = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    let view: Knex.Transaction | undefined
    try {
      await writer.raw('PRAGMA recursive_triggers=' + Number(recursive))
      for (const table of tables) for (const id of [1, 2]) await source(table).insert(value(table, id, id, id))
      await exact(source)
      view = await source.transaction()
      const beforeRows = await view('transactions').orderBy('transactionId')
      const beforeKeys = await view('snapshot_profile_keys').orderBy([
        'snapshotTableId',
        'snapshotUserId',
        'snapshotRowId'
      ])
      await installMembershipDraft(writer)
      await replace(writer, 'transactions', value('transactions', 1, 2, 3))
      await exact(writer)
      expect(await view('transactions').orderBy('transactionId')).toEqual(beforeRows)
      expect(
        await view('snapshot_profile_keys').orderBy(['snapshotTableId', 'snapshotUserId', 'snapshotRowId'])
      ).toEqual(beforeKeys)
      expect(await view('sqlite_master').where('name', 'snapshot_identity_transactions')).toEqual([])
      await view.commit()
      view = undefined
      expect(await source('transactions').orderBy('transactionId')).toEqual([value('transactions', 1, 2, 3)])
      await exact(source)
    } finally {
      if (view !== undefined) await view.rollback()
      await writer.destroy()
      await source.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
