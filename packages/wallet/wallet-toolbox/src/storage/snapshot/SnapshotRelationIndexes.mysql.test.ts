import { knex } from 'knex'
import {
  addSnapshotRelationIndexes,
  removeSnapshotRelationIndexes,
  readSnapshotRelationIndexState,
  SNAPSHOT_RELATION_INDEX_MIGRATION,
  snapshotNumericRelations
} from '../schema/snapshotRelationIndexMigration'

type MetadataKind = 'columns' | 'indexes' | 'triggers'
type Metadata = Array<Record<string, unknown>>

/** Installed MySQL compiler and transaction protocol; native fixtures separately prove database semantics. */
function mysqlFixture(change: (kind: MetadataKind, rows: Metadata) => unknown = (_kind, rows) => rows) {
  const k = knex({ client: 'mysql2' })
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const tables = new Set(['knex_migrations'])
  const indexes = new Map<string, string[]>()
  const triggers = new Map<string, Record<string, unknown>>()
  const progress = new Map<
    number,
    { snapshotTableId: number; afterLeftId: number; afterRightId: number; complete: boolean }
  >()
  const keys: Array<{
    snapshotTableId: number
    snapshotUserId: number
    snapshotLeftId: number
    snapshotRightId: number
    snapshotMembership: number
  }> = []
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
      const isKeys = values[0] === 'snapshot_relation_keys'
      const names = isKeys
        ? ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId', 'snapshotMembership']
        : ['snapshotTableId', 'afterLeftId', 'afterRightId', 'complete']
      const types = isKeys
        ? ['int', 'int unsigned', 'int unsigned', 'int unsigned', 'int unsigned']
        : ['int', 'int unsigned', 'int unsigned', 'tinyint']
      return change(
        'columns',
        names.map((name, i) => ({ name, type: types[i], nullable: 'NO', defaultValue: null, extra: '' }))
      )
    }
    if (sql.startsWith('alter table `snapshot_relation_keys` add index')) {
      const name = sql.match(/add index `([^`]+)`/)![1]
      indexes.set(
        name,
        [...sql.matchAll(/`([^`]+)`/g)].slice(2).map(match => match[1])
      )
      return []
    }
    if (sql.startsWith('SELECT INDEX_NAME FROM'))
      return indexes.has(String(values[1])) ? [{ INDEX_NAME: values[1] }] : []
    if (sql.startsWith('SELECT INDEX_NAME AS')) {
      const primary =
        values[0] === 'snapshot_relation_keys'
          ? ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId']
          : ['snapshotTableId']
      return change('indexes', [
        ...primary.map(columnName => ({ name: 'PRIMARY', columnName, nonUnique: 0, direction: 'A', prefix: null })),
        ...(values[0] === 'snapshot_relation_keys'
          ? [...indexes].flatMap(([name, columns]) =>
              columns.map(columnName => ({ name, columnName, nonUnique: 1, direction: 'A', prefix: null }))
            )
          : [])
      ])
    }
    if (sql.startsWith('SELECT EVENT_MANIPULATION'))
      return change('triggers', triggers.has(String(values[0])) ? [triggers.get(String(values[0]))!] : [])
    if (sql.startsWith('CREATE TRIGGER')) {
      const [, name, timing, event, tableName, body] = sql.match(
        /^CREATE TRIGGER (\w+) (BEFORE|AFTER) (\w+) ON (\w+) FOR EACH ROW (.*)$/
      )!
      triggers.set(name, { event, timing, tableName, body })
      return []
    }
    if (sql.startsWith('DROP TRIGGER')) {
      triggers.delete(sql.split(' ').at(-1)!.replaceAll('`', ''))
      return []
    }
    if (sql.startsWith('insert ignore into `snapshot_relation_index_progress`')) {
      const [afterLeftId, afterRightId, complete, snapshotTableId] = values as [number, number, boolean, number]
      if (!progress.has(snapshotTableId))
        progress.set(snapshotTableId, { snapshotTableId, afterLeftId, afterRightId, complete })
      return { affectedRows: 1, insertId: 0 }
    }
    if (sql.startsWith('select * from `snapshot_relation_index_progress`')) {
      expect(sql).toMatch(/for update$/)
      const row = progress.get(Number(values[0]))
      return row === undefined ? [] : [{ ...row }]
    }
    if (sql.startsWith('select `snapshotTableId`, `afterLeftId`, `afterRightId`, `complete`'))
      return [...progress.values()].map(row => ({ ...row })).slice(0, Number(values[0]))
    if (sql.startsWith('update `snapshot_relation_index_progress`')) {
      const [afterLeftId, afterRightId, complete, tableId] = values as [number, number, boolean, number]
      Object.assign(progress.get(tableId)!, { afterLeftId, afterRightId, complete })
      return { affectedRows: 1 }
    }
    if (sql.startsWith('insert into `snapshot_relation_keys`')) {
      const fields = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(', ')
        .map(value => value.replaceAll('`', ''))
      for (let i = 0; i < values.length - 1; i += fields.length) {
        const row = Object.fromEntries(
          fields.map((field, offset) => [field, Number(values[i + offset])])
        ) as (typeof keys)[number]
        const existing = keys.find(
          key =>
            key.snapshotTableId === row.snapshotTableId &&
            key.snapshotUserId === row.snapshotUserId &&
            key.snapshotLeftId === row.snapshotLeftId &&
            key.snapshotRightId === row.snapshotRightId
        )
        if (existing === undefined) keys.push(row)
        else existing.snapshotMembership |= Number(values.at(-1))
      }
      return { affectedRows: 1 }
    }
    if (sql.startsWith('select `name` from `knex_migrations`'))
      return journaled ? [{ name: SNAPSHOT_RELATION_INDEX_MIGRATION }] : []
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return []
    const source = snapshotNumericRelations.find(({ table }) => sql.includes('from `' + table + '`'))
    if (source !== undefined) {
      expect(sql).toMatch(/for update$/)
      expect(values.at(-1)).toBe(256)
      expect(sql).toContain(' OR ')
      return [
        { [source.leftKey]: 1, [source.rightKey]: 1 },
        { [source.leftKey]: 3, [source.rightKey]: 2 }
      ].filter(row => row[source.leftKey] > Number(values[0]))
    }
    const parent = snapshotNumericRelations
      .flatMap(p => [
        [p.left, p.leftKey],
        [p.right, p.rightKey]
      ])
      .find(([table]) => sql.includes('from `' + table + '`'))
    if (parent !== undefined) {
      expect(sql).toMatch(/lock in share mode$/)
      return values.map(id => ({ [parent[1]]: Number(id), userId: Number(id) === 1 ? 1 : 2 }))
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
    await addSnapshotRelationIndexes(f.k)
    expect(f.triggers.size).toBe(24)
    expect(f.keys).toEqual(
      snapshotNumericRelations.flatMap((_table, snapshotTableId) => [
        { snapshotTableId, snapshotUserId: 1, snapshotLeftId: 1, snapshotRightId: 1, snapshotMembership: 3 },
        { snapshotTableId, snapshotUserId: 2, snapshotLeftId: 3, snapshotRightId: 2, snapshotMembership: 3 }
      ])
    )
    expect([...f.progress.values()]).toEqual(
      snapshotNumericRelations.map((_table, snapshotTableId) => ({
        snapshotTableId,
        afterLeftId: 3,
        afterRightId: 2,
        complete: true
      }))
    )
    expect(
      f.queries.filter(query => query.sql.includes('for update') && !query.sql.includes('snapshot_relation'))
    ).toHaveLength(2)
    expect(f.queries.find(query => query.sql.startsWith('create table `snapshot_relation_keys`'))!.sql).toContain(
      'primary key (`snapshotTableId`, `snapshotUserId`, `snapshotLeftId`, `snapshotRightId`)'
    )
    expect(f.queries.filter(query => query.sql === 'BEGIN;')).toHaveLength(2)
    expect(f.queries.filter(query => query.sql === 'COMMIT;')).toHaveLength(2)
    f.journal()
    expect(await readSnapshotRelationIndexState(f.k)).toBe(true)
    await addSnapshotRelationIndexes(f.k)
    expect(f.keys).toHaveLength(4)
    await removeSnapshotRelationIndexes(f.k)
    expect(f.triggers.size).toBe(0)
    expect(f.tables.has('snapshot_relation_keys')).toBe(false)
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
    await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow('table definition mismatch')
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
    await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow('table definition mismatch')
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
      await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow('table definition mismatch')
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
      if (nonUnique === 0) await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow('table definition mismatch')
      else {
        await addSnapshotRelationIndexes(f.k)
        expect(f.keys).toHaveLength(4)
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
      await expect(addSnapshotRelationIndexes(trx)).rejects.toThrow('independent DDL')
      await expect(removeSnapshotRelationIndexes(trx)).rejects.toThrow('independent DDL')
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
    await addSnapshotRelationIndexes(f.k)
    corrupt = true
    await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow('trigger definition mismatch')
    await expect(removeSnapshotRelationIndexes(f.k)).rejects.toThrow('trigger definition mismatch')
    expect(f.triggers.size).toBe(24)
    expect(f.tables.has('snapshot_relation_keys')).toBe(true)
  } finally {
    await f.k.destroy()
  }
})

test.each([null, [undefined], [{}, {}]])(
  'MySQL malformed trigger metadata %p refuses before creation',
  async replacement => {
    const f = mysqlFixture((kind, rows) => (kind === 'triggers' ? replacement : rows))
    try {
      await expect(addSnapshotRelationIndexes(f.k)).rejects.toThrow(/trigger (metadata|definition mismatch)/)
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
    await addSnapshotRelationIndexes(f.k)
    const created = f.queries.filter(query => query.sql.startsWith('CREATE TRIGGER')).length
    await addSnapshotRelationIndexes(f.k)
    expect(f.queries.filter(query => query.sql.startsWith('CREATE TRIGGER'))).toHaveLength(created)
    expect(f.keys).toHaveLength(4)
  } finally {
    await f.k.destroy()
  }
})

test('pool-only MySQL uses its actual database and preserves the explicit custom journal schema', async () => {
  const f = mysqlFixture()
  try {
    expect(await readSnapshotRelationIndexState(f.k)).toBe(false)
    expect(f.queries[0]).toEqual({
      sql: 'select * from information_schema.tables where table_name = ? and table_schema = database()',
      values: ['knex_migrations']
    })
    expect(
      await readSnapshotRelationIndexState(f.k, { tableName: 'custom_journal', schemaName: 'custom_schema' })
    ).toBe(false)
    expect(f.queries.at(-1)).toEqual({
      sql: 'select * from information_schema.tables where table_name = ? and table_schema = ?',
      values: ['custom_journal', 'custom_schema']
    })
    expect(f.keys).toEqual([])
  } finally {
    await f.k.destroy()
  }
})
