import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { fixture } from '../../../../test/utils/snapshotSqliteFixtures'
import { snapshotJournalSqliteObserverSql, snapshotJournalSqliteSources } from './SnapshotJournalSqliteObservers'

// The retained sqlite3 branch executes the exact original sequential PRAGMA
// implementation on the same known healthy physical fixture. It is a fresh
// statement oracle, not a claim about a separate driver or platform.
async function freshStatements(k: Knex): Promise<string[]> {
  const original = k.client.config.client
  k.client.config.client = 'sqlite3'
  try {
    return await snapshotJournalSqliteObserverSql(k)
  } finally {
    k.client.config.client = original
  }
}
function queries(k: Knex): { values: string[]; stop: () => void } {
  const values: string[] = []
  const observe = (query: { sql: string }) => values.push(query.sql)
  k.on('query', observe)
  return {
    values,
    stop: () => {
      k.off('query', observe)
    }
  }
}

test('one fresh bounded column statement preserves every original observer byte and source order', async () => {
  const k = await fixture('BINARY', false)
  try {
    const seen = queries(k)
    const actual = await snapshotJournalSqliteObserverSql(k)
    expect(seen.values).toHaveLength(1)
    expect(seen.values[0]).toContain('pragma_table_info')
    seen.values.length = 0
    expect(await freshStatements(k)).toEqual(actual)
    expect(seen.values).toHaveLength(snapshotJournalSqliteSources.length)
    expect(seen.values.every(sql => sql.startsWith('PRAGMA table_info'))).toBe(true)
    seen.stop()
  } finally {
    await k.destroy()
  }
})

test('valid schema changes and rollback are observed afresh without retained schema rows', async () => {
  const k = await fixture('BINARY', false)
  try {
    const original = await snapshotJournalSqliteObserverSql(k)
    await expect(
      k.transaction(async t => {
        await t.raw('ALTER TABLE outputs ADD COLUMN extraColumn TEXT')
        const actual = await snapshotJournalSqliteObserverSql(t)
        expect(actual).toEqual(await freshStatements(t))
        expect(actual).not.toEqual(original)
        throw new Error('ordinary rollback')
      })
    ).rejects.toThrow('ordinary rollback')
    expect(await snapshotJournalSqliteObserverSql(k)).toEqual(original)
    await k.raw('ALTER TABLE outputs ADD COLUMN committedColumn TEXT')
    const committed = await snapshotJournalSqliteObserverSql(k)
    expect(committed).toEqual(await freshStatements(k))
    expect(committed).not.toEqual(original)
  } finally {
    await k.destroy()
  }
})

test('independent valid DDL respects the real WAL read view and becomes visible after it ends', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ts544-columns-'))
  const filename = join(folder, 'owned.sqlite')
  let writer: Knex | undefined
  let k: Knex | undefined
  try {
    k = await fixture('BINARY', false, true, filename)
    writer = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    const independent = writer
    const original = await snapshotJournalSqliteObserverSql(k)
    await k.transaction(async t => {
      await t('outputs').select('outputId').limit(1)
      expect(await snapshotJournalSqliteObserverSql(t)).toEqual(original)
      await independent.raw('ALTER TABLE outputs ADD COLUMN independentColumn TEXT')
      expect(await snapshotJournalSqliteObserverSql(t)).toEqual(original)
      expect(await freshStatements(t)).toEqual(original)
    })
    const after = await snapshotJournalSqliteObserverSql(k)
    expect(after).toEqual(await freshStatements(k))
    expect(after).not.toEqual(original)
  } finally {
    if (writer !== undefined) await writer.destroy()
    if (k !== undefined) await k.destroy()
    await rm(folder, { recursive: true, force: true })
  }
})

test('missing source rejection keeps the original error identity', async () => {
  const k = await fixture('BINARY', false)
  try {
    await k.raw('DROP TABLE outputs')
    await k.raw('DROP TABLE certificate_fields')
    await expect(snapshotJournalSqliteObserverSql(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    await expect(freshStatements(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    await expect(snapshotJournalSqliteObserverSql(k)).rejects.toThrow('Missing snapshot journal source')
    await expect(freshStatements(k)).rejects.toThrow('Missing snapshot journal source')
  } finally {
    await k.destroy()
  }
})

test('fresh statement results preserve caller safe-integer settings', async () => {
  const k = await fixture('BINARY', false)
  const connection: { defaultSafeIntegers: (enabled: boolean) => unknown } = await k.client.acquireConnection()
  try {
    connection.defaultSafeIntegers(true)
    await k.client.releaseConnection(connection)
    expect(await snapshotJournalSqliteObserverSql(k)).toEqual(await freshStatements(k))
  } finally {
    connection.defaultSafeIntegers(false)
    await k.destroy()
  }
})

test('temporary schema lookup matches original fresh PRAGMA lookup', async () => {
  const k = await fixture('BINARY', false)
  try {
    const original = await snapshotJournalSqliteObserverSql(k)
    await k.raw('CREATE TEMP TABLE outputs (temporaryColumn TEXT, secondColumn INTEGER)')
    expect(await snapshotJournalSqliteObserverSql(k)).toEqual(await freshStatements(k))
    await k.raw('DROP TABLE temp.outputs')
    expect(await snapshotJournalSqliteObserverSql(k)).toEqual(original)
  } finally {
    await k.destroy()
  }
})

test('a source list beyond the new sixteen-table optimization bound retains original sequential reads', async () => {
  const k = await fixture('BINARY', false)
  const originalLength = snapshotJournalSqliteSources.length
  try {
    snapshotJournalSqliteSources.push('outputs', 'outputs', 'outputs', 'outputs')
    const seen = queries(k)
    const actual = await snapshotJournalSqliteObserverSql(k)
    expect(seen.values).toHaveLength(17)
    expect(seen.values.every(sql => sql.startsWith('PRAGMA table_info'))).toBe(true)
    seen.stop()
    expect(actual).toEqual(await freshStatements(k))
  } finally {
    snapshotJournalSqliteSources.splice(originalLength)
    await k.destroy()
  }
})

// The exported legacy array remains mutable. Query observers must not turn a
// detached binding into stale column authority for a changed table selection.
test('a source selection changed during a query uses fresh matching columns', async () => {
  const k = await fixture('BINARY', false)
  const original = snapshotJournalSqliteSources[1]
  try {
    k.once('query', () => {
      snapshotJournalSqliteSources[1] = 'commissions'
    })
    expect(await snapshotJournalSqliteObserverSql(k)).toEqual(await freshStatements(k))
  } finally {
    snapshotJournalSqliteSources[1] = original
    await k.destroy()
  }
})
