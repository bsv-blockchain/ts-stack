import { knex } from 'knex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'

type Row = Record<string, string | number | null>
interface Metadata {
  tables: Row[]
  columns: Row[]
  constraints: Row[]
  indexes: Row[]
  triggers: Row[]
  context: Row[]
  quota: Row[]
}
// Captured MySQL 8 metadata from the complete authored migration. Contains
// schema definitions only; database/definer names are normalized. SQLite executes
// the metadata selection, ordering and limits, independently of the verifier.
const captured: Metadata = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-destination-metadata-fixture.json'),
    'utf8'
  )
)

async function fixture(change: (metadata: Metadata) => void = () => {}) {
  const metadata = structuredClone(captured)
  change(metadata)
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await database.raw("ATTACH DATABASE ':memory:' AS information_schema")
  const connection = await database.client.acquireConnection()
  connection.function('DATABASE', () => 'pr569_fixture')
  await database.client.releaseConnection(connection)
  async function table(name: string, input: Row[], schema = 'information_schema') {
    const rows = input.map(row => ({ ...(schema ? { TABLE_SCHEMA: 'pr569_fixture' } : {}), ...row }))
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))]
    const builder = schema ? database.schema.withSchema(schema) : database.schema
    await builder.createTable(name, table => {
      for (const key of keys) {
        if (rows.some(row => typeof row[key] === 'number')) table.bigInteger(key)
        else table.text(key)
      }
    })
    for (let i = 0; i < rows.length; i += 20)
      await database
        .withSchema(schema || 'main')
        .table(name)
        .insert(rows.slice(i, i + 20))
  }
  await table('TABLES', metadata.tables)
  await table('COLUMNS', metadata.columns)
  await table('TABLE_CONSTRAINTS', metadata.constraints)
  await table('STATISTICS', metadata.indexes)
  await table(
    'TRIGGERS',
    metadata.triggers.map(row => ({ TRIGGER_SCHEMA: 'pr569_fixture', ...row }))
  )
  await table('snapshot_reconciliation_shared_quota', metadata.quota, '')
  const query = database.client._query.bind(database.client)
  const queries: string[] = []
  const observedDefinitionLengths: Record<string, number> = {}
  database.on('query-response', (rows, query) => {
    if (query.method !== 'select' || !Array.isArray(rows)) return
    for (const row of rows)
      for (const field of ['COLUMN_TYPE', 'COLUMN_DEFAULT', 'EXTRA', 'GENERATION_EXPRESSION', 'EXPRESSION']) {
        if (typeof row[field] === 'string')
          observedDefinitionLengths[field] = Math.max(observedDefinitionLengths[field] ?? 0, row[field].length)
      }
  })
  database.client._query = async (connection, request) => {
    queries.push(request.sql)
    if (request.sql.startsWith('SELECT @@sql_mode')) {
      request.response = [metadata.context, []]
      return request
    }
    return await query(connection, {
      ...request,
      sql: request.sql.replace(/LEFT\((TABLE_NAME|TRIGGER_NAME),24\)/g, 'substr($1,1,24)')
    })
  }
  database.client.config.client = 'mysql2'
  return { database, queries, observedDefinitionLengths }
}

describe('fresh MySQL journal destination metadata', () => {
  test('validates the complete captured schema with bounded query batches', async () => {
    const { database, queries } = await fixture()
    try {
      await verifySnapshotJournalDestinationSchema(database)
      expect(queries.length).toBeLessThan(20)
      expect(queries.filter(sql => /information_schema/.test(sql)).length).toBeGreaterThan(5)
      await database('information_schema.TABLES')
        .where('TABLE_NAME', captured.tables[0].TABLE_NAME)
        .update({ ENGINE: 'MyISAM' })
      await expect(verifySnapshotJournalDestinationSchema(database)).rejects.toThrow(WERR_INVALID_OPERATION)
    } finally {
      await database.destroy()
    }
  })

  const drift: Array<[string, (metadata: Metadata) => void]> = [
    [
      'engine',
      m => {
        m.tables[0].ENGINE = 'MyISAM'
      }
    ],
    [
      'table kind',
      m => {
        m.tables[0].TABLE_TYPE = 'VIEW'
      }
    ],
    [
      'row format',
      m => {
        m.tables[0].ROW_FORMAT = 'Compact'
      }
    ],
    [
      'table options',
      m => {
        m.tables[0].CREATE_OPTIONS = 'partitioned'
      }
    ],
    [
      'table collation',
      m => {
        m.tables[0].TABLE_COLLATION = 'utf8mb4_general_ci'
      }
    ],
    [
      'missing column',
      m => {
        m.columns.splice(0, 1)
      }
    ],
    [
      'column order',
      m => {
        m.columns[0].ORDINAL_POSITION = 100
      }
    ],
    [
      'column type',
      m => {
        m.columns[0].COLUMN_TYPE = 'varchar(999)'
      }
    ],
    [
      'nullable column',
      m => {
        m.columns[0].IS_NULLABLE = 'YES'
      }
    ],
    [
      'column default',
      m => {
        m.columns[0].COLUMN_DEFAULT = '0'
      }
    ],
    [
      'column extra',
      m => {
        m.columns[0].EXTRA = 'auto_increment'
      }
    ],
    [
      'generated column',
      m => {
        m.columns[0].GENERATION_EXPRESSION = '1+1'
      }
    ],
    [
      'column charset',
      m => {
        m.columns.find(r => r.CHARACTER_SET_NAME !== null)!.CHARACTER_SET_NAME = 'latin1'
      }
    ],
    [
      'column collation',
      m => {
        m.columns.find(r => r.COLLATION_NAME !== null)!.COLLATION_NAME = 'utf8mb4_general_ci'
      }
    ],
    [
      'extra column',
      m => {
        m.columns.push({ ...m.columns[0], COLUMN_NAME: 'unexpected', ORDINAL_POSITION: 99 })
      }
    ],
    [
      'constraint',
      m => {
        m.constraints[0].CONSTRAINT_TYPE = 'UNIQUE'
      }
    ],
    [
      'extra constraint',
      m => {
        m.constraints.push({ ...m.constraints[0], CONSTRAINT_NAME: 'unexpected' })
      }
    ],
    [
      'missing index row',
      m => {
        m.indexes.splice(0, 1)
      }
    ],
    [
      'index column',
      m => {
        m.indexes[0].COLUMN_NAME = 'unexpected'
      }
    ],
    [
      'index uniqueness',
      m => {
        m.indexes[0].NON_UNIQUE = Number(m.indexes[0].NON_UNIQUE) === 0 ? 1 : 0
      }
    ],
    [
      'index order',
      m => {
        const row = m.indexes.find(
          r =>
            r.SEQ_IN_INDEX === 1 &&
            m.indexes.some(
              other =>
                other.TABLE_NAME === r.TABLE_NAME && other.INDEX_NAME === r.INDEX_NAME && other.SEQ_IN_INDEX === 2
            )
        )!
        row.SEQ_IN_INDEX = 99
      }
    ],
    [
      'index collation',
      m => {
        m.indexes[0].COLLATION = 'D'
      }
    ],
    [
      'index prefix',
      m => {
        m.indexes[0].SUB_PART = 1
      }
    ],
    [
      'index kind',
      m => {
        m.indexes[0].INDEX_TYPE = 'HASH'
      }
    ],
    [
      'invisible index',
      m => {
        m.indexes[0].IS_VISIBLE = 'NO'
      }
    ],
    [
      'index expression',
      m => {
        m.indexes[0].EXPRESSION = '1+1'
      }
    ],
    [
      'extra owned index',
      m => {
        m.indexes.push({ ...m.indexes[0], INDEX_NAME: 'unexpected' })
      }
    ],
    [
      'trigger body',
      m => {
        m.triggers[0].ACTION_STATEMENT += ' '
      }
    ],
    [
      'trigger definer',
      m => {
        m.triggers[0].DEFINER = 'different@%'
      }
    ],
    [
      'trigger timing',
      m => {
        m.triggers[0].ACTION_TIMING = 'BEFORE'
      }
    ],
    [
      'extra owned table',
      m => {
        m.tables.push({ ...m.tables[0], TABLE_NAME: 'snapshot_reconciliation_unexpected' })
      }
    ],
    [
      'extra owned trigger',
      m => {
        m.triggers.push({
          ...m.triggers[0],
          TRIGGER_NAME: 'snapshot_reconciliation_unexpected',
          EVENT_OBJECT_TABLE: 'unrelated'
        })
      }
    ]
  ]
  drift.push(
    [
      'oversized column type',
      m => {
        m.columns[0].COLUMN_TYPE = 'x'.repeat(100000)
      }
    ],
    [
      'oversized generated expression',
      m => {
        m.columns[0].GENERATION_EXPRESSION = 'x'.repeat(100000)
      }
    ],
    [
      'oversized index expression',
      m => {
        m.indexes[0].EXPRESSION = 'x'.repeat(100000)
      }
    ],
    [
      'column metadata overflow',
      m => {
        const first = m.columns[0]
        for (let i = 0; i < 800; i++)
          m.columns.push({ ...first, COLUMN_NAME: 'overflow_' + i, ORDINAL_POSITION: i + 100 })
      }
    ],
    [
      'index metadata overflow',
      m => {
        const first = m.indexes[0]
        for (let i = 0; i < 1000; i++) m.indexes.push({ ...first, COLUMN_NAME: 'overflow_' + i, SEQ_IN_INDEX: i + 100 })
      }
    ]
  )
  test.each(drift)('refuses changed %s', async (_name, change) => {
    const { database, observedDefinitionLengths } = await fixture(change)
    try {
      await expect(verifySnapshotJournalDestinationSchema(database)).rejects.toThrow(WERR_INVALID_OPERATION)
      if (_name.startsWith('oversized')) {
        expect(observedDefinitionLengths.COLUMN_TYPE).toBeLessThanOrEqual(129)
        for (const field of ['COLUMN_DEFAULT', 'EXTRA', 'GENERATION_EXPRESSION', 'EXPRESSION'])
          expect(observedDefinitionLengths[field] ?? 0).toBeLessThanOrEqual(1)
      }
    } finally {
      await database.destroy()
    }
  })
})
