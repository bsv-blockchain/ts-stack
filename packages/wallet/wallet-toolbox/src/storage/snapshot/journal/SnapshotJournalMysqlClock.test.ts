import { knex } from 'knex'
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
      await expect(installSnapshotJournalMysqlClock(k, ceiling as SnapshotJournalRevision)).rejects.toThrow()
      expect(query).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  }
)
