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
