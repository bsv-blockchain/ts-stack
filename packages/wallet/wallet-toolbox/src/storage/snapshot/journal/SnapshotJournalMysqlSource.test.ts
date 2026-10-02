import { knex, type Knex } from 'knex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as profile from '../../schema/snapshotProfileIndexMigration'
import * as relation from '../../schema/snapshotRelationIndexMigration'
import * as certificate from '../../schema/snapshotCertificateIndexMigration'
import * as global from '../../schema/snapshotGlobalIndexMigration'
import { validateSnapshotJournalMysqlSource, readSnapshotJournalMysqlBinding } from './SnapshotJournalMysqlSource'

// Native MySQL 8.4 metadata from a real registered migration, queried through a
// SQLite information_schema fixture so predicates/order/limits execute in tests.
// Native qualification separately verifies MySQL's actual metadata semantics.
const fixture: Record<string, Array<Record<string, unknown>>> = JSON.parse(
  readFileSync(join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-source-metadata-fixture.json'), 'utf8')
)
const families = [
  [
    'TABLES',
    'tables',
    {
      name: 'TABLE_NAME',
      engine: 'ENGINE',
      type: 'TABLE_TYPE',
      collation: 'TABLE_COLLATION',
      rowFormat: 'ROW_FORMAT',
      options: 'CREATE_OPTIONS'
    }
  ],
  [
    'COLUMNS',
    'columns',
    {
      tableName: 'TABLE_NAME',
      name: 'COLUMN_NAME',
      position: 'ORDINAL_POSITION',
      type: 'COLUMN_TYPE',
      nullable: 'IS_NULLABLE',
      defaultValue: 'COLUMN_DEFAULT',
      extra: 'EXTRA',
      charset: 'CHARACTER_SET_NAME',
      collation: 'COLLATION_NAME',
      expression: 'GENERATION_EXPRESSION'
    }
  ],
  [
    'STATISTICS',
    'indexes',
    {
      tableName: 'TABLE_NAME',
      name: 'INDEX_NAME',
      position: 'SEQ_IN_INDEX',
      columnName: 'COLUMN_NAME',
      nonUnique: 'NON_UNIQUE',
      direction: 'COLLATION',
      prefix: 'SUB_PART',
      nullable: 'NULLABLE',
      type: 'INDEX_TYPE',
      visible: 'IS_VISIBLE',
      expression: 'EXPRESSION'
    }
  ],
  [
    'KEY_COLUMN_USAGE',
    'foreignKeys',
    {
      tableName: 'TABLE_NAME',
      name: 'CONSTRAINT_NAME',
      position: 'ORDINAL_POSITION',
      columnName: 'COLUMN_NAME',
      foreignSchema: 'REFERENCED_TABLE_SCHEMA',
      foreignTable: 'REFERENCED_TABLE_NAME',
      foreignColumn: 'REFERENCED_COLUMN_NAME'
    }
  ],
  [
    'REFERENTIAL_CONSTRAINTS',
    'foreignRules',
    {
      tableName: 'TABLE_NAME',
      name: 'CONSTRAINT_NAME',
      matchOption: 'MATCH_OPTION',
      updateRule: 'UPDATE_RULE',
      deleteRule: 'DELETE_RULE'
    }
  ],
  [
    'TRIGGERS',
    'triggers',
    {
      tableName: 'EVENT_OBJECT_TABLE',
      name: 'TRIGGER_NAME',
      event: 'EVENT_MANIPULATION',
      timing: 'ACTION_TIMING',
      actionOrder: 'ACTION_ORDER',
      definer: 'DEFINER',
      body: 'ACTION_STATEMENT',
      sqlMode: 'SQL_MODE',
      charset: 'CHARACTER_SET_CLIENT',
      connectionCollation: 'COLLATION_CONNECTION',
      databaseCollation: 'DATABASE_COLLATION'
    }
  ]
] as const
let reads: Array<jest.SpyInstance>
beforeEach(() => {
  reads = [
    jest.spyOn(profile, 'readSnapshotProfileIndexState'),
    jest.spyOn(relation, 'readSnapshotRelationIndexState'),
    jest.spyOn(certificate, 'readSnapshotCertificateIndexState'),
    jest.spyOn(global, 'readSnapshotGlobalIndexState')
  ]
  for (const read of reads) read.mockResolvedValue(true)
})
afterEach(() => jest.restoreAllMocks())
async function metadata(): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const connection = await k.client.acquireConnection()
  try {
    connection.function('DATABASE', () => 'ts569_snapshot')
  } finally {
    await k.client.releaseConnection(connection)
  }
  await k.raw("ATTACH DATABASE ':memory:' AS information_schema")
  for (const [table, key, columns] of families) {
    const schemaColumns = ['TABLE_SCHEMA', 'CONSTRAINT_SCHEMA', 'TRIGGER_SCHEMA', ...Object.values(columns)]
    await k.raw('CREATE TABLE information_schema.?? (' + schemaColumns.map(() => '??').join(',') + ')', [
      table,
      ...schemaColumns
    ])
    for (const row of fixture[key]) {
      const record: Record<string, unknown> = {
        TABLE_SCHEMA: 'ts569_snapshot',
        CONSTRAINT_SCHEMA: 'ts569_snapshot',
        TRIGGER_SCHEMA: 'ts569_snapshot'
      }
      for (const [field, column] of Object.entries(columns)) record[column] = row[field]
      await k(table).withSchema('information_schema').insert(record)
    }
  }
  await k.raw(
    'CREATE TABLE information_schema.TABLE_CONSTRAINTS(TABLE_SCHEMA,CONSTRAINT_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE,ENFORCED)'
  )
  await k.raw('CREATE TABLE information_schema.CHECK_CONSTRAINTS(CONSTRAINT_SCHEMA,CONSTRAINT_NAME,CHECK_CLAUSE)')
  const original = k.client.processResponse.bind(k.client)
  // A MySQL driver's raw result wraps rows; execute identical SELECT predicates.
  jest.spyOn(k.client, 'processResponse').mockImplementation((...args: unknown[]) => {
    const response = args[0] as { method: string; sql: string }
    const result = original(...args)
    return response.method === 'raw' && response.sql.startsWith('SELECT') ? [result] : result
  })
  k.client.config.client = 'mysql2'
  return k
}

test('published native metadata produces a stable source binding through real predicates', async () => {
  const k = await metadata()
  try {
    await validateSnapshotJournalMysqlSource(k)
    const binding = await readSnapshotJournalMysqlBinding(k)
    expect(binding).toMatch(/^[0-9a-f]{64}$/)
    expect(await readSnapshotJournalMysqlBinding(k)).toBe(binding)
  } finally {
    await k.destroy()
  }
})
test.each(['sqlite3', 'better-sqlite3', 'pg', 'missing'])(
  'unsupported source %s refuses before database access',
  async client => {
    const k = await metadata()
    try {
      k.client.config.client = client
      const queries = jest.fn()
      k.on('query', queries)
      await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
      expect(queries).not.toHaveBeenCalled()
      for (const read of reads) expect(read).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  }
)
test.each([0, 1, 2, 3])('unpublished prerequisite %s prevents journal admission', async index => {
  const k = await metadata()
  try {
    reads[index].mockResolvedValue(false)
    await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
  } finally {
    await k.destroy()
  }
})
test.each(['missing', 'engine', 'view'])('source %s is refused', async kind => {
  const k = await metadata()
  try {
    const table = k('TABLES').withSchema('information_schema').where('TABLE_NAME', 'outputs')
    if (kind === 'missing') await table.delete()
    else await table.update(kind === 'engine' ? { ENGINE: 'MyISAM' } : { TABLE_TYPE: 'VIEW' })
    await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
  } finally {
    await k.destroy()
  }
})
test.each([
  ['UPDATE_RULE', 'CASCADE'],
  ['DELETE_RULE', 'CASCADE'],
  ['UPDATE_RULE', 'SET NULL'],
  ['DELETE_RULE', 'SET NULL']
])('%s %s cannot bypass source observers', async (column, value) => {
  const k = await metadata()
  try {
    await k('REFERENTIAL_CONSTRAINTS')
      .withSchema('information_schema')
      .where('TABLE_NAME', 'outputs')
      .update({ [column]: value })
    await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
  } finally {
    await k.destroy()
  }
})
test.each(['missing', 'table', 'event', 'timing', 'body'])('changed prerequisite trigger %s is refused', async kind => {
  const k = await metadata()
  try {
    const query = k('TRIGGERS').withSchema('information_schema').where('TRIGGER_NAME', 'snapshot_profile_0_insert')
    if (kind === 'missing') await query.delete()
    else
      await query.update({
        [{
          table: 'EVENT_OBJECT_TABLE',
          event: 'EVENT_MANIPULATION',
          timing: 'ACTION_TIMING',
          body: 'ACTION_STATEMENT'
        }[kind]!]: 'changed'
      })
    await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
  } finally {
    await k.destroy()
  }
})
test.each([
  ['COLUMNS', 'COLUMN_DEFAULT', 'literal  with  spaces'],
  ['STATISTICS', 'IS_VISIBLE', 'NO'],
  ['REFERENTIAL_CONSTRAINTS', 'MATCH_OPTION', 'changed'],
  ['KEY_COLUMN_USAGE', 'REFERENCED_COLUMN_NAME', 'changed'],
  ['TABLES', 'ROW_FORMAT', 'COMPACT']
])('binding retains %s %s semantics', async (table, column, value) => {
  const k = await metadata()
  try {
    const before = await readSnapshotJournalMysqlBinding(k)
    const update = k(table).withSchema('information_schema')
    if (table === 'STATISTICS') update.where('NON_UNIQUE', 1)
    await update.update({ [column]: value })
    expect(await readSnapshotJournalMysqlBinding(k)).not.toBe(before)
  } finally {
    await k.destroy()
  }
})
test('literal bytes and foreign objects with a journal prefix remain in the binding', async () => {
  const k = await metadata()
  try {
    const before = await readSnapshotJournalMysqlBinding(k)
    const original = fixture.triggers[0]
    const add: Record<string, unknown> = { TRIGGER_SCHEMA: 'ts569_snapshot' }
    for (const [field, column] of Object.entries(families[5][2])) add[column] = original[field]
    Object.assign(add, {
      TRIGGER_NAME: 'snapshot_journal_foreign',
      ACTION_STATEMENT: "BEGIN DO 'a  b'; END"
    })
    await k('TRIGGERS').withSchema('information_schema').insert(add)
    const first = await readSnapshotJournalMysqlBinding(k)
    expect(first).not.toBe(before)
    await k('TRIGGERS')
      .withSchema('information_schema')
      .where('TRIGGER_NAME', 'snapshot_journal_foreign')
      .update({ ACTION_STATEMENT: "BEGIN DO 'a b'; END" })
    expect(await readSnapshotJournalMysqlBinding(k)).not.toBe(first)
  } finally {
    await k.destroy()
  }
})
test.each(['rows', 'value', 'aggregate'])(
  'oversized %s metadata refuses instead of binding a truncated definition',
  async kind => {
    const k = await metadata()
    try {
      if (kind === 'value')
        await k('COLUMNS')
          .withSchema('information_schema')
          .update({ COLUMN_DEFAULT: 'x'.repeat(16385) })
      else if (kind === 'aggregate')
        await k('COLUMNS')
          .withSchema('information_schema')
          .update({ COLUMN_DEFAULT: 'x'.repeat(16384) })
      else {
        const original = fixture.indexes[0]
        for (let i = 0; i < 513; i++) {
          const row: Record<string, unknown> = { TABLE_SCHEMA: 'ts569_snapshot' }
          for (const [field, column] of Object.entries(families[2][2])) row[column] = original[field]
          row.INDEX_NAME = 'bounded' + i
          await k('STATISTICS').withSchema('information_schema').insert(row)
        }
      }
      await expect(readSnapshotJournalMysqlBinding(k)).rejects.toThrow('Unsupported or incomplete')
    } finally {
      await k.destroy()
    }
  }
)

test.each([
  'missing primary',
  'composite primary',
  'prefix identity',
  'descending identity',
  'invisible identity',
  'nullable owner',
  'signed identity',
  'generated owner'
])('unsupported source identity %s refuses before journal installation', async kind => {
  const k = await metadata()
  try {
    const index = k('STATISTICS')
      .withSchema('information_schema')
      .where({ TABLE_NAME: 'tx_labels', INDEX_NAME: 'PRIMARY' })
    if (kind === 'missing primary') await index.delete()
    if (kind === 'composite primary') {
      const row = await index.first()
      await k('STATISTICS')
        .withSchema('information_schema')
        .insert({ ...row, SEQ_IN_INDEX: 2, COLUMN_NAME: 'userId' })
    }
    if (kind === 'prefix identity') await index.update({ SUB_PART: 1 })
    if (kind === 'descending identity') await index.update({ COLLATION: 'D' })
    if (kind === 'invisible identity') await index.update({ IS_VISIBLE: 'NO' })
    if (kind === 'nullable owner')
      await k('COLUMNS')
        .withSchema('information_schema')
        .where({ TABLE_NAME: 'tx_labels', COLUMN_NAME: 'userId' })
        .update({ IS_NULLABLE: 'YES' })
    if (kind === 'signed identity')
      await k('COLUMNS')
        .withSchema('information_schema')
        .where({ TABLE_NAME: 'tx_labels', COLUMN_NAME: 'txLabelId' })
        .update({ COLUMN_TYPE: 'int' })
    if (kind === 'generated owner')
      await k('COLUMNS')
        .withSchema('information_schema')
        .where({ TABLE_NAME: 'tx_labels', COLUMN_NAME: 'userId' })
        .update({ EXTRA: 'VIRTUAL GENERATED' })
    await expect(validateSnapshotJournalMysqlSource(k)).rejects.toThrow('Unsupported or incomplete')
  } finally {
    await k.destroy()
  }
})

test.each(['missing', 'non-InnoDB', 'view'])(
  'binding detects source table %s after prerequisite validation',
  async kind => {
    const k = await metadata(),
      process = jest.mocked(k.client.processResponse).getMockImplementation()!
    let altered = false
    jest.mocked(k.client.processResponse).mockImplementation((...args: unknown[]) => {
      const query = args[0] as { sql: string },
        result = process(...args)
      if (query.sql.includes('ROW_FORMAT rowFormat')) {
        altered = true
        if (kind === 'missing') result[0].pop()
        if (kind === 'non-InnoDB') result[0][0].engine = 'MyISAM'
        if (kind === 'view') result[0][0].type = 'VIEW'
      }
      return result
    })
    try {
      await expect(readSnapshotJournalMysqlBinding(k)).rejects.toThrow('Unsupported or incomplete')
      expect(altered).toBe(true)
    } finally {
      await k.destroy()
    }
  }
)
