import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGlobalSource, minimalGlobalDatabase } from '../../../test/utils/snapshotGlobalFixtures'
import { runInSeries } from '../../utility/runInSeries'
import { tables } from './snapshotGlobalIndexModel'
import { sqliteTable, validateSqliteSource, validateSqliteTables } from './snapshotGlobalIndexSqlite'
import {
  addSnapshotGlobalIndexes,
  readSnapshotGlobalIndexState,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION
} from './snapshotGlobalIndexMigration'
import { readSqliteSchemaObservations } from './snapshotSqliteSchemaObservations'

const names = ['proven_txs', 'proven_tx_reqs', 'transactions']

async function individual(k: Knex, selected = names) {
  const result = []
  for (const table of selected)
    result.push({
      table,
      columns: await k.raw('PRAGMA table_xinfo(??)', [table]),
      indexes: await k.raw('PRAGMA index_list(??)', [table])
    })
  return result
}

test('pinned metadata preserves every individual PRAGMA field, table and row order', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await k.transaction(async t => {
      const queries: string[] = []
      const listener = (query: { sql: string }) => queries.push(query.sql)
      t.on('query', listener)
      const observed = await readSqliteSchemaObservations(t, names)
      t.off('query', listener)
      expect(queries).toHaveLength(2)
      expect(observed).toEqual(await individual(t))
      expect(observed?.[0].columns[0]).toHaveProperty('dflt_value')
      expect(observed?.[1].indexes[0]).toHaveProperty('origin')
      expect(observed?.[0].columns[0]).not.toHaveProperty('sourceOrdinal')
      const repeated = [names[2], names[0], names[2]]
      expect(await readSqliteSchemaObservations(t, repeated)).toEqual(await individual(t, repeated))
    })
  } finally {
    await k.destroy()
  }
})

test('outside transactions, unsupported drivers and names retain the original read path', async () => {
  const k = await minimalGlobalDatabase()
  try {
    expect(await readSqliteSchemaObservations(k, names)).toBeUndefined()
    await validateSqliteSource(k)
    await k.transaction(async t => {
      expect(await readSqliteSchemaObservations(t, [])).toBeUndefined()
      expect(
        await readSqliteSchemaObservations(
          t,
          Array.from({ length: 17 }, () => names[0])
        )
      ).toBeUndefined()
      expect(
        await readSqliteSchemaObservations(
          t,
          Array.from({ length: 16 }, () => names[0])
        )
      ).toEqual(
        await individual(
          t,
          Array.from({ length: 16 }, () => names[0])
        )
      )
      await t.raw('CREATE TABLE "quoted source"(id INTEGER PRIMARY KEY)')
      expect(await readSqliteSchemaObservations(t, ['quoted source'])).toBeUndefined()
      const client = t.client.config.client
      try {
        t.client.config.client = 'sqlite3'
        expect(await readSqliteSchemaObservations(t, names)).toBeUndefined()
        await validateSqliteSource(t)
      } finally {
        t.client.config.client = client
      }
    })
  } finally {
    await k.destroy()
  }
})

test('valid committed DDL and rolled-back DDL are observed afresh', async () => {
  const k = await minimalGlobalDatabase()
  try {
    const before = await k.transaction(t => readSqliteSchemaObservations(t, names))
    await expect(
      k.transaction(async t => {
        await t.raw('CREATE INDEX rollback_source ON transactions(userId)')
        expect(await readSqliteSchemaObservations(t, names)).toEqual(await individual(t))
        expect(await readSqliteSchemaObservations(t, names)).not.toEqual(before)
        throw new Error('owned ordinary rollback')
      })
    ).rejects.toThrow('owned ordinary rollback')
    expect(await k.transaction(t => readSqliteSchemaObservations(t, names))).toEqual(before)
    await k.raw('CREATE INDEX committed_source ON transactions(userId)')
    await k.transaction(async t => {
      expect(await readSqliteSchemaObservations(t, names)).toEqual(await individual(t))
      expect(await readSqliteSchemaObservations(t, names)).not.toEqual(before)
      await validateSqliteSource(t)
    })
  } finally {
    await k.destroy()
  }
})

test('temporary source precedence remains identical to individual PRAGMAs', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await k.transaction(async t => {
      await t.raw('CREATE TEMP TABLE proven_txs(provenTxId INTEGER PRIMARY KEY,extra INTEGER)')
      expect(await readSqliteSchemaObservations(t, names)).toEqual(await individual(t))
    })
  } finally {
    await k.destroy()
  }
})

test('an independent WAL writer cannot change a pinned metadata view', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ts544-global-observations-'))
  const options = {
    client: 'better-sqlite3',
    connection: { filename: join(folder, 'owned.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const k = knex(options)
  const writer = knex(options)
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await createGlobalSource(k)
    const before = await k.transaction(t => readSqliteSchemaObservations(t, names))
    await k.transaction(async t => {
      expect(await readSqliteSchemaObservations(t, names)).toEqual(before)
      await writer.raw('CREATE INDEX independent_source ON transactions(userId)')
      expect(await readSqliteSchemaObservations(t, names)).toEqual(before)
      expect(await individual(t)).toEqual(before)
    })
    await k.transaction(async t => {
      expect(await readSqliteSchemaObservations(t, names)).toEqual(await individual(t))
      expect(await readSqliteSchemaObservations(t, names)).not.toEqual(before)
    })
  } finally {
    await writer.destroy()
    await k.destroy()
    await rm(folder, { recursive: true, force: true })
  }
})

test('complete global state uses two fresh bounded metadata groups', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    await k.schema.createTable('knex_migrations', table => table.string('name'))
    await k('knex_migrations').insert({ name: SNAPSHOT_GLOBAL_INDEX_MIGRATION })
    expect(await readSnapshotGlobalIndexState(k)).toBe(true)
    expect(sqliteTable).toHaveLength(3)
    await k.transaction(async t => {
      const queries: string[] = []
      const listener = (query: { sql: string }) => queries.push(query.sql)
      t.on('query', listener)
      expect(await readSnapshotGlobalIndexState(t)).toBe(true)
      t.off('query', listener)
      expect(queries.filter(sql => sql.includes('pragma_table_xinfo'))).toHaveLength(2)
      expect(queries.filter(sql => sql.includes('pragma_index_list'))).toHaveLength(2)
      await runInSeries(tables(), async table => {
        expect(await sqliteTable(t, table, true)).toBe(true)
      })
    })
  } finally {
    await k.destroy()
  }
})

test('source validation retains the first original key rejection before later tables', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await k.raw('DROP TABLE proven_txs')
    await k.raw('CREATE TABLE proven_txs(provenTxId INTEGER,other INTEGER,PRIMARY KEY(provenTxId,other))')
    await k.raw('DROP TABLE transactions')
    await expect(validateSqliteSource(k)).rejects.toThrow('Unsupported snapshot global source key')
    await expect(k.transaction(t => validateSqliteSource(t))).rejects.toThrow('Unsupported snapshot global source key')
  } finally {
    await k.destroy()
  }
})

test('auxiliary validation retains the first definition rejection before a later missing table', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    const definitions = tables()
    await k.raw('ALTER TABLE ?? ADD COLUMN extra INTEGER', [definitions[0].name])
    await k.schema.dropTable(definitions[1].name)
    expect(await sqliteTable(k, definitions[0], true)).toBe(false)
    await expect(validateSqliteTables(k, definitions)).rejects.toThrow('Snapshot global table definition mismatch')
    await expect(k.transaction(t => validateSqliteTables(t, definitions))).rejects.toThrow(
      'Snapshot global table definition mismatch'
    )
  } finally {
    await k.destroy()
  }
})

async function indexDetailQueries(k: Knex, run: () => Promise<void>): Promise<string[]> {
  const values: string[] = []
  const listener = (query: { sql: string }) => values.push(query.sql)
  k.on('query', listener)
  try {
    await run()
    return values.filter(sql => sql.includes('index_xinfo'))
  } finally {
    k.off('query', listener)
  }
}

test('pinned auxiliary validation groups fresh index parts while preserving the individual table oracle', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    await k.transaction(async t => {
      const definitions = tables()
      const original = await indexDetailQueries(t, async () => {
        await runInSeries(definitions, async table => {
          expect(await sqliteTable(t, table, true)).toBe(true)
        })
      })
      const grouped = await indexDetailQueries(t, () => validateSqliteTables(t, definitions))
      expect(grouped.length).toBeLessThan(original.length)
      expect(grouped.every(sql => sql.includes('pragma_index_xinfo'))).toBe(true)
      expect(await indexDetailQueries(t, () => validateSqliteTables(t, definitions))).toEqual(grouped)
    })
  } finally {
    await k.destroy()
  }
})

test('fresh index-part validation keeps descending-index rejection and observes rollback', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    const definitions = tables()
    const table = definitions.find(value => value.indexes.length > 0)!
    const index = table.indexes[0]
    await expect(
      k.transaction(async t => {
        await t.raw('DROP INDEX ??', [index.name])
        await t.raw(`CREATE INDEX ?? ON ?? (${index.columns.map(() => '?? DESC').join(',')})`, [
          index.name,
          table.name,
          ...index.columns
        ])
        expect(await sqliteTable(t, table, true)).toBe(false)
        await expect(validateSqliteTables(t, definitions)).rejects.toThrow('Snapshot global table definition mismatch')
        throw new Error('owned index-part rollback')
      })
    ).rejects.toThrow('owned index-part rollback')
    await k.transaction(t => validateSqliteTables(t, definitions))
    expect(await sqliteTable(k, table, true)).toBe(true)
  } finally {
    await k.destroy()
  }
})

test('partial required indexes keep the original rejection without accepting grouped parts', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    const table = tables().find(value => value.indexes.length > 0)!
    const index = table.indexes[0]
    await k.transaction(async t => {
      await t.raw('DROP INDEX ??', [index.name])
      await t.raw(`CREATE INDEX ?? ON ?? (${index.columns.map(() => '??').join(',')}) WHERE ?? >= 0`, [
        index.name,
        table.name,
        ...index.columns,
        index.columns[0]
      ])
      const seen: string[] = []
      const listener = (query: { sql: string }) => seen.push(query.sql)
      t.on('query', listener)
      try {
        await expect(validateSqliteTables(t, [table])).rejects.toThrow('Snapshot global table definition mismatch')
      } finally {
        t.off('query', listener)
      }
      expect(seen.some(sql => sql.includes('pragma_index_xinfo'))).toBe(false)
      expect(await sqliteTable(t, table, true)).toBe(false)
    })
  } finally {
    await k.destroy()
  }
})

test('outside pins and the original sqlite3 selection keep individual index-part statements', async () => {
  const k = await minimalGlobalDatabase()
  try {
    await addSnapshotGlobalIndexes(k)
    const definitions = tables()
    const unpinned = await indexDetailQueries(k, () => validateSqliteTables(k, definitions))
    expect(unpinned.every(sql => sql.startsWith('PRAGMA index_xinfo'))).toBe(true)
    await k.transaction(async t => {
      const client = t.client.config.client
      try {
        t.client.config.client = 'sqlite3'
        expect(await indexDetailQueries(t, () => validateSqliteTables(t, definitions))).toEqual(unpinned)
      } finally {
        t.client.config.client = client
      }
    })
  } finally {
    await k.destroy()
  }
})
