import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision as rev,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'
import {
  installSnapshotJournalSqliteClock,
  SNAPSHOT_JOURNAL_SQLITE_ADVANCE,
  SNAPSHOT_JOURNAL_SQLITE_WRITABLE,
  SNAPSHOT_JOURNAL_SQLITE_REVISION
} from './SnapshotJournalSqliteClock'

function open(filename = ':memory:'): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
}

async function install(k: Knex, ceiling: string): Promise<void> {
  await installSnapshotJournalSqliteClock(k, rev(ceiling))
  await k.raw('CREATE TABLE ordinary_rows(id INTEGER PRIMARY KEY,payload TEXT)')
  await k.raw('CREATE TABLE journal_rows(id INTEGER PRIMARY KEY,revision INTEGER)')
  await k.raw(`CREATE TRIGGER observe_ordinary_row AFTER INSERT ON ordinary_rows BEGIN
    ${SNAPSHOT_JOURNAL_SQLITE_ADVANCE}
    INSERT INTO journal_rows(id,revision) SELECT NEW.id,${SNAPSHOT_JOURNAL_SQLITE_REVISION} WHERE ${SNAPSHOT_JOURNAL_SQLITE_WRITABLE};
    END`)
}

test('event-window exhaustion invalidates continuity while all ordinary rows commit', async () => {
  const k = open()
  try {
    await install(k, '2')
    for (const id of [1, 2, 3, 4]) await k('ordinary_rows').insert({ id, payload: 'preserve-' + id })
    expect(await k('ordinary_rows').orderBy('id')).toEqual([1, 2, 3, 4].map(id => ({ id, payload: 'preserve-' + id })))
    expect(await k('journal_rows').orderBy('id')).toEqual([
      { id: 1, revision: 1 },
      { id: 2, revision: 2 }
    ])
    expect(await k('snapshot_journal_clock').first()).toEqual({
      id: 1,
      revision: 2,
      ceiling: 2,
      enabled: 0,
      reason: 'capacity-exhausted'
    })
  } finally {
    await k.destroy()
  }
})

test('revision exhaustion never converts the clock to floating point or rejects the ordinary write', async () => {
  const k = open()
  try {
    await install(k, MAX_SNAPSHOT_JOURNAL_REVISION)
    await k('snapshot_journal_clock').update({
      revision: String(BigInt(MAX_SNAPSHOT_JOURNAL_REVISION) - 1n)
    })
    await k('ordinary_rows').insert({ id: 1, payload: 'last representable journal event' })
    expect(await k('journal_rows').select({ revision: snapshotJournalRevisionText(k, 'revision') })).toEqual([
      { revision: MAX_SNAPSHOT_JOURNAL_REVISION }
    ])
    await k('ordinary_rows').insert({ id: 2, payload: 'preserved after journal exhaustion' })
    expect(await k('ordinary_rows').orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await k('snapshot_journal_clock').select('enabled', 'reason').first()).toEqual({
      enabled: 0,
      reason: 'revision-exhausted'
    })
    expect(
      await k.raw('SELECT typeof(revision) kind,CAST(revision AS TEXT) revision FROM snapshot_journal_clock')
    ).toEqual([{ kind: 'integer', revision: MAX_SNAPSHOT_JOURNAL_REVISION }])
  } finally {
    await k.destroy()
  }
})

test('rollback restores the source, journal and continuity flag together', async () => {
  const k = open()
  try {
    await install(k, '1')
    await k('ordinary_rows').insert({ id: 1, payload: 'committed' })
    const failure = new Error('rollback source transaction')
    await expect(
      k.transaction(async transaction => {
        await transaction('ordinary_rows').insert({ id: 2, payload: 'rolled back' })
        expect(await transaction('snapshot_journal_clock').first('enabled')).toEqual({ enabled: 0 })
        throw failure
      })
    ).rejects.toBe(failure)
    expect(await k('snapshot_journal_clock').first()).toEqual({
      id: 1,
      revision: 1,
      ceiling: 1,
      enabled: 1,
      reason: null
    })
    expect(await k('ordinary_rows')).toEqual([{ id: 1, payload: 'committed' }])
    expect(await k('journal_rows')).toEqual([{ id: 1, revision: 1 }])
  } finally {
    await k.destroy()
  }
})

test('an already pinned WAL view remains coherent across continuity invalidation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-journal-clock-'))
  const k = open(join(directory, 'clock.sqlite')),
    writer = open(join(directory, 'clock.sqlite'))
  let view: Knex.Transaction | undefined
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await install(k, '1')
    await k('ordinary_rows').insert({ id: 1, payload: 'before pin' })
    view = await k.transaction()
    expect(await view('snapshot_journal_clock').first('enabled')).toEqual({ enabled: 1 })
    await writer('ordinary_rows').insert({ id: 2, payload: 'after pin' })
    expect(await writer('snapshot_journal_clock').first('enabled')).toEqual({ enabled: 0 })
    expect(await view('snapshot_journal_clock').first('enabled')).toEqual({ enabled: 1 })
    expect(await view('ordinary_rows')).toEqual([{ id: 1, payload: 'before pin' }])
    expect(await view('journal_rows')).toEqual([{ id: 1, revision: 1 }])
  } finally {
    await view?.rollback()
    await k.destroy()
    await writer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['0', '01', '-1', '9223372036854775808'])(
  'invalid event ceiling %s refuses before installation',
  async ceiling => {
    const k = open()
    try {
      await expect(installSnapshotJournalSqliteClock(k, ceiling as SnapshotJournalRevision)).rejects.toThrow()
      expect(await k.schema.hasTable('snapshot_journal_clock')).toBe(false)
    } finally {
      await k.destroy()
    }
  }
)

test('new installation refuses to adopt or reset an existing clock', async () => {
  const k = open()
  try {
    await install(k, '1')
    await k('ordinary_rows').insert({ id: 1 })
    await expect(installSnapshotJournalSqliteClock(k, rev('10'))).rejects.toThrow()
    expect(await k('snapshot_journal_clock').first()).toEqual({
      id: 1,
      revision: 1,
      ceiling: 1,
      enabled: 1,
      reason: null
    })
  } finally {
    await k.destroy()
  }
})

test('the SQLite clock refuses a MySQL connection before issuing SQL', async () => {
  const k = knex({ client: 'mysql2' })
  const seen = jest.fn()
  k.on('query', seen)
  try {
    await expect(installSnapshotJournalSqliteClock(k, rev('1'))).rejects.toThrow(
      'Snapshot journal clock requires SQLite'
    )
    expect(seen).not.toHaveBeenCalled()
  } finally {
    await k.destroy()
  }
})

test('native clock constraints refuse invalid continuity states atomically', async () => {
  const k = open()
  try {
    await install(k, '1')
    for (const change of [
      { enabled: 0, reason: null },
      { enabled: 1, reason: 'capacity-exhausted' },
      { enabled: 0, reason: 'unknown' },
      { revision: 2 },
      { revision: -1 },
      { revision: 0.5 }
    ]) {
      await expect(k('snapshot_journal_clock').update(change)).rejects.toThrow()
      expect(await k('snapshot_journal_clock').first()).toEqual({
        id: 1,
        revision: 0,
        ceiling: 1,
        enabled: 1,
        reason: null
      })
    }
  } finally {
    await k.destroy()
  }
})

test.each(['sqlite3', 'better-sqlite3'])(
  'SQLite clock alias %s creates and advances an exact event window',
  async client => {
    const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    k.client.config.client = client
    try {
      await installSnapshotJournalSqliteClock(k, rev('9007199254740993'))
      expect(
        await k('snapshot_journal_clock').select(
          'revision',
          k.raw('CAST(ceiling AS TEXT) ceiling'),
          'enabled',
          'reason'
        )
      ).toEqual([{ revision: 0, ceiling: '9007199254740993', enabled: 1, reason: null }])
    } finally {
      await k.destroy()
    }
  }
)

test('empty SQLite clock event window refuses with the stable error before DDL', async () => {
  const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }),
    query = jest.fn()
  k.on('query', query)
  try {
    await expect(installSnapshotJournalSqliteClock(k, rev('0'))).rejects.toThrow('Empty snapshot journal event window')
    expect(query).not.toHaveBeenCalled()
  } finally {
    await k.destroy()
  }
})
