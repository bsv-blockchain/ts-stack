import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshotJournalHighWater } from './SnapshotJournalHighWater'
import { snapshotJournalRevision as rev, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL } from './SnapshotJournalSqliteObservers'

function open(filename = ':memory:'): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
}
async function install(k: Knex) {
  for (const sql of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await k.raw(sql)
}

test('high-water uses fifteen indexed single-row reads, exact values and only the bound profile plus global streams', async () => {
  const k = open()
  try {
    await install(k)
    await k('snapshot_journal_scope').insert([
      {
        tableId: 0,
        userId: 1,
        id1: 1,
        id2: 0,
        exactText: '',
        present: 1,
        revision: '9007199254740993'
      },
      {
        tableId: 12,
        userId: 1,
        id1: 2,
        id2: 0,
        exactText: 'field',
        present: 0,
        revision: '9007199254740995'
      },
      {
        tableId: 0,
        userId: 2,
        id1: 3,
        id2: 0,
        exactText: '',
        present: 1,
        revision: '9223372036854775807'
      }
    ])
    await k('snapshot_journal_physical').insert([
      {
        tableId: 8,
        id1: 1,
        id2: 0,
        exactText: '',
        present: 1,
        revision: '9007199254740997',
        generation: '9007199254740997'
      },
      {
        tableId: 0,
        id1: 3,
        id2: 0,
        exactText: '',
        present: 1,
        revision: '9223372036854775807',
        generation: '9223372036854775807'
      }
    ])
    const queries: Array<{ sql: string; bindings: unknown[] }> = []
    const onQuery = (q: { sql: string; bindings: unknown[] }) => {
      if (q.sql.startsWith('select')) queries.push(q)
    }
    k.on('query', onQuery)
    expect(await readSnapshotJournalHighWater(k, 1, rev('0'), rev('0'))).toBe('9007199254740997')
    k.off('query', onQuery)
    expect(queries).toHaveLength(15)
    for (const query of queries) {
      const plan: Array<{ detail: string }> = await k.raw(
        'EXPLAIN QUERY PLAN ' + query.sql,
        query.bindings as Knex.RawBinding[]
      )
      expect(plan.some(row => row.detail.includes('SEARCH j USING COVERING INDEX'))).toBe(true)
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
      expect(query.bindings.at(-1)).toBe(1)
    }
    expect(await readSnapshotJournalHighWater(k, 1, rev('9223372036854775807'), rev('9007199254740997'))).toBe(
      '9223372036854775807'
    )
  } finally {
    await k.destroy()
  }
})

test('empty and quiescent streams retain the exact committed prefix', async () => {
  const k = open()
  try {
    await install(k)
    expect(await readSnapshotJournalHighWater(k, 1, rev('9007199254740993'), rev('0'))).toBe('9007199254740993')
  } finally {
    await k.destroy()
  }
})

test.each([
  { id: 0, minimum: '0', floor: '0' },
  { id: 1.1, minimum: '0', floor: '0' },
  { id: 1, minimum: '01', floor: '0' },
  { id: 1, minimum: '1', floor: '2' }
])('invalid profile or stale prefix refuses before SQL: %j', async ({ id, minimum, floor }) => {
  const k = open()
  let queries = 0
  k.on('query', () => queries++)
  try {
    await expect(
      readSnapshotJournalHighWater(k, id, minimum as SnapshotJournalRevision, floor as SnapshotJournalRevision)
    ).rejects.toThrow()
    expect(queries).toBe(0)
  } finally {
    await k.destroy()
  }
})

test('pinned WAL heads remain coherent after an independent writer commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-journal-head-')),
    filename = join(directory, 'head.sqlite'),
    k = open(filename),
    writer = open(filename)
  let view: Knex.Transaction | undefined
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await install(k)
    await k('snapshot_journal_scope').insert({
      tableId: 3,
      userId: 1,
      id1: 1,
      id2: 0,
      exactText: '',
      present: 1,
      revision: '9007199254740993'
    })
    view = await k.transaction()
    expect(await readSnapshotJournalHighWater(view, 1, rev('0'), rev('0'))).toBe('9007199254740993')
    await writer('snapshot_journal_scope').update({ revision: '9007199254740995' })
    expect(await readSnapshotJournalHighWater(view, 1, rev('0'), rev('0'))).toBe('9007199254740993')
    expect(await readSnapshotJournalHighWater(writer, 1, rev('0'), rev('0'))).toBe('9007199254740995')
  } finally {
    await view?.rollback()
    await k.destroy()
    await writer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
