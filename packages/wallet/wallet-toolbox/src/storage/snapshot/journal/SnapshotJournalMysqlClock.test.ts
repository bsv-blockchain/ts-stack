import { knex } from 'knex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installSnapshotJournalMysqlClock } from './SnapshotJournalMysqlClock'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'

test('MySQL clock installation refuses SQLite before issuing SQL', async () => {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  const query = jest.fn()
  k.on('query', query)
  try {
    await expect(installSnapshotJournalMysqlClock(k, snapshotJournalRevision('1'))).rejects.toThrow(
      'Snapshot journal clock requires MySQL'
    )
    expect(query).not.toHaveBeenCalled()
  } finally {
    await k.destroy()
  }
})

test.each(['0', '-1', '01', '9223372036854775808'])(
  'MySQL clock refuses invalid event ceiling %s before DDL or acquisition',
  async ceiling => {
    const k = knex({ client: 'mysql2' })
    const query = jest.fn()
    k.on('query', query)
    try {
      await expect(installSnapshotJournalMysqlClock(k, ceiling as SnapshotJournalRevision)).rejects.toThrow(
        ceiling === '0' ? 'Empty snapshot journal event window' : 'Invalid snapshot journal revision'
      )
      expect(query).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  }
)

test.each(['mysql', 'mysql2'])(
  'MySQL clock alias %s creates its native objects and binds its exact ceiling',
  async client => {
    const k = knex({ client: 'mysql2' })
    k.client.config.client = client
    const captured: { ddl: Array<{ sql: string; bindings: unknown[] }> } = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-generation-ddl-fixture.json'),
        'utf8'
      )
    )
    const expected = captured.ddl.filter(row => /^CREATE TABLE snapshot_journal_(clock|events|invalid)\(/.test(row.sql))
    expect(expected).toHaveLength(3)
    const queries: Array<{ sql: string; bindings: unknown[] }> = []
    const connection = {
      query(
        query: { sql: string },
        bindings: unknown[],
        callback: (error: Error | null, rows?: unknown[], fields?: unknown[]) => void
      ) {
        queries.push({ sql: query.sql, bindings })
        callback(null, [], [])
      }
    }
    jest.spyOn(k.client, 'acquireConnection').mockResolvedValue(connection)
    jest.spyOn(k.client, 'releaseConnection').mockResolvedValue(undefined)
    try {
      await installSnapshotJournalMysqlClock(k, snapshotJournalRevision('9223372036854775807'))
      // The generation owner adds its storage options, epoch and atomic initial row.
      // This primitive emits the same base table shapes, then binds the clock row.
      expect(queries.slice(0, 3)).toEqual(
        expected.map(row => ({ sql: row.sql.split(' DEFAULT CHARACTER SET ')[0], bindings: [] }))
      )
      expect(queries[3]).toEqual({
        sql: 'insert into `snapshot_journal_clock` (`ceiling`, `id`) values (?, ?)',
        bindings: ['9223372036854775807', 1]
      })
      expect(queries).toHaveLength(4)
    } finally {
      await k.destroy()
    }
  }
)
