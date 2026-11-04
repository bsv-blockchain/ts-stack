import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveSnapshotJournalCaptureFence } from './SnapshotJournalCaptureFence'
import { installSnapshotJournalSqliteClock, SNAPSHOT_JOURNAL_SQLITE_ADVANCE } from './SnapshotJournalSqliteClock'
import { snapshotJournalRevision, MAX_SNAPSHOT_JOURNAL_REVISION } from './SnapshotJournalRevision'

async function fixture(ceiling = '9223372036854775807') {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-capture-fence-'))
  const filename = join(directory, 'wallet.sqlite')
  const open = () =>
    knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  const writer = open(),
    barrier = open(),
    reader = open()
  await writer.raw('PRAGMA journal_mode=WAL')
  await barrier.raw('PRAGMA busy_timeout=0')
  await installSnapshotJournalSqliteClock(writer, snapshotJournalRevision(ceiling))
  await writer.raw('CREATE TABLE source(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)')
  await writer('source').insert({ id: 1, value: 0 })
  await writer.raw(
    'CREATE TRIGGER observe_source AFTER UPDATE ON source BEGIN ' + SNAPSHOT_JOURNAL_SQLITE_ADVANCE + ' END'
  )
  return {
    writer,
    barrier,
    reader,
    close: async () => {
      await reader.destroy()
      await barrier.destroy()
      await writer.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('a reserved global fence separates independent committed writers and leaves the pinned view immutable', async () => {
  const f = await fixture()
  let view: Knex.Transaction | undefined
  try {
    await f.writer('source').update({ value: 1 })
    let fence: string | undefined
    await f.barrier.transaction(async t => {
      fence = await reserveSnapshotJournalCaptureFence(t)
      expect(fence).toBe('2')
      view = await f.reader.transaction()
      expect(await view('source').first()).toEqual({ id: 1, value: 1 })
      expect((await view('snapshot_journal_clock').first()).revision).toBe(1)
    })
    await f.writer('source').update({ value: 2 })
    expect((await f.writer('snapshot_journal_clock').first()).revision).toBe(3)
    expect(await view!('source').first()).toEqual({ id: 1, value: 1 })
    expect(fence).toBe('2')
  } finally {
    await view?.rollback()
    await f.close()
  }
})

test('occupied writer barrier refuses promptly and does not consume a position or replay a writer', async () => {
  const f = await fixture()
  let writer: Knex.Transaction | undefined
  try {
    writer = await f.writer.transaction()
    await writer('source').update({ value: 1 })
    const start = performance.now()
    await expect(f.barrier.transaction(reserveSnapshotJournalCaptureFence)).rejects.toMatchObject({
      code: 'SQLITE_BUSY'
    })
    expect(performance.now() - start).toBeLessThan(1000)
    await writer.commit()
    writer = undefined
    expect((await f.writer('snapshot_journal_clock').first()).revision).toBe(1)
    expect(await f.barrier.transaction(reserveSnapshotJournalCaptureFence)).toBe('2')
  } finally {
    await writer?.rollback()
    await f.close()
  }
})

test('a rolled-back fence cannot publish and its position is reused only before any receipt commit', async () => {
  const f = await fixture()
  try {
    await expect(
      f.barrier.transaction(async t => {
        expect(await reserveSnapshotJournalCaptureFence(t)).toBe('1')
        throw Error('rollback')
      })
    ).rejects.toThrow('rollback')
    expect((await f.writer('snapshot_journal_clock').first()).revision).toBe(0)
    expect(await f.barrier.transaction(reserveSnapshotJournalCaptureFence)).toBe('1')
  } finally {
    await f.close()
  }
})

test.each(['2', MAX_SNAPSHOT_JOURNAL_REVISION])(
  'capture exhaustion at %s persists disablement only on commit',
  async ceiling => {
    const f = await fixture(ceiling)
    try {
      await f.writer.raw('UPDATE snapshot_journal_clock SET revision=CAST(? AS INTEGER)', [
        (BigInt(ceiling) - 1n).toString()
      ])
      expect(await f.barrier.transaction(reserveSnapshotJournalCaptureFence)).toBe(ceiling)
      expect(await f.barrier.transaction(reserveSnapshotJournalCaptureFence)).toBeUndefined()
      expect(await f.writer('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 0,
        reason: ceiling === MAX_SNAPSHOT_JOURNAL_REVISION ? 'revision-exhausted' : 'capacity-exhausted'
      })
      await f.writer('source').update({ value: 1 })
      expect(await f.writer('source').first()).toEqual({ id: 1, value: 1 })
    } finally {
      await f.close()
    }
  }
)

test('capture refuses ambient nontransaction, unsupported driver and busy-waiting admission', async () => {
  const f = await fixture()
  try {
    await expect(reserveSnapshotJournalCaptureFence(f.barrier)).rejects.toThrow('Invalid snapshot journal capture')
    await expect(
      reserveSnapshotJournalCaptureFence({
        isTransaction: true,
        client: { config: { client: 'pg' } }
      } as unknown as Knex)
    ).rejects.toThrow('Invalid snapshot journal capture')
    await f.barrier.raw('PRAGMA busy_timeout=1')
    await expect(f.barrier.transaction(reserveSnapshotJournalCaptureFence)).rejects.toThrow(
      'Invalid snapshot journal capture'
    )
    expect((await f.writer('snapshot_journal_clock').first()).revision).toBe(0)
  } finally {
    await f.close()
  }
})

test.each(['missing-clock', 'invalid-enabled', 'zero-ceiling', 'revision-over-ceiling', 'disabled'] as const)(
  'SQLite capture reads the exact persisted %s state before allocation',
  async state => {
    const f = await fixture()
    try {
      if (state === 'missing-clock') await f.writer('snapshot_journal_clock').delete()
      else {
        await f.writer.raw('PRAGMA ignore_check_constraints=ON')
        if (state === 'invalid-enabled') await f.writer('snapshot_journal_clock').update({ enabled: 2 })
        else if (state === 'zero-ceiling') await f.writer('snapshot_journal_clock').update({ ceiling: 0 })
        else if (state === 'revision-over-ceiling')
          await f.writer('snapshot_journal_clock').update({ revision: 2, ceiling: 1 })
        else await f.writer('snapshot_journal_clock').update({ enabled: 0, reason: 'capacity-exhausted' })
        await f.writer.raw('PRAGMA ignore_check_constraints=OFF')
        await f.barrier.raw('PRAGMA ignore_check_constraints=ON')
      }
      if (state === 'disabled') expect(await f.barrier.transaction(reserveSnapshotJournalCaptureFence)).toBeUndefined()
      else
        await expect(f.barrier.transaction(reserveSnapshotJournalCaptureFence)).rejects.toThrow(
          'Invalid snapshot journal capture barrier or clock'
        )
    } finally {
      await f.close()
    }
  }
)

test.each(['no-clock', 'invalid-enabled', 'wrong-increment', 'over-ceiling'] as const)(
  'SQLite capture refuses %s returned after the actual clock advance',
  async fault => {
    const f = await fixture('10')
    try {
      await f.barrier.raw('PRAGMA ignore_check_constraints=ON')
      let effect: string
      if (fault === 'no-clock') effect = 'DELETE FROM snapshot_journal_clock'
      else if (fault === 'invalid-enabled') effect = 'UPDATE snapshot_journal_clock SET enabled=2'
      else effect = 'UPDATE snapshot_journal_clock SET revision=' + (fault === 'wrong-increment' ? '0' : '11')
      await f.writer.raw(
        'CREATE TRIGGER corrupt_capture_clock AFTER UPDATE ON snapshot_journal_clock WHEN NEW.revision=1 BEGIN ' +
          effect +
          '; END'
      )
      await expect(f.barrier.transaction(reserveSnapshotJournalCaptureFence)).rejects.toThrow(
        'Invalid snapshot journal capture barrier or clock'
      )
      expect((await f.writer('snapshot_journal_clock').first()).revision).toBe(0)
    } finally {
      await f.close()
    }
  }
)

test('SQLite capture supports the sqlite3 driver identity', async () => {
  const f = await fixture()
  try {
    await f.barrier.transaction(async t => {
      t.client.config.client = 'sqlite3'
      expect(await reserveSnapshotJournalCaptureFence(t)).toBe('1')
    })
  } finally {
    await f.close()
  }
})

test('SQLite capture refuses native non-WAL admission before clock access', async () => {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    await k.raw('PRAGMA busy_timeout=0')
    await expect(k.transaction(reserveSnapshotJournalCaptureFence)).rejects.toThrow(
      'Invalid snapshot journal capture barrier or clock'
    )
  } finally {
    await k.destroy()
  }
})

/** Real Knex MySQL compilation and response decoding, with only the native
 * transport replaced. Actual isolation/locking is covered by the native cohort. */
function mysqlTransport(ceiling: string, allocated: unknown, disabled = false, missing = false) {
  const owner = knex({ client: 'mysql2', connection: { database: 'synthetic' }, pool: { min: 0, max: 1 } })
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  const invalidations: unknown[][] = []
  jest.spyOn(owner.client, 'acquireConnection').mockResolvedValue({})
  jest.spyOn(owner.client, 'releaseConnection').mockResolvedValue(undefined)
  jest.spyOn(owner.client, 'query').mockImplementation(async (...args: unknown[]) => {
    const query = args[1] as { sql: string; method: string; bindings: unknown[] }
    queries.push({ sql: query.sql, bindings: query.bindings ?? [] })
    let rows: unknown
    if (
      query.sql ===
      'select CAST(`ceiling` AS CHAR) as `ceiling` from `snapshot_journal_clock` where `id` = ? limit ? for update nowait'
    )
      rows = missing ? [] : [{ ceiling }]
    else if (query.sql === 'select `id` from `snapshot_journal_invalid` where `id` = ? limit ? for update nowait')
      rows = disabled ? [{ id: 1 }] : []
    else if (query.sql === 'insert into `snapshot_journal_events` () values ()') rows = { insertId: allocated }
    else if (query.sql === 'SELECT CAST(LAST_INSERT_ID() AS CHAR) revision') rows = [{ revision: allocated }]
    else if (query.sql === 'delete from `snapshot_journal_events` where `revision` = ?') rows = { affectedRows: 1 }
    else if (query.sql === 'insert ignore into `snapshot_journal_invalid` (`id`, `reason`) values (?, ?)') {
      invalidations.push(query.bindings)
      rows = { insertId: 1 }
    } else throw new Error('Unexpected capture SQL: ' + query.sql)
    return { ...query, response: [rows, []] }
  })
  return {
    k: Object.assign(owner, { isTransaction: true }),
    queries,
    invalidations,
    close: async () => {
      jest.restoreAllMocks()
      await owner.destroy()
    }
  }
}

test.each(['mysql2', 'mysql'])('capture uses exact current NOWAIT reads and decimal allocation on %s', async client => {
  const f = mysqlTransport(MAX_SNAPSHOT_JOURNAL_REVISION, '9007199254740993')
  try {
    f.k.client.config.client = client
    expect(await reserveSnapshotJournalCaptureFence(f.k)).toBe('9007199254740993')
    expect(f.queries.map(query => query.bindings)).toEqual([[1, 1], [1, 1], [], [], ['9007199254740993']])
    expect(f.invalidations).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([
  ['2', '2', undefined],
  ['2', '3', 'capacity-exhausted'],
  [MAX_SNAPSHOT_JOURNAL_REVISION, '9223372036854775808', 'revision-exhausted']
] as const)('MySQL allocation %s/%s retains exact exhaustion identity', async (ceiling, allocated, reason) => {
  const f = mysqlTransport(ceiling, allocated)
  try {
    expect(await reserveSnapshotJournalCaptureFence(f.k)).toBe(reason ? undefined : allocated)
    expect(f.invalidations).toEqual(reason ? [[1, reason]] : [])
    expect(f.queries[4]).toEqual({
      sql: 'delete from `snapshot_journal_events` where `revision` = ?',
      bindings: [allocated]
    })
  } finally {
    await f.close()
  }
})

test.each(['0', '01', '', 'x1', '1x', 1, undefined])(
  'MySQL refuses malformed native allocation %p before deleting an event',
  async allocated => {
    const f = mysqlTransport('10', allocated)
    try {
      await expect(reserveSnapshotJournalCaptureFence(f.k)).rejects.toThrow(
        'Invalid snapshot journal capture barrier or clock'
      )
      expect(f.queries).toHaveLength(4)
      expect(f.invalidations).toEqual([])
    } finally {
      await f.close()
    }
  }
)

test.each(['disabled', 'missing', 'zero-ceiling'] as const)(
  'MySQL %s state stops before event allocation',
  async state => {
    const f = mysqlTransport(state === 'zero-ceiling' ? '0' : '10', '1', state === 'disabled', state === 'missing')
    try {
      if (state === 'disabled') expect(await reserveSnapshotJournalCaptureFence(f.k)).toBeUndefined()
      else
        await expect(reserveSnapshotJournalCaptureFence(f.k)).rejects.toThrow(
          'Invalid snapshot journal capture barrier or clock'
        )
      expect(f.queries).toHaveLength(state === 'disabled' ? 2 : 1)
      expect(f.invalidations).toEqual([])
    } finally {
      await f.close()
    }
  }
)
