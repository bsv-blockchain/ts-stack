import { knex } from 'knex'
import {
  addSnapshotCertificateIndexes as install,
  removeSnapshotCertificateIndexes as remove,
  readSnapshotCertificateIndexState as enabled,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION as migration
} from '../schema/snapshotCertificateIndexMigration'

type Kind = 'sourceTables' | 'sourceColumn' | 'tables' | 'columns' | 'indexes' | 'triggers'
type Metadata = Array<Record<string, unknown>>

// Actual installed MySQL compiler/transaction protocol. Separate native tests
// prove database locking, collation, crash recovery and row-read behavior.
function fixture(change: (kind: Kind, rows: Metadata) => unknown = (_kind, rows) => rows) {
  const k = knex({ client: 'mysql2' })
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const tables = new Set(['knex_migrations'])
  const indexes = new Map<string, string[]>()
  const triggers = new Map<string, Record<string, unknown>>()
  let progress:
    | {
        snapshotTableId: number
        started: boolean
        afterFieldName: string
        afterCertificateId: number
        complete: boolean
      }
    | undefined
  const keys: Array<{
    snapshotUserId: number
    snapshotFieldName: string
    snapshotCertificateId: number
    snapshotMembership: number
  }> = []
  let journaled = false
  const answer = (sql: string, values: unknown[]): unknown => {
    queries.push({ sql, values })
    if (sql.startsWith('SELECT TABLE_NAME AS name')) {
      expect(values).toEqual(['certificate_fields', 'certificates'])
      return change('sourceTables', [
        { name: 'certificate_fields', engine: 'InnoDB' },
        { name: 'certificates', engine: 'InnoDB' }
      ])
    }
    if (sql.startsWith('SELECT COLUMN_TYPE AS type')) {
      expect(values).toEqual(['certificate_fields', 'fieldName'])
      return change('sourceColumn', [
        { type: 'varchar(100)', nullable: 'NO', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ])
    }
    if (sql.startsWith('SELECT ENGINE AS engine')) return change('tables', [{ engine: 'InnoDB' }])
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
      const isKeys = values[0] === 'snapshot_certificate_field_keys'
      const names = isKeys
        ? ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId', 'snapshotMembership']
        : ['snapshotTableId', 'started', 'afterFieldName', 'afterCertificateId', 'complete']
      const types = isKeys
        ? ['int unsigned', 'varchar(100)', 'int unsigned', 'int unsigned']
        : ['int', 'tinyint', 'varchar(100)', 'int unsigned', 'tinyint']
      return change(
        'columns',
        names.map((name, i) => ({
          name,
          type: types[i],
          nullable: 'NO',
          defaultValue: null,
          extra: '',
          charset: types[i] === 'varchar(100)' ? 'utf8mb4' : null,
          collation: types[i] === 'varchar(100)' ? 'utf8mb4_0900_ai_ci' : null
        }))
      )
    }
    if (sql.startsWith('alter table `snapshot_certificate_field_keys` add index')) {
      indexes.set(
        sql.match(/add index `([^`]+)`/)![1],
        [...sql.matchAll(/`([^`]+)`/g)].slice(2).map(match => match[1])
      )
      return []
    }
    if (sql.startsWith('SELECT INDEX_NAME FROM'))
      return indexes.has(String(values[1])) ? [{ INDEX_NAME: values[1] }] : []
    if (sql.startsWith('SELECT INDEX_NAME AS')) {
      const isKeys = values[0] === 'snapshot_certificate_field_keys'
      const primary = isKeys ? ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'] : ['snapshotTableId']
      return change('indexes', [
        ...primary.map(columnName => ({ name: 'PRIMARY', columnName, nonUnique: 0, direction: 'A', prefix: null })),
        ...(isKeys
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
    if (sql.startsWith('insert ignore into `snapshot_certificate_index_progress`')) {
      const [afterCertificateId, afterFieldName, complete, snapshotTableId, started] = values as [
        number,
        string,
        boolean,
        number,
        boolean
      ]
      progress ??= { snapshotTableId, started, afterFieldName, afterCertificateId, complete }
      return { affectedRows: 1, insertId: 0 }
    }
    if (sql.startsWith('select * from `snapshot_certificate_index_progress`')) {
      if (sql.includes('where')) expect(sql).toMatch(/for update$/)
      else expect(values).toEqual([2])
      return progress === undefined ? [] : [{ ...progress }]
    }
    if (sql.startsWith('update `snapshot_certificate_index_progress`')) {
      const [started, afterFieldName, afterCertificateId, complete, tableId] = values as [
        boolean,
        string,
        number,
        boolean,
        number
      ]
      expect(tableId).toBe(0)
      Object.assign(progress!, { started, afterFieldName, afterCertificateId, complete })
      return { affectedRows: 1 }
    }
    if (sql.startsWith('insert into `snapshot_certificate_field_keys`')) {
      const fields = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(', ')
        .map(value => value.replaceAll('`', ''))
      for (let i = 0; i < values.length - 1; i += fields.length) {
        const row = Object.fromEntries(
          fields.map((field, offset) => [field, values[i + offset]])
        ) as (typeof keys)[number]
        const found = keys.find(
          key =>
            key.snapshotUserId === row.snapshotUserId &&
            key.snapshotFieldName === row.snapshotFieldName &&
            key.snapshotCertificateId === row.snapshotCertificateId
        )
        if (found === undefined) keys.push(row)
        else found.snapshotMembership |= Number(values.at(-1))
      }
      return { affectedRows: 1 }
    }
    if (sql.startsWith('select `name` from `knex_migrations`')) return journaled ? [{ name: migration }] : []
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return []
    if (sql.startsWith('select `userId`, `fieldName`, `certificateId` from `certificate_fields`')) {
      expect(sql).toMatch(/for update$/)
      expect(values.at(-1)).toBe(256)
      const rows = Array.from({ length: 257 }, (_, i) => ({
        userId: 1,
        fieldName: String(i).padStart(6, '0'),
        certificateId: i + 1
      }))
      if (values.length === 1) return rows.slice(0, 256)
      expect(sql).toContain('(fieldName > ? OR (fieldName = ? AND certificateId > ?))')
      return rows
        .filter(
          row =>
            row.fieldName > String(values[0]) || (row.fieldName === values[1] && row.certificateId > Number(values[2]))
        )
        .slice(0, 256)
    }
    if (sql.startsWith('select `certificateId`, `userId` from `certificates`')) {
      expect(sql).toMatch(/lock in share mode$/)
      return values.map(certificateId => ({ certificateId, userId: (Number(certificateId) % 2) + 1 }))
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
    tables,
    indexes,
    triggers,
    keys,
    setJournaled: () => {
      journaled = true
    },
    progress: () => progress
  }
}
afterEach(() => jest.restoreAllMocks())

test('MySQL owns transactional exact-collation tables, installs observers first, and locks two bootstrap batches', async () => {
  const f = fixture()
  try {
    expect(await enabled(f.k)).toBe(false)
    await install(f.k)
    await install(f.k)
    expect(f.triggers.size).toBe(8)
    const ddl = f.queries.filter(q => q.sql.startsWith('CREATE TRIGGER')).map(q => q.sql)
    expect(ddl.slice(0, 4).every(sql => sql.includes('DELETE') || sql.includes('BEFORE UPDATE'))).toBe(true)
    expect(ddl[4]).toContain('snapshot_certificate_field_insert')
    expect(ddl.some(sql => sql.includes('CAST(OLD.fieldName AS BINARY)'))).toBe(true)
    expect(ddl.filter(sql => sql.includes('FOR SHARE'))).toHaveLength(4)
    expect(
      ddl.filter(sql =>
        sql.includes(
          'ON DUPLICATE KEY UPDATE snapshotMembership = snapshot_certificate_field_keys.snapshotMembership | '
        )
      )
    ).toHaveLength(4)
    expect(f.queries.filter(q => q.sql.startsWith('create table')).every(q => q.sql.includes('engine = InnoDB'))).toBe(
      true
    )
    expect(
      f.queries
        .filter(q => q.sql.startsWith('create table'))
        .every(q => q.sql.includes('varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'))
    ).toBe(true)
    expect(f.progress()).toEqual({
      snapshotTableId: 0,
      started: true,
      afterFieldName: '000256',
      afterCertificateId: 257,
      complete: true
    })
    expect(f.keys).toHaveLength(386)
    expect(f.keys.find(key => key.snapshotFieldName === '000001')).toEqual({
      snapshotCertificateId: 2,
      snapshotFieldName: '000001',
      snapshotMembership: 3,
      snapshotUserId: 1
    })
    expect(await enabled(f.k)).toBe(false)
    f.setJournaled()
    expect(await enabled(f.k)).toBe(true)
    await remove(f.k)
    await remove(f.k)
    expect(f.tables).toEqual(new Set(['knex_migrations']))
    expect(f.triggers.size).toBe(0)
  } finally {
    await f.k.destroy()
  }
})

test.each([
  ['sourceTables', []],
  [
    'sourceTables',
    [
      { name: 'certificate_fields', engine: 'MyISAM' },
      { name: 'certificates', engine: 'InnoDB' }
    ]
  ],
  ['sourceColumn', []],
  ['sourceColumn', [{ type: 'text', nullable: 'NO', charset: 'utf8mb4', collation: 'utf8mb4_bin' }]],
  ['sourceColumn', [{ type: 'varchar(100)', nullable: 'YES', charset: 'utf8mb4', collation: 'utf8mb4_bin' }]],
  ['sourceColumn', [{ type: 'varchar(100)', nullable: 'NO', charset: 'invalid charset', collation: 'utf8mb4_bin' }]],
  ['sourceColumn', [{ type: 'varchar(100)', nullable: 'NO', charset: 'utf8mb4', collation: 'invalid collation' }]],
  ['tables', []],
  ['tables', [{ engine: 'MyISAM' }]],
  ['columns', []],
  ['columns', null],
  ['indexes', []],
  ['indexes', null]
] as Array<[Kind, unknown]>)('invalid %s metadata refuses adoption and removal', async (kind, value) => {
  const f = fixture((current, rows) => (current === kind ? value : rows))
  const message =
    kind === 'sourceTables'
      ? 'Snapshot certificate source requires transactional tables'
      : kind === 'sourceColumn'
        ? 'Unsupported snapshot certificate field definition'
        : 'Snapshot certificate table definition mismatch'
  try {
    await expect(install(f.k)).rejects.toThrow(message)
    await expect(remove(f.k)).rejects.toThrow(message)
  } finally {
    await f.k.destroy()
  }
})

test('MySQL resumes equivalent trigger whitespace without replacing the installed observers', async () => {
  let reformatted = false
  const f = fixture((kind, rows) =>
    reformatted && kind === 'triggers'
      ? rows.map(row => ({ ...row, body: ' \n' + String(row.body).replaceAll(' ', '\n\t ') + '\n ' }))
      : rows
  )
  try {
    await install(f.k)
    const created = f.queries.filter(q => q.sql.startsWith('CREATE TRIGGER')).length
    reformatted = true
    await install(f.k)
    expect(f.queries.filter(q => q.sql.startsWith('CREATE TRIGGER'))).toHaveLength(created)
    await remove(f.k)
    expect(f.triggers.size).toBe(0)
  } finally {
    await f.k.destroy()
  }
})

test.each([
  { name: 'foreign' },
  { type: 'bigint unsigned' },
  { nullable: 'YES' },
  { defaultValue: 0 },
  { extra: 'auto_increment' },
  { charset: 'utf8mb4' },
  { collation: 'utf8mb4_bin' }
])('mismatched column %j cannot be adopted', async changed => {
  const f = fixture((kind, rows) => (kind === 'columns' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows))
  try {
    await expect(install(f.k)).rejects.toThrow('table definition mismatch')
  } finally {
    await f.k.destroy()
  }
})

test.each([{ columnName: 'wrong' }, { direction: 'D' }, { prefix: 10 }, { name: 'foreign_unique' }])(
  'mismatched index %j cannot be adopted',
  async changed => {
    const f = fixture((kind, rows) => (kind === 'indexes' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows))
    try {
      await expect(install(f.k)).rejects.toThrow('table definition mismatch')
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([{ event: 'DELETE' }, { timing: 'BEFORE' }, { tableName: 'other' }, { body: 'BEGIN SELECT 1; END' }])(
  'mismatched trigger %j refuses before dropping any trigger',
  async changed => {
    let corrupt = false
    const f = fixture((kind, rows) =>
      corrupt && kind === 'triggers' && rows.length ? [{ ...rows[0], ...changed }] : rows
    )
    try {
      await install(f.k)
      corrupt = true
      await expect(install(f.k)).rejects.toThrow('trigger definition mismatch')
      await expect(remove(f.k)).rejects.toThrow('trigger definition mismatch')
      expect(f.triggers.size).toBe(8)
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([
  null,
  [
    { event: 'INSERT', timing: 'AFTER', tableName: 'certificate_fields', body: 'BEGIN END' },
    { event: 'INSERT', timing: 'AFTER', tableName: 'certificate_fields', body: 'BEGIN END' }
  ]
])('malformed trigger metadata refuses: %j', async value => {
  const f = fixture((kind, rows) => (kind === 'triggers' ? value : rows))
  try {
    await expect(install(f.k)).rejects.toThrow('trigger')
  } finally {
    await f.k.destroy()
  }
})

test('MySQL refuses nesting migration transactions before inspecting or changing objects', async () => {
  const f = fixture()
  try {
    Object.defineProperty(f.k, 'isTransaction', { value: true })
    await expect(install(f.k)).rejects.toThrow('independent DDL')
    await expect(remove(f.k)).rejects.toThrow('independent DDL')
    expect(f.queries).toEqual([])
  } finally {
    await f.k.destroy()
  }
})
