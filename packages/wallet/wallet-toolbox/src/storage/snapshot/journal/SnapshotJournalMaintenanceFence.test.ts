import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSnapshotJournalMaintenanceOwner as lock } from './SnapshotJournalMaintenanceFence'
import { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } from './SnapshotJournalSqliteClock'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-maintenance-owner-'))
  const config: Knex.Config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const k = knex(config),
    peer = knex(config)
  await k.raw('PRAGMA journal_mode=WAL')
  await k.raw('PRAGMA busy_timeout=0')
  await peer.raw('PRAGMA busy_timeout=0')
  await k.raw(SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL)
  await k('snapshot_journal_clock').insert({ id: 1, revision: 0, ceiling: 10000, enabled: 1, reason: null })
  await k.schema.createTable('knex_migrations_lock', table => {
    table.increments('index')
    table.integer('is_locked').notNullable()
  })
  await k('knex_migrations_lock').insert({ is_locked: 0 })
  return {
    k,
    peer,
    async close() {
      await Promise.all([k.destroy(), peer.destroy()])
      await rm(directory, { recursive: true, force: true })
    }
  }
}
afterEach(() => jest.restoreAllMocks())
test('requires a caller transaction and an approved backend before any mutation', async () => {
  const f = await fixture()
  try {
    await expect(lock(f.k)).rejects.toThrow('migration owner')
    await expect(
      lock({ isTransaction: true, client: { config: { client: 'pg' } } } as unknown as Knex)
    ).rejects.toThrow('migration owner')
    expect((await f.k('snapshot_journal_clock').first()).revision).toBe(0)
  } finally {
    await f.close()
  }
})
test('reserves WAL writing without consuming an event or changing the Knex owner', async () => {
  const f = await fixture()
  try {
    const before = await f.k('knex_migrations_lock')
    await f.k.transaction(trx => lock(trx))
    expect(await f.k('knex_migrations_lock')).toEqual(before)
    expect((await f.k('snapshot_journal_clock').first()).revision).toBe(0)
  } finally {
    await f.close()
  }
})
test.each(['claimed', 'missing', 'duplicate', 'unsafe index'] as const)(
  'refuses %s migration ownership atomically',
  async state => {
    const f = await fixture()
    try {
      if (state === 'claimed') await f.k('knex_migrations_lock').update({ is_locked: 1 })
      else if (state === 'missing') await f.k('knex_migrations_lock').delete()
      else if (state === 'duplicate') await f.k('knex_migrations_lock').insert({ is_locked: 0 })
      else await f.k('knex_migrations_lock').update({ index: 0 })
      await expect(f.k.transaction(trx => lock(trx))).rejects.toThrow('migration owner')
      expect((await f.k('snapshot_journal_clock').first()).revision).toBe(0)
    } finally {
      await f.close()
    }
  }
)
test('configured migration table and schema use their actual owner', async () => {
  const f = await fixture()
  try {
    await f.k.schema.renameTable('knex_migrations_lock', 'custom_migrations_lock')
    await f.k.transaction(trx => lock(trx, { tableName: 'custom_migrations', schemaName: 'main' }))
    await expect(f.k.transaction(trx => lock(trx))).rejects.toThrow()
    for (const config of [
      { tableName: '' },
      { tableName: 'x'.repeat(513) },
      { schemaName: '' },
      { schemaName: 'x'.repeat(65) }
    ]) {
      await expect(f.k.transaction(trx => lock(trx, config))).rejects.toThrow('migration owner')
    }
    expect((await f.k('snapshot_journal_clock').first()).revision).toBe(0)
  } finally {
    await f.close()
  }
})
test('held WAL writer refuses immediately instead of queuing maintenance', async () => {
  const f = await fixture(),
    held = await f.peer.transaction()
  try {
    await lock(held)
    await expect(f.k.transaction(trx => lock(trx))).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
  } finally {
    await held.rollback()
    await f.close()
  }
})
test.each(['busy timeout', 'journal mode', 'clock missing'] as const)('refuses unsafe %s', async state => {
  const f = await fixture()
  try {
    if (state === 'busy timeout') await f.k.raw('PRAGMA busy_timeout=1')
    else if (state === 'journal mode') {
      await f.peer.destroy()
      await f.k.raw('PRAGMA journal_mode=DELETE')
    } else await f.k('snapshot_journal_clock').delete()
    await expect(f.k.transaction(trx => lock(trx))).rejects.toThrow('migration owner')
  } finally {
    await f.close()
  }
})
test('MySQL current owner lock is NOWAIT and reserves no global clock during metadata checks', async () => {
  const calls: string[] = []
  let rows: Array<{ index: unknown; is_locked: unknown }> = [{ index: 1, is_locked: 0 }]
  const query = {
    select(...columns: string[]) {
      calls.push('select:' + columns.join(','))
      return this
    },
    limit(value: number) {
      calls.push('limit:' + value)
      return this
    },
    withSchema(value: string) {
      calls.push('schema:' + value)
      return this
    },
    forUpdate() {
      calls.push('current')
      return this
    },
    noWait() {
      calls.push('nowait')
      return this
    }
  }
  const k = Object.assign(
    (name: string) => {
      calls.push(name)
      return Object.assign(Promise.resolve(rows), query)
    },
    { isTransaction: true, client: { config: { client: 'mysql2' } } }
  ) as unknown as Knex
  await lock(k, { tableName: 'x'.repeat(59), schemaName: 's'.repeat(64) })
  expect(calls).toEqual([
    'x'.repeat(59) + '_lock',
    'select:index,is_locked',
    'limit:2',
    'schema:' + 's'.repeat(64),
    'current',
    'nowait'
  ])
  calls.length = 0
  k.client.config.client = 'mysql'
  await lock(k)
  expect(calls).toEqual(['knex_migrations_lock', 'select:index,is_locked', 'limit:2', 'current', 'nowait'])
  for (const config of [
    { tableName: { length: 1, toString: () => 'knex_migrations' } },
    { schemaName: ['synthetic'] }
  ]) {
    calls.length = 0
    await expect(lock(k, config as Knex.MigratorConfig)).rejects.toThrow('migration owner')
    expect(calls).toHaveLength(0)
  }
  await expect(lock(k, { tableName: 'x'.repeat(60) })).rejects.toThrow('migration owner')
  for (const value of ['1', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    rows = [{ index: value, is_locked: 0 }]
    await expect(lock(k)).rejects.toThrow('migration owner')
  }
  rows = [{ index: 1, is_locked: '0' }]
  await expect(lock(k)).rejects.toThrow('migration owner')
})

test.each(['timeout missing', 'timeout duplicate', 'mode missing', 'mode duplicate'] as const)(
  'refuses malformed SQLite %s responses before reserving its writer',
  async state => {
    const query = jest.fn()
    const k = Object.assign(query, {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } },
      raw: jest.fn(async (sql: string) => {
        if (sql === 'PRAGMA busy_timeout')
          return state === 'timeout missing'
            ? []
            : Array.from({ length: state === 'timeout duplicate' ? 2 : 1 }, () => ({ timeout: 0 }))
        return state === 'mode missing'
          ? []
          : Array.from({ length: state === 'mode duplicate' ? 2 : 1 }, () => ({ journal_mode: 'wal' }))
      })
    }) as unknown as Knex
    await expect(lock(k)).rejects.toThrow('migration owner')
    expect(query).not.toHaveBeenCalled()
  }
)

test('the sqlite3 prerequisite selects the exact owner fields after writer reservation', async () => {
  const calls: string[] = []
  const query = {
    where(id: string, value: number) {
      calls.push('where:' + id + ':' + value)
      return this
    },
    async update() {
      calls.push('reserve')
      return 1
    },
    select(...columns: string[]) {
      calls.push('select:' + columns.join(','))
      return this
    },
    limit(value: number) {
      calls.push('limit:' + value)
      return this
    }
  }
  const k = Object.assign(
    (table: string) => {
      calls.push(table)
      return Object.assign(Promise.resolve([{ index: 1, is_locked: 0 }]), query)
    },
    {
      isTransaction: true,
      client: { config: { client: 'sqlite3' } },
      ref: (name: string) => name,
      raw: async (sql: string) => (sql === 'PRAGMA busy_timeout' ? [{ timeout: 0 }] : [{ journal_mode: 'wal' }])
    }
  ) as unknown as Knex
  await lock(k, { tableName: 'x'.repeat(512) })
  expect(calls).toEqual([
    'snapshot_journal_clock',
    'where:id:1',
    'reserve',
    'x'.repeat(512) + '_lock',
    'select:index,is_locked',
    'limit:2'
  ])
})
