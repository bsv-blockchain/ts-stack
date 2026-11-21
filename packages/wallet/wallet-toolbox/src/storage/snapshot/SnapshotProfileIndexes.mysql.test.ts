import { knex } from 'knex'
import {
  addSnapshotProfileIndexes,
  removeSnapshotProfileIndexes,
  readSnapshotProfileIndexState,
  SNAPSHOT_PROFILE_INDEX_MIGRATION,
  snapshotProfileTables
} from '../schema/snapshotProfileIndexMigration'

type MetadataKind = 'columns' | 'indexes' | 'triggers'
type Metadata = Array<Record<string, unknown>>

/** Installed MySQL compiler and transaction protocol; native fixtures separately prove database semantics. */
function mysqlFixture(change: (kind: MetadataKind, rows: Metadata) => unknown = (_kind, rows) => rows) {
  const k = knex({ client: 'mysql2' })
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const tables = new Set(['knex_migrations'])
  const triggers = new Map<string, Record<string, unknown>>()
  const progress = new Map<number, { snapshotTableId: number; afterRowId: number; complete: boolean }>()
  const keys: Array<{ snapshotTableId: number; snapshotUserId: number; snapshotRowId: number }> = []
  let journaled = false
  const answer = (sql: string, values: unknown[]): unknown => {
    queries.push({ sql, values })
    if (sql.startsWith('select * from information_schema.tables'))
      return tables.has(String(values[0])) ? [{ TABLE_NAME: values[0] }] : []
    if (sql.startsWith('create table')) {
      tables.add(sql.match(/^create table `([^`]+)`/)![1])
      return []
    }
    if (sql.startsWith('drop table')) {
      tables.delete(sql.match(/`([^`]+)`/)![1])
      return []
    }
    if (sql.startsWith('SELECT COLUMN_NAME')) {
      const isKeys = values[0] === 'snapshot_profile_keys'
      const names = isKeys
        ? ['snapshotTableId', 'snapshotUserId', 'snapshotRowId']
        : ['snapshotTableId', 'afterRowId', 'complete']
      const types = isKeys ? ['int', 'int unsigned', 'int unsigned'] : ['int', 'int unsigned', 'tinyint']
      return change(
        'columns',
        names.map((name, i) => ({ name, type: types[i], nullable: 'NO', defaultValue: null, extra: '' }))
      )
    }
    if (sql.startsWith('SELECT INDEX_NAME')) {
      return change(
        'indexes',
        (values[0] === 'snapshot_profile_keys'
          ? ['snapshotTableId', 'snapshotUserId', 'snapshotRowId']
          : ['snapshotTableId']
        ).map(columnName => ({ name: 'PRIMARY', columnName, nonUnique: 0, direction: 'A', prefix: null }))
      )
    }
    if (sql.startsWith('SELECT EVENT_MANIPULATION'))
      return change('triggers', triggers.has(String(values[0])) ? [triggers.get(String(values[0]))!] : [])
    if (sql.startsWith('CREATE TRIGGER')) {
      const [, name, event, tableName, body] = sql.match(
        /^CREATE TRIGGER (\w+) AFTER (\w+) ON (\w+) FOR EACH ROW (.*)$/
      )!
      triggers.set(name, { event, timing: 'AFTER', tableName, body })
      return []
    }
    if (sql.startsWith('DROP TRIGGER')) {
      triggers.delete(sql.split(' ').at(-1)!)
      return []
    }
    if (sql.startsWith('insert ignore into `snapshot_profile_index_progress`')) {
      const [afterRowId, complete, snapshotTableId] = values as [number, boolean, number]
      if (!progress.has(snapshotTableId)) progress.set(snapshotTableId, { snapshotTableId, afterRowId, complete })
      return { affectedRows: 1, insertId: 0 }
    }
    if (sql.startsWith('select * from `snapshot_profile_index_progress`')) {
      expect(sql).toMatch(/for update$/)
      const row = progress.get(Number(values[0]))
      return row === undefined ? [] : [{ ...row }]
    }
    if (sql.startsWith('select `snapshotTableId`, `afterRowId`, `complete`'))
      return [...progress.values()].map(row => ({ ...row })).slice(0, Number(values[0]))
    if (sql.startsWith('update `snapshot_profile_index_progress`')) {
      const [afterRowId, complete, tableId] = values as [number, boolean, number]
      Object.assign(progress.get(tableId)!, { afterRowId, complete })
      return { affectedRows: 1 }
    }
    if (sql.startsWith('insert ignore into `snapshot_profile_keys`')) {
      for (let i = 0; i < values.length; i += 3) {
        const [snapshotRowId, snapshotTableId, snapshotUserId] = values.slice(i, i + 3) as number[]
        keys.push({ snapshotTableId, snapshotUserId, snapshotRowId })
      }
      return { affectedRows: values.length / 3, insertId: 0 }
    }
    if (sql.startsWith('select `name` from `knex_migrations`'))
      return journaled ? [{ name: SNAPSHOT_PROFILE_INDEX_MIGRATION }] : []
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return []
    const source = snapshotProfileTables.find(({ table }) => sql.includes('from `' + table + '`'))
    if (source !== undefined) {
      expect(sql).toMatch(/for update$/)
      expect(values[1]).toBe(256)
      return [
        { [source.key]: 1, userId: 1 },
        { [source.key]: 3, userId: 2 }
      ].filter(row => row[source.key] > Number(values[0]))
    }
    throw new Error('Unexpected synthetic driver query: ' + sql)
  }
  const connection = {
    query(
      query: { sql: string },
      values: unknown[],
      callback: (error: Error | null, rows?: unknown, fields?: unknown[]) => void
    ) {
      try {
        callback(null, answer(query.sql, values), [])
      } catch (error) {
        callback(error as Error)
      }
    }
  }
  jest.spyOn(k.client, 'acquireConnection').mockResolvedValue(connection)
  jest.spyOn(k.client, 'releaseConnection').mockResolvedValue(undefined)
  return {
    k,
    queries,
    keys,
    progress,
    triggers,
    tables,
    journal: () => {
      journaled = true
    }
  }
}

afterEach(() => jest.restoreAllMocks())

test('MySQL DDL and locked bounded bootstrap preserve completion ordering and support repeat/removal', async () => {
  const f = mysqlFixture()
  try {
    await addSnapshotProfileIndexes(f.k)
    expect(f.triggers.size).toBe(24)
    expect(f.keys).toEqual(
      snapshotProfileTables.flatMap((_table, snapshotTableId) => [
        { snapshotTableId, snapshotUserId: 1, snapshotRowId: 1 },
        { snapshotTableId, snapshotUserId: 2, snapshotRowId: 3 }
      ])
    )
    expect([...f.progress.values()]).toEqual(
      snapshotProfileTables.map((_table, snapshotTableId) => ({ snapshotTableId, afterRowId: 3, complete: true }))
    )
    expect(
      f.queries.filter(query => query.sql.includes('for update') && !query.sql.includes('snapshot_profile'))
    ).toHaveLength(8)
    expect(f.queries.find(query => query.sql.startsWith('create table `snapshot_profile_keys`'))!.sql).toContain(
      'primary key (`snapshotTableId`, `snapshotUserId`, `snapshotRowId`)'
    )
    expect(f.queries.filter(query => query.sql === 'BEGIN;')).toHaveLength(8)
    expect(f.queries.filter(query => query.sql === 'COMMIT;')).toHaveLength(8)
    f.journal()
    expect(await readSnapshotProfileIndexState(f.k)).toBe(true)
    await addSnapshotProfileIndexes(f.k)
    expect(f.keys).toHaveLength(16)
    await removeSnapshotProfileIndexes(f.k)
    expect(f.triggers.size).toBe(0)
    expect(f.tables.has('snapshot_profile_keys')).toBe(false)
  } finally {
    await f.k.destroy()
  }
})

test.each([
  ['columns', []],
  ['columns', null],
  ['indexes', []],
  ['indexes', null]
] as const)('MySQL missing/non-array %s metadata refuses before installing triggers', async (kind, replacement) => {
  const f = mysqlFixture((current, rows) => (current === kind ? replacement : rows))
  try {
    await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow('table definition mismatch')
    expect(f.triggers.size).toBe(0)
    expect(f.keys).toEqual([])
  } finally {
    await f.k.destroy()
  }
})

test.each([
  { name: 'unexpected' },
  { type: 'bigint' },
  { nullable: 'YES' },
  { defaultValue: 0 },
  { extra: 'auto_increment' }
])('MySQL column metadata mismatch %j refuses without bootstrap', async changed => {
  const f = mysqlFixture((kind, rows) => (kind === 'columns' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows))
  try {
    await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow('table definition mismatch')
    expect(f.keys).toEqual([])
  } finally {
    await f.k.destroy()
  }
})

test.each([{ direction: 'D' }, { prefix: 1 }, { columnName: 'unexpected' }])(
  'MySQL primary-key mismatch %j refuses adoption',
  async changed => {
    const f = mysqlFixture((kind, rows) => (kind === 'indexes' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows))
    try {
      await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow('table definition mismatch')
    } finally {
      await f.k.destroy()
    }
  }
)

test('MySQL extra unique constraints refuse while nonunique indexes remain compatible', async () => {
  for (const nonUnique of [0, 1]) {
    const f = mysqlFixture((kind, rows) =>
      kind === 'indexes' ? [...rows, { name: 'extra', columnName: 'snapshotRowId', nonUnique }] : rows
    )
    try {
      if (nonUnique === 0) await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow('table definition mismatch')
      else {
        await addSnapshotProfileIndexes(f.k)
        expect(f.keys).toHaveLength(16)
      }
    } finally {
      await f.k.destroy()
    }
  }
})

test('a MySQL migration in an outer transaction refuses before DDL can commit it implicitly', async () => {
  const f = mysqlFixture()
  try {
    await f.k.transaction(async trx => {
      await expect(addSnapshotProfileIndexes(trx)).rejects.toThrow('independent DDL')
      await expect(removeSnapshotProfileIndexes(trx)).rejects.toThrow('independent DDL')
    })
    expect(f.queries.every(query => /^(BEGIN|COMMIT)/.test(query.sql))).toBe(true)
  } finally {
    await f.k.destroy()
  }
})

test.each([
  { event: 'UNKNOWN' },
  { timing: 'BEFORE' },
  { tableName: 'foreign_table' },
  { body: 'BEGIN SELECT 1; END' }
])('MySQL stored trigger mismatch %j refuses adoption/removal without deleting definitions', async changed => {
  let corrupt = false
  const f = mysqlFixture((kind, rows) => (corrupt && kind === 'triggers' ? [{ ...rows[0], ...changed }] : rows))
  try {
    await addSnapshotProfileIndexes(f.k)
    corrupt = true
    await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow('trigger definition mismatch')
    await expect(removeSnapshotProfileIndexes(f.k)).rejects.toThrow('trigger definition mismatch')
    expect(f.triggers.size).toBe(24)
    expect(f.tables.has('snapshot_profile_keys')).toBe(true)
  } finally {
    await f.k.destroy()
  }
})

test.each([null, [undefined], [{}, {}]])(
  'MySQL malformed trigger metadata %p refuses before creation',
  async replacement => {
    const f = mysqlFixture((kind, rows) => (kind === 'triggers' ? replacement : rows))
    try {
      await expect(addSnapshotProfileIndexes(f.k)).rejects.toThrow(/trigger (metadata|definition mismatch)/)
      expect(f.triggers.size).toBe(0)
      expect(f.keys).toEqual([])
    } finally {
      await f.k.destroy()
    }
  }
)

test('MySQL native-width metadata and harmless body whitespace do not require recreation', async () => {
  const f = mysqlFixture((kind, rows) =>
    kind === 'columns'
      ? rows.map(row => ({ ...row, type: String(row.type).replace('int', 'int(11)') }))
      : kind === 'triggers'
        ? rows.map(row => ({ ...row, body: String(row.body).replace(/ /g, ' \n ') }))
        : rows
  )
  try {
    await addSnapshotProfileIndexes(f.k)
    const created = f.queries.filter(query => query.sql.startsWith('CREATE TRIGGER')).length
    await addSnapshotProfileIndexes(f.k)
    expect(f.queries.filter(query => query.sql.startsWith('CREATE TRIGGER'))).toHaveLength(created)
    expect(f.keys).toHaveLength(16)
  } finally {
    await f.k.destroy()
  }
})

test('pool-only MySQL uses its actual database and preserves the explicit custom journal schema', async () => {
  const f = mysqlFixture()
  try {
    expect(await readSnapshotProfileIndexState(f.k)).toBe(false)
    expect(f.queries[0]).toEqual({
      sql: 'select * from information_schema.tables where table_name = ? and table_schema = database()',
      values: ['knex_migrations']
    })
    expect(await readSnapshotProfileIndexState(f.k, { tableName: 'custom_journal', schemaName: 'custom_schema' })).toBe(
      false
    )
    expect(f.queries.at(-1)).toEqual({
      sql: 'select * from information_schema.tables where table_name = ? and table_schema = ?',
      values: ['custom_journal', 'custom_schema']
    })
    expect(f.keys).toEqual([])
  } finally {
    await f.k.destroy()
  }
})
