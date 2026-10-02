import { knex } from 'knex'
import {
  addSnapshotGlobalIndexes as install,
  removeSnapshotGlobalIndexes as remove,
  readSnapshotGlobalIndexState as enabled,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION as migration
} from '../schema/snapshotGlobalIndexMigration'

type Kind = 'engine' | 'rules' | 'sourceColumns' | 'columns' | 'indexes' | 'triggers'
type Metadata = Array<Record<string, unknown>>
interface Edge {
  transactionId: number
  requestId: number
  tableId: number
  rowId: number
  userId: number
}

// Exercise the installed MySQL query compiler and transaction protocol. Native
// fixtures separately establish trigger effects, concurrency and query bounds.
function fixture(change: (kind: Kind, table: string, rows: Metadata) => unknown = (_kind, _table, rows) => rows) {
  const k = knex({ client: 'mysql2' })
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const tables = new Set(['knex_migrations'])
  const indexes = new Map<string, Map<string, string[]>>()
  const triggers = new Map<string, Record<string, unknown>>()
  const edges: Edge[] = []
  const guards = new Set<number>()
  let lastSourceCursor = -1
  let journaled = false
  let progress: { id: number; afterRowId: number; complete: boolean | number } | undefined
  const columns: Record<string, Array<[string, string, string]>> = {
    proven_txs: [['provenTxId', 'int unsigned', 'NO']],
    proven_tx_reqs: [
      ['provenTxReqId', 'int unsigned', 'NO'],
      ['provenTxId', 'int unsigned', 'YES'],
      ['txid', 'varchar(64)', 'NO']
    ],
    transactions: [
      ['transactionId', 'int unsigned', 'NO'],
      ['userId', 'int unsigned', 'NO'],
      ['provenTxId', 'int unsigned', 'YES'],
      ['txid', 'varchar(64)', 'YES']
    ],
    snapshot_global_guards: [
      ['proofId', 'int unsigned', 'NO'],
      ['present', 'tinyint(1)', 'NO']
    ],
    snapshot_global_keys: [
      ['tableId', 'int', 'NO'],
      ['userId', 'int unsigned', 'NO'],
      ['rowId', 'int unsigned', 'NO'],
      ['refs', 'bigint unsigned', 'NO'],
      ['present', 'tinyint(1)', 'NO']
    ],
    snapshot_global_edges: [
      ['transactionId', 'int unsigned', 'NO'],
      ['requestId', 'int unsigned', 'NO'],
      ['tableId', 'int', 'NO'],
      ['rowId', 'int unsigned', 'NO'],
      ['userId', 'int unsigned', 'NO']
    ],
    snapshot_global_index_progress: [
      ['id', 'int', 'NO'],
      ['afterRowId', 'int unsigned', 'NO'],
      ['complete', 'tinyint(1)', 'NO']
    ]
  }
  const primary: Record<string, string[]> = {
    proven_txs: ['provenTxId'],
    proven_tx_reqs: ['provenTxReqId'],
    transactions: ['transactionId'],
    snapshot_global_guards: ['proofId'],
    snapshot_global_keys: ['tableId', 'userId', 'rowId'],
    snapshot_global_edges: ['transactionId', 'requestId', 'tableId', 'rowId'],
    snapshot_global_index_progress: ['id']
  }
  const answer = (sql: string, values: unknown[] = []): unknown => {
    queries.push({ sql, values })
    const table = String(values[0])
    if (sql.startsWith('SELECT ENGINE AS engine')) return change('engine', table, [{ engine: 'InnoDB' }])
    if (sql.startsWith('SELECT UPDATE_RULE'))
      return change('rules', table, [{ updateRule: 'RESTRICT', deleteRule: 'NO ACTION' }])
    if (sql.startsWith('SELECT COLUMN_NAME')) {
      const source = !table.startsWith('snapshot_')
      return change(
        source ? 'sourceColumns' : 'columns',
        table,
        columns[table].map(([name, type, nullable], i) => ({
          name,
          type,
          nullable,
          defaultValue: null,
          extra: source && i === 0 ? 'auto_increment' : '',
          charset: type === 'varchar(64)' ? 'utf8mb4' : null,
          collation: type === 'varchar(64)' ? 'utf8mb4_0900_ai_ci' : null
        }))
      )
    }
    if (sql.startsWith('SELECT INDEX_NAME AS')) {
      const part = (name: string, columnName: string, nonUnique: number) => ({
        name,
        columnName,
        nonUnique,
        direction: 'A',
        prefix: null
      })
      return change('indexes', table, [
        ...primary[table].map(column => part('PRIMARY', column, 0)),
        ...(['transactions', 'proven_tx_reqs'].includes(table)
          ? [part('source_txid', 'txid', table === 'transactions' ? 1 : 0)]
          : []),
        ...[...(indexes.get(table) ?? [])].flatMap(([name, fields]) => fields.map(field => part(name, field, 1)))
      ])
    }
    if (sql.startsWith('select * from information_schema.tables'))
      return tables.has(table) ? [{ TABLE_NAME: table }] : []
    if (sql.startsWith('create table')) {
      tables.add(sql.match(/^create table `([^`]+)`/)![1])
      return []
    }
    if (sql.startsWith('drop table')) {
      tables.delete(sql.match(/`([^`]+)`/)![1])
      return []
    }
    if (sql.startsWith('alter table')) {
      const [, name, index] = sql.match(/^alter table `([^`]+)` add index `([^`]+)`/)!
      const found = indexes.get(name) ?? new Map<string, string[]>()
      found.set(
        index,
        [...sql.matchAll(/`([^`]+)`/g)].slice(2).map(match => match[1])
      )
      indexes.set(name, found)
      return []
    }
    if (sql.startsWith('SELECT EVENT_MANIPULATION'))
      return change('triggers', table, triggers.has(table) ? [triggers.get(table)!] : [])
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
    if (sql.startsWith('insert ignore into `snapshot_global_index_progress`')) {
      expect(values).toEqual([0, false, 0])
      progress ??= { id: 0, afterRowId: 0, complete: false }
      return { affectedRows: 1, insertId: 0 }
    }
    if (sql.startsWith('select * from `snapshot_global_index_progress`')) {
      if (sql.includes('where')) {
        expect(sql).toMatch(/for update$/)
        expect(values).toEqual([0, 1])
      } else expect(values).toEqual([2])
      return progress === undefined ? [] : [{ ...progress }]
    }
    if (sql.startsWith('update `snapshot_global_index_progress`')) {
      expect(values[2]).toBe(0)
      Object.assign(progress!, { afterRowId: values[0], complete: values[1] })
      return { affectedRows: 1 }
    }
    if (sql.startsWith('select `transactionId` from `transactions`')) {
      expect(sql).toContain('`transactionId` <= ?')
      expect(sql).toMatch(/for update$/)
      expect(values).toEqual([0, 1])
      return []
    }
    if (sql.startsWith('select `transactionId`, `userId`, `provenTxId`')) {
      const cursor = Number(values[2])
      expect(cursor).toBeGreaterThan(lastSourceCursor)
      lastSourceCursor = cursor
      expect(sql).toContain('CASE WHEN octet_length(txid) <= ? THEN txid END AS txid')
      expect(sql).toContain('COALESCE(octet_length(txid),?) AS txidBytes')
      expect(sql).toContain('where `transactionId` > ? order by `transactionId` asc limit ? for update')
      expect(values.slice(0, 2)).toEqual([256, 0])
      expect(values[3]).toBe(256)
      return Array.from({ length: 257 }, (_, i) => ({
        transactionId: i + 1,
        userId: (i % 2) + 1,
        provenTxId: i % 3 ? 7 : null,
        txid: i % 2 ? 'a' : null,
        txidBytes: i % 2 ? 1 : 0
      }))
        .filter(row => row.transactionId > cursor)
        .slice(0, Number(values[3]))
    }
    if (sql.startsWith('select `provenTxReqId`, `provenTxId`')) {
      expect(sql).toContain('from `proven_tx_reqs` where `txid` = ? limit ? lock in share mode')
      expect(values).toEqual(['a', 1])
      return [{ provenTxReqId: 4294967294, provenTxId: 4294967295 }]
    }
    if (sql.startsWith('insert into `snapshot_global_guards`')) {
      expect(sql).toContain('on duplicate key update `proofId` = `proofId`')
      expect(values[0]).toBe(false)
      guards.add(Number(values[1]))
      return { affectedRows: 1 }
    }
    if (sql.startsWith('UPDATE snapshot_global_guards')) {
      expect(sql).toBe(
        'UPDATE snapshot_global_guards g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=?'
      )
      expect(guards.has(Number(values[0]))).toBe(true)
      return { affectedRows: 1 }
    }
    if (sql.startsWith('insert into `snapshot_global_edges`')) {
      expect(sql).toContain('on duplicate key update `transactionId` = `transactionId`')
      const fields = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(', ')
        .map(value => value.replaceAll('`', ''))
      for (let i = 0; i < values.length; i += fields.length) {
        const row = Object.fromEntries(fields.map((field, offset) => [field, values[i + offset]])) as unknown as Edge
        if (
          !edges.some(
            edge =>
              edge.transactionId === row.transactionId &&
              edge.requestId === row.requestId &&
              edge.tableId === row.tableId &&
              edge.rowId === row.rowId
          )
        )
          edges.push(row)
      }
      return { affectedRows: 1 }
    }
    if (sql.startsWith('select `name` from `knex_migrations`')) {
      expect(values).toEqual([migration, 1])
      return journaled ? [{ name: migration }] : []
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return []
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
    edges,
    progress: () => progress,
    setJournaled: () => {
      journaled = true
    }
  }
}
afterEach(() => jest.restoreAllMocks())

test('MySQL bootstrap uses current locks, bounded pages and idempotent reference edges before adoption', async () => {
  const f = fixture()
  try {
    expect(await enabled(f.k)).toBe(false)
    await install(f.k)
    await install(f.k)
    expect(f.progress()).toEqual({ id: 0, afterRowId: 257, complete: true })
    expect(f.edges).toHaveLength(427)
    expect(f.edges.filter(edge => edge.tableId === 0)).toHaveLength(128)
    expect(f.edges.filter(edge => edge.requestId === 0)).toHaveLength(171)
    expect(f.edges.find(edge => edge.transactionId === 2 && edge.requestId !== 0 && edge.tableId === 1)).toEqual({
      transactionId: 2,
      requestId: 4294967294,
      tableId: 1,
      rowId: 4294967295,
      userId: 2
    })
    expect(f.triggers.size).toBe(14)
    const ddl = f.queries.filter(q => q.sql.startsWith('CREATE TRIGGER')).map(q => q.sql)
    expect(ddl[0]).toContain('snapshot_global_edge_delete')
    expect(ddl[1]).toContain('snapshot_global_edge_insert')
    expect(ddl.findIndex(sql => sql.includes('snapshot_global_tx_before_update'))).toBeLessThan(
      ddl.findIndex(sql => sql.includes('snapshot_global_tx_insert'))
    )
    expect(ddl.findIndex(sql => sql.includes('snapshot_global_req_before_update'))).toBeLessThan(
      ddl.findIndex(sql => sql.includes('snapshot_global_req_insert'))
    )
    expect(ddl.filter(sql => sql.includes('DECLARE requestedId INT UNSIGNED'))).toHaveLength(2)
    expect(ddl.filter(sql => sql.includes('DECLARE requestedProof INT UNSIGNED'))).toHaveLength(2)
    expect(
      ddl.filter(sql => sql.includes('SELECT present FROM snapshot_global_guards WHERE proofId=NEW.rowId FOR SHARE'))
    ).toHaveLength(1)
    expect(ddl.filter(sql => sql.includes('ORDER BY transactionId FOR SHARE'))).toHaveLength(2)
    expect(f.queries.filter(q => q.sql.startsWith('create table')).every(q => q.sql.includes('engine = InnoDB'))).toBe(
      true
    )
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

test('MySQL trigger DDL preserves durable names, conditional updates and all current-read ownership bases', async () => {
  const f = fixture()
  try {
    await install(f.k)
    expect([...f.triggers].map(([name, row]) => [name, row.tableName, row.timing, row.event])).toEqual([
      ['snapshot_global_edge_delete', 'snapshot_global_edges', 'AFTER', 'DELETE'],
      ['snapshot_global_edge_insert', 'snapshot_global_edges', 'AFTER', 'INSERT'],
      ['snapshot_global_tx_delete', 'transactions', 'AFTER', 'DELETE'],
      ['snapshot_global_tx_before_update', 'transactions', 'BEFORE', 'UPDATE'],
      ['snapshot_global_req_delete', 'proven_tx_reqs', 'AFTER', 'DELETE'],
      ['snapshot_global_req_before_update', 'proven_tx_reqs', 'BEFORE', 'UPDATE'],
      ['snapshot_global_proof_delete', 'proven_txs', 'AFTER', 'DELETE'],
      ['snapshot_global_proof_before_update', 'proven_txs', 'BEFORE', 'UPDATE'],
      ['snapshot_global_proof_insert', 'proven_txs', 'AFTER', 'INSERT'],
      ['snapshot_global_proof_after_update', 'proven_txs', 'AFTER', 'UPDATE'],
      ['snapshot_global_tx_insert', 'transactions', 'AFTER', 'INSERT'],
      ['snapshot_global_tx_after_update', 'transactions', 'AFTER', 'UPDATE'],
      ['snapshot_global_req_insert', 'proven_tx_reqs', 'AFTER', 'INSERT'],
      ['snapshot_global_req_after_update', 'proven_tx_reqs', 'AFTER', 'UPDATE']
    ])
    const body = (name: string): string => String(f.triggers.get('snapshot_global_' + name)?.body)
    const transactionChange =
      'NOT (OLD.transactionId <=> NEW.transactionId) OR NOT (OLD.userId <=> NEW.userId) OR NOT (OLD.txid <=> NEW.txid) OR NOT (OLD.provenTxId <=> NEW.provenTxId)'
    const requestChange =
      'NOT (OLD.provenTxReqId <=> NEW.provenTxReqId) OR NOT (OLD.txid <=> NEW.txid) OR NOT (OLD.provenTxId <=> NEW.provenTxId)'
    for (const [name, condition] of [
      ['tx_before_update', transactionChange],
      ['tx_after_update', transactionChange],
      ['req_before_update', requestChange],
      ['req_after_update', requestChange],
      ['proof_before_update', 'NOT (OLD.provenTxId <=> NEW.provenTxId)'],
      ['proof_after_update', 'NOT (OLD.provenTxId <=> NEW.provenTxId)']
    ]) {
      expect(body(name)).toContain('IF ' + condition + ' THEN ')
      expect(body(name)).toMatch(/ END IF; END$/)
    }
    for (const row of f.triggers.values()) expect(row.body).not.toContain('undefined')
    for (const name of ['edge_delete', 'edge_insert', 'tx_delete', 'req_delete', 'proof_delete', 'proof_insert']) {
      expect(body(name)).not.toContain(' END IF;')
    }
    expect(body('edge_insert')).toContain('ON DUPLICATE KEY UPDATE refs=snapshot_global_keys.refs+1;')
    for (const name of ['tx_insert', 'tx_after_update']) {
      const statement = body(name)
      expect(statement).toContain('IF NEW.provenTxId IS NOT NULL THEN ')
      expect(statement).toContain(
        'SELECT provenTxReqId,provenTxId INTO requestedId,requestedProof FROM proven_tx_reqs WHERE txid=NEW.txid FOR SHARE;'
      )
      expect(statement).toContain('IF requestedId IS NOT NULL THEN ')
      expect(statement).toContain('IF requestedProof IS NOT NULL THEN ')
      for (const tuple of [
        'NEW.transactionId,0,1,NEW.provenTxId,NEW.userId',
        'NEW.transactionId,requestedId,0,requestedId,NEW.userId',
        'NEW.transactionId,requestedId,1,requestedProof,NEW.userId'
      ])
        expect(statement).toContain(
          'VALUES (' + tuple + ') ON DUPLICATE KEY UPDATE transactionId = snapshot_global_edges.transactionId;'
        )
      for (const proof of ['NEW.provenTxId', 'requestedProof']) {
        expect(statement).toContain(
          'INSERT INTO snapshot_global_guards (proofId,present) VALUES (' +
            proof +
            ',0) ON DUPLICATE KEY UPDATE proofId=snapshot_global_guards.proofId;'
        )
        expect(statement).toContain(
          'UPDATE snapshot_global_guards g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=' +
            proof +
            ';'
        )
      }
    }
    for (const name of ['req_insert', 'req_after_update']) {
      const statement = body(name)
      expect(statement).toContain(
        'IF NEW.provenTxId IS NOT NULL THEN INSERT INTO snapshot_global_guards (proofId,present) VALUES (NEW.provenTxId,0) ON DUPLICATE KEY UPDATE proofId=snapshot_global_guards.proofId;'
      )
      expect(statement).toContain(
        'UPDATE snapshot_global_guards g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=NEW.provenTxId; END IF;'
      )
      expect(
        statement.match(/ON DUPLICATE KEY UPDATE transactionId = snapshot_global_edges.transactionId;/g)
      ).toHaveLength(2)
    }
    for (const [name, presence] of [
      ['proof_delete', '0'],
      ['proof_before_update', '0'],
      ['proof_insert', '1'],
      ['proof_after_update', '1']
    ])
      expect(body(name)).toContain('ON DUPLICATE KEY UPDATE present=' + presence + ';')
  } finally {
    await f.k.destroy()
  }
})

test.each(['CASCADE', 'SET NULL', 'SET DEFAULT'])(
  'MySQL refuses implicit %s updates or deletes before DDL',
  async rule => {
    for (const field of ['updateRule', 'deleteRule']) {
      const f = fixture((kind, _table, rows) => (kind === 'rules' ? [...rows, { ...rows[0], [field]: rule }] : rows))
      try {
        await expect(install(f.k)).rejects.toThrow('requires explicit row mutations')
        await expect(remove(f.k)).rejects.toThrow('requires explicit row mutations')
        expect(f.queries.some(q => /^(create|alter|drop|insert|update|delete)/i.test(q.sql))).toBe(false)
      } finally {
        await f.k.destroy()
      }
    }
  }
)

test.each([
  ['engine', [], 'requires transactional tables'],
  ['engine', [{ engine: 'MyISAM' }], 'requires transactional tables'],
  ['engine', [{ engine: 'InnoDB' }, { engine: 'InnoDB' }], 'requires transactional tables'],
  ['rules', null, 'requires explicit row mutations'],
  ['sourceColumns', [], 'Unsupported snapshot global source column'],
  ['indexes', null, 'Invalid snapshot global index metadata'],
  ['indexes', [], 'Unsupported snapshot global source key']
] as Array<[Kind, unknown, string]>)(
  'malformed source %s metadata refuses before migration',
  async (kind, value, message) => {
    const f = fixture((current, _table, rows) => (current === kind ? value : rows))
    try {
      await expect(install(f.k)).rejects.toThrow(message)
      await expect(remove(f.k)).rejects.toThrow(message)
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([{ type: 'bigint unsigned' }, { nullable: 'YES' }, { extra: 'VIRTUAL GENERATED' }, { name: 'other' }])(
  'MySQL source key metadata %j is refused',
  async changed => {
    const f = fixture((kind, _table, rows) =>
      kind === 'sourceColumns' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows
    )
    try {
      await expect(install(f.k)).rejects.toThrow('Unsupported snapshot global source column')
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([
  { charset: null },
  { collation: null },
  { type: 'varchar(63)' },
  { nullable: 'YES' },
  { extra: 'auto_increment' }
])('MySQL request text metadata %j is refused', async changed => {
  const f = fixture((kind, table, rows) =>
    kind === 'sourceColumns' && table === 'proven_tx_reqs'
      ? rows.map(row => (row.name === 'txid' ? { ...row, ...changed } : row))
      : rows
  )
  try {
    await expect(install(f.k)).rejects.toThrow('Unsupported snapshot global source')
  } finally {
    await f.k.destroy()
  }
})

test.each([{ charset: 'latin1' }, { collation: 'utf8mb4_bin' }])(
  'MySQL incompatible source text %j is refused',
  async changed => {
    const f = fixture((kind, table, rows) =>
      kind === 'sourceColumns' && table === 'transactions'
        ? rows.map(row => (row.name === 'txid' ? { ...row, ...changed } : row))
        : rows
    )
    try {
      await expect(install(f.k)).rejects.toThrow('require matching text definitions')
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([{ columnName: 'other' }, { direction: 'D' }, { prefix: 10 }, { nonUnique: 1 }])(
  'MySQL incomplete request lookup %j is refused',
  async changed => {
    const f = fixture((kind, table, rows) =>
      kind === 'indexes' && table === 'proven_tx_reqs'
        ? rows.map(row => (row.name === 'source_txid' ? { ...row, ...changed } : row))
        : rows
    )
    try {
      await expect(install(f.k)).rejects.toThrow('requires complete transaction lookup indexes')
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([
  { name: 'other' },
  { type: 'bigint unsigned' },
  { nullable: 'YES' },
  { defaultValue: 0 },
  { extra: 'auto_increment' }
])('MySQL auxiliary column %j cannot be adopted', async changed => {
  const f = fixture((kind, _table, rows) =>
    kind === 'columns' ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows
  )
  try {
    await expect(install(f.k)).rejects.toThrow('table definition mismatch')
  } finally {
    await f.k.destroy()
  }
})

test.each([{ columnName: 'other' }, { direction: 'D' }, { prefix: 10 }, { name: 'foreign_unique' }])(
  'MySQL auxiliary index %j cannot be adopted',
  async changed => {
    const f = fixture((kind, table, rows) =>
      kind === 'indexes' && table.startsWith('snapshot_') ? [{ ...rows[0], ...changed }, ...rows.slice(1)] : rows
    )
    try {
      await expect(install(f.k)).rejects.toThrow('table definition mismatch')
    } finally {
      await f.k.destroy()
    }
  }
)

test.each([{ event: 'UPDATE' }, { timing: 'BEFORE' }, { tableName: 'other' }, { body: 'BEGIN SELECT 1; END' }])(
  'MySQL altered trigger %j refuses removal before dropping objects',
  async changed => {
    let corrupt = false
    const f = fixture((kind, _table, rows) =>
      corrupt && kind === 'triggers' && rows.length ? [{ ...rows[0], ...changed }] : rows
    )
    try {
      await install(f.k)
      corrupt = true
      await expect(install(f.k)).rejects.toThrow('trigger definition mismatch')
      await expect(remove(f.k)).rejects.toThrow('trigger definition mismatch')
      expect(f.triggers.size).toBe(14)
    } finally {
      await f.k.destroy()
    }
  }
)

test('MySQL equivalent trigger whitespace resumes without replacing observers', async () => {
  let reformatted = false
  const f = fixture((kind, _table, rows) =>
    reformatted && kind === 'triggers'
      ? rows.map(row => ({ ...row, body: '\n ' + String(row.body).replaceAll(' ', '\t \n') + '\n' }))
      : rows
  )
  try {
    await install(f.k)
    reformatted = true
    await install(f.k)
    expect(f.queries.filter(q => q.sql.startsWith('CREATE TRIGGER'))).toHaveLength(14)
    await remove(f.k)
    expect(f.triggers.size).toBe(0)
  } finally {
    await f.k.destroy()
  }
})

test('MySQL refuses nested migration transactions before any database work', async () => {
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

test.each([{ rows: [] }, { rows: [{ engine: 'MyISAM' }] }, { rows: [{ engine: 'InnoDB' }, { engine: 'InnoDB' }] }])(
  'MySQL auxiliary engine metadata %j refuses adoption',
  async ({ rows: value }) => {
    const f = fixture((kind, table, rows) => (kind === 'engine' && table.startsWith('snapshot_') ? value : rows))
    try {
      await expect(install(f.k)).rejects.toThrow('table definition mismatch')
    } finally {
      await f.k.destroy()
    }
  }
)

test('MySQL integer display widths preserve the supported source and auxiliary types', async () => {
  const f = fixture((kind, _table, rows) =>
    kind === 'sourceColumns' || kind === 'columns'
      ? rows.map(row => ({ ...row, type: String(row.type).replace(/^(bigint|int)\b/, '$1(10)') }))
      : rows
  )
  try {
    await install(f.k)
    f.setJournaled()
    expect(await enabled(f.k)).toBe(true)
  } finally {
    await f.k.destroy()
  }
})

test.each(['partial primary', 'extra unique', 'compound request lookup'])(
  'MySQL refuses %s index definitions even when their first column matches',
  async altered => {
    const f = fixture((kind, table, rows) => {
      if (kind !== 'indexes') return rows
      if (altered === 'partial primary' && table === 'snapshot_global_keys')
        return rows.map((row, i) => (i === 1 ? { ...row, columnName: 'other' } : row))
      if (altered === 'extra unique' && table === 'snapshot_global_keys')
        return [...rows, { ...rows[0], name: 'unexpected_unique', columnName: 'rowId' }]
      if (altered === 'compound request lookup' && table === 'proven_tx_reqs')
        return [...rows, { ...rows[1], columnName: 'provenTxReqId' }]
      return rows
    })
    try {
      await expect(install(f.k)).rejects.toThrow(
        altered === 'compound request lookup'
          ? 'requires complete transaction lookup indexes'
          : 'table definition mismatch'
      )
    } finally {
      await f.k.destroy()
    }
  }
)

test.each(
  [
    null,
    [
      { event: 'DELETE', timing: 'AFTER', tableName: 'snapshot_global_edges', body: 'BEGIN END' },
      { event: 'DELETE', timing: 'AFTER', tableName: 'snapshot_global_edges', body: 'BEGIN END' }
    ]
  ].map(rows => ({ rows }))
)('MySQL malformed trigger metadata refuses %j', async ({ rows: value }) => {
  const f = fixture((kind, _table, rows) => (kind === 'triggers' ? value : rows))
  try {
    await expect(install(f.k)).rejects.toThrow('trigger')
  } finally {
    await f.k.destroy()
  }
})
