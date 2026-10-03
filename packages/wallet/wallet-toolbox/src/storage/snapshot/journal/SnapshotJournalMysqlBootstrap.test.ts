import { knex, type Knex } from 'knex'
import { copySnapshotJournalBootstrapPage, SNAPSHOT_JOURNAL_BOOTSTRAP_DDL } from './SnapshotJournalBootstrap'
import { installSnapshotJournalMysqlClock } from './SnapshotJournalMysqlClock'
import { SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL } from './SnapshotJournalSqliteObservers'
import { readSnapshotJournalMetadataPage } from './SnapshotJournalPage'
import { snapshotJournalRevision as rev } from './SnapshotJournalRevision'
import { numeric, legacyNames } from '../../schema/snapshotSqliteMembership'

// Real Knex MySQL compilation/response processing with relational state and
// rollback in SQLite. Native MySQL fixtures independently prove DDL, locks,
// source observers, optimizer plans and process/server-crash behavior.
const identities = [
  ...numeric.map(source => ({
    table: source.table,
    keys: [source.key],
    text: undefined as string | undefined,
    extra: undefined as string | undefined
  })),
  {
    table: 'tx_labels_map',
    keys: ['txLabelId', 'transactionId'],
    text: undefined,
    extra: undefined
  },
  {
    table: 'output_tags_map',
    keys: ['outputTagId', 'outputId'],
    text: undefined,
    extra: undefined
  },
  {
    table: 'certificate_fields',
    keys: ['fieldName', 'certificateId'],
    text: 'fieldName',
    extra: undefined
  },
  {
    table: legacyNames.profile,
    keys: ['snapshotTableId', 'snapshotUserId', 'snapshotRowId'],
    text: undefined,
    extra: undefined
  },
  {
    table: legacyNames.relation,
    keys: ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId'],
    text: undefined,
    extra: 'snapshotMembership'
  },
  {
    table: legacyNames.certificate,
    keys: ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'],
    text: 'snapshotFieldName',
    extra: 'snapshotMembership'
  },
  {
    table: legacyNames.keys,
    keys: ['tableId', 'userId', 'rowId'],
    text: undefined,
    extra: 'present'
  }
]
interface Query {
  sql: string
  bindings: Knex.RawBinding[]
  method: string
  response?: unknown
}
async function driver() {
  const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    }),
    k = knex({ client: 'mysql2' })
  const state = {
    next: 9007199254740993n,
    last: '',
    allocated: undefined as unknown,
    filesort: false,
    noIndex: false,
    oversized: false,
    failMetadata: false,
    missingRevisionClock: false,
    nonBinaryText: false,
    invalidIdentity: undefined as unknown
  }
  const queries: Query[] = []
  const connection = {
    __knexUid: 'journal-driver',
    query: (
      options: { sql: string },
      bindings: Knex.RawBinding[] | undefined,
      callback: (error: unknown, rows?: unknown, fields?: unknown) => void
    ) => {
      void k.client._query(connection, { sql: options.sql, bindings: bindings ?? [], method: 'raw' }).then(
        (result: { response: [unknown, unknown] }) => callback(null, ...result.response),
        (error: unknown) => callback(error)
      )
    }
  }
  k.client.acquireConnection = async () => connection
  k.client.releaseConnection = async () => undefined
  k.client._query = async (_connection: unknown, q: Query) => {
    queries.push({ sql: q.sql, bindings: q.bindings, method: q.method })
    const respond = (value: unknown) => {
      q.response = [value, []]
      return q
    }
    if (q.sql.startsWith('SELECT INDEX_NAME name,COLUMN_NAME field')) {
      const source = identities.find(source => source.table === q.bindings[0])
      if (!source) throw new Error('Unknown fixture index')
      return respond(state.noIndex ? [] : source.keys.map(field => ({ name: 'PRIMARY', field })))
    }
    if (q.sql === 'SELECT CAST(LAST_INSERT_ID() AS CHAR) value')
      return respond([{ value: state.allocated === undefined ? state.last : state.allocated }])
    if (state.missingRevisionClock && q.sql.startsWith('select CAST(') && q.sql.includes('`snapshot_journal_clock`'))
      return respond([])
    let sql = q.sql
      .replace(/ FORCE INDEX \(`[^`]+`\)/g, '')
      .replace(/ (?:for (?:share|update)(?: nowait)?|lock in share mode)$/i, '')
      .replaceAll(' AS BINARY)', ' AS BLOB)')
      .replaceAll(' AS SIGNED)', ' AS INTEGER)')
    if (sql.startsWith('EXPLAIN ')) {
      const plan: Array<{ detail: string }> = await db.raw('EXPLAIN QUERY PLAN ' + sql.slice(8), q.bindings)
      return respond(
        plan.map(row => ({
          Extra: state.filesort ? 'Using filesort' : row.detail.includes('TEMP B-TREE') ? 'Using filesort' : ''
        }))
      )
    }
    if (sql.startsWith('CREATE TABLE ')) {
      sql = sql
        .replace(/ ENGINE=InnoDB$/, '')
        .replace('revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY', 'revision TEXT NOT NULL PRIMARY KEY')
        .replaceAll('BIGINT UNSIGNED', 'INTEGER')
    }
    if (/^insert into `snapshot_journal_events` \(\) values \(\)$/i.test(sql)) {
      state.last = String(state.next++)
      await db('snapshot_journal_events').insert({ revision: state.last })
      return respond({ insertId: state.last, affectedRows: 1 })
    }
    sql = sql.replace(/^insert ignore into /i, 'insert or ignore into ')
    if (sql.includes(' on duplicate key update ')) {
      expect(sql).toMatch(/ on duplicate key update `id1` = `snapshot_journal_(?:physical|scope)`\.`id1`$/)
      sql = sql.replace(/ on duplicate key update .+$/, ' on conflict do nothing')
      if (state.failMetadata) throw new Error('metadata write failed')
    }
    const result = await db.raw(sql, q.bindings)
    if (state.nonBinaryText && Array.isArray(result) && q.sql.includes('`boundedText`'))
      for (const row of result) row.boundedText = 'not bytes'
    if (Array.isArray(result) && sql.startsWith('select `s`.') && state.invalidIdentity !== undefined)
      for (const row of result) row.transactionId = state.invalidIdentity
    if (Array.isArray(result))
      return respond(
        state.oversized && sql.startsWith('select `s`.') ? Array.from({ length: 257 }, () => result[0]) : result
      )
    return respond({ affectedRows: result?.changes ?? 0, insertId: result?.lastInsertRowid ?? 0 })
  }
  await installSnapshotJournalMysqlClock(k, rev('9223372036854775807'))
  await db.raw(SNAPSHOT_JOURNAL_BOOTSTRAP_DDL)
  await db('snapshot_journal_bootstrap').insert({ id: 1, stream: 0, cursor: null, rowLimit: 1000000, rowsUsed: 0 })
  for (const ddl of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await db.raw(ddl)
  for (const source of identities) {
    const columns = [...source.keys, ...(source.extra ? [source.extra] : [])].map(
      name => '`' + name + '` ' + (source.text === name ? 'TEXT' : 'INTEGER') + ' NOT NULL'
    )
    await db.raw(
      'CREATE TABLE `' +
        source.table +
        '`(' +
        columns.join(',') +
        ',PRIMARY KEY(' +
        source.keys.map(key => '`' + key + '`').join(',') +
        '))'
    )
  }
  queries.length = 0
  return {
    db,
    k,
    state,
    queries,
    close: async () => {
      await k.destroy()
      await db.destroy()
    }
  }
}
function sample(stream: number, id: number) {
  const source = identities[stream],
    row: Record<string, number | string> = {}
  for (const key of source.keys)
    row[key] =
      key === source.text
        ? 'field-' + String(id).padStart(3, '0')
        : key.toLowerCase().includes('tableid')
          ? 0
          : key.toLowerCase().includes('userid')
            ? 1
            : id
  if (source.extra) row[source.extra] = 1
  return row
}
test.each(identities.map((source, stream) => [source.table, stream] as const))(
  'MySQL bootstrap copies and resumes indexed %s keys with exact revisions',
  async (_table, stream) => {
    const f = await driver()
    try {
      const source = identities[stream]
      await f.db('snapshot_journal_bootstrap').update({ stream, cursor: null })
      await f.db(source.table).insert([sample(stream, 1), sample(stream, 2)])
      const first = await copySnapshotJournalBootstrapPage(f.k, 1000000)
      expect(first).toEqual({ complete: false, selected: 2, stream, invalidated: false })
      const metadata = stream < 13 ? 'snapshot_journal_physical' : 'snapshot_journal_scope',
        rows = await f.db(metadata).select('*', f.db.raw('CAST(revision AS TEXT) AS exactRevision'))
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.exactRevision)).toEqual(['9007199254740993', '9007199254740993'])
      expect(rows.every(row => row.exactText instanceof Uint8Array)).toBe(true)
      expect(await f.db('snapshot_journal_events')).toEqual([])
      await f.db(source.table).insert(sample(stream, 3))
      expect((await copySnapshotJournalBootstrapPage(f.k, 1000000)).selected).toBe(1)
      const final = await copySnapshotJournalBootstrapPage(f.k, 1000000)
      expect(final).toEqual({ complete: stream === 16, selected: 0, stream, invalidated: false })
      expect(await f.db('snapshot_journal_bootstrap').first()).toEqual({
        id: 1,
        stream: stream + 1,
        cursor: null,
        rowLimit: 1000000,
        rowsUsed: 3
      })
      expect(f.queries.some(q => q.sql.endsWith('for update nowait'))).toBe(true)
      expect(
        f.queries.some(q => q.sql.includes('FORCE INDEX (`PRIMARY`)') && q.sql.endsWith('lock in share mode'))
      ).toBe(true)
    } finally {
      await f.close()
    }
  }
)
test('MySQL bootstrap bounds each page and preserves an already observed newer generation', async () => {
  const f = await driver()
  try {
    for (let first = 1; first <= 300; first += 50)
      await f.db('transactions').insert(Array.from({ length: 50 }, (_, i) => ({ transactionId: first + i })))
    await f.db('snapshot_journal_physical').insert({
      tableId: 0,
      id1: 1,
      id2: 0,
      exactText: Buffer.alloc(0),
      revision: '9007199254740999',
      generation: '9007199254740998',
      present: 0
    })
    const page = await copySnapshotJournalBootstrapPage(f.k, 1000000)
    expect(page.selected).toBe(256)
    const writes = f.queries.filter(q => q.sql.startsWith('insert into `snapshot_journal_physical`'))
    expect(writes).toHaveLength(4)
    writes.forEach(query => expect(query.bindings.length).toBeLessThanOrEqual(64 * 7))
    const preserved = await f
      .db('snapshot_journal_physical')
      .where({ tableId: 0, id1: 1 })
      .select('present', f.db.raw('CAST(revision AS TEXT) revision'), f.db.raw('CAST(generation AS TEXT) generation'))
      .first()
    expect(preserved).toEqual({
      present: 0,
      revision: '9007199254740999',
      generation: '9007199254740998'
    })
    expect((await copySnapshotJournalBootstrapPage(f.k, 1000000)).selected).toBe(44)
  } finally {
    await f.close()
  }
})
test.each([
  ['capacity-exhausted', '10', '11'],
  ['revision-exhausted', '9223372036854775807', '9223372036854775808']
] as const)('MySQL %s invalidates atomically without advancing bootstrap', async (reason, ceiling, next) => {
  const f = await driver()
  try {
    await f.db('transactions').insert({ transactionId: 1 })
    await f.db('snapshot_journal_clock').update({ ceiling })
    f.state.next = BigInt(next)
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toEqual({
      complete: false,
      selected: 1,
      stream: 0,
      invalidated: true
    })
    expect(await f.db('snapshot_journal_invalid')).toEqual([{ id: 1, reason }])
    expect(await f.db('snapshot_journal_physical')).toEqual([])
    expect((await f.db('snapshot_journal_bootstrap').first()).cursor).toBeNull()
    expect(await f.db('transactions')).toEqual([{ transactionId: 1 }])
    expect((await copySnapshotJournalBootstrapPage(f.k, 1000000)).invalidated).toBe(true)
  } finally {
    await f.close()
  }
})
test.each([null, 1, '-1', '1.5', 'bad'])('MySQL malformed allocator value %p rolls back page state', async value => {
  const f = await driver()
  try {
    await f.db('transactions').insert({ transactionId: 1 })
    f.state.allocated = value
    await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
    expect(await f.db('snapshot_journal_events')).toEqual([])
    expect(await f.db('snapshot_journal_physical')).toEqual([])
    expect((await f.db('snapshot_journal_bootstrap').first()).cursor).toBeNull()
  } finally {
    await f.close()
  }
})
test.each(['filesort', 'noIndex', 'oversized', 'failMetadata'] as const)(
  'MySQL %s refuses and rolls back before checkpoint advancement',
  async kind => {
    const f = await driver()
    try {
      await f.db('transactions').insert({ transactionId: 1 })
      f.state[kind] = true
      await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow()
      expect(await f.db('snapshot_journal_physical')).toEqual([])
      expect((await f.db('snapshot_journal_bootstrap').first()).cursor).toBeNull()
    } finally {
      await f.close()
    }
  }
)
test('MySQL oversized historical UTF-8 key invalidates without copying or changing source', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ stream: 12 })
    await f.db('certificate_fields').insert({ fieldName: 'a'.repeat(401), certificateId: 1 })
    expect((await copySnapshotJournalBootstrapPage(f.k, 1000000)).invalidated).toBe(true)
    expect(await f.db('snapshot_journal_invalid')).toEqual([{ id: 1, reason: 'key-out-of-range' }])
    expect(await f.db('snapshot_journal_physical')).toEqual([])
    expect((await f.db('certificate_fields').first()).fieldName).toHaveLength(401)
  } finally {
    await f.close()
  }
})
test('MySQL page continuation follows the complete byte-exact composite cursor', async () => {
  const f = await driver()
  try {
    const values = ['A', 'a', 'a ', 'é', '中']
    for (const [i, exactText] of values.entries())
      await f.db('snapshot_journal_scope').insert({
        tableId: 12,
        userId: 1,
        id1: i < 3 ? 1 : 2,
        id2: 0,
        exactText: Buffer.from(exactText),
        revision: '9007199254740993',
        present: 1
      })
    let after,
      actual: string[] = []
    for (let i = 0; i < 4; i++) {
      const page = await readSnapshotJournalMetadataPage(f.k, {
        stream: 'scope',
        tableId: 12,
        userId: 1,
        floor: rev('0'),
        low: rev('9007199254740992'),
        high: rev('9007199254740999'),
        limit: 2,
        after
      })
      actual.push(...page.rows.map(row => row.exactText))
      if (page.complete) break
      after = page.after
    }
    expect(actual).toEqual(values)
    expect(f.queries.some(q => q.sql.includes(' or (') && q.sql.includes('`j`.`exactText` > ?'))).toBe(true)
  } finally {
    await f.close()
  }
})
test.each(['clock', 'bootstrap'])('missing MySQL %s state refuses rather than creating a new baseline', async kind => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_' + kind).delete()
    await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
    expect(await f.db('snapshot_journal_physical')).toEqual([])
  } finally {
    await f.close()
  }
})
test.each(['not-json', '[]', '[-1]', '[1.5]', '["1"]', 'x'.repeat(2049)])(
  'invalid MySQL bootstrap cursor %s refuses without source changes',
  async cursor => {
    const f = await driver()
    try {
      await f.db('transactions').insert({ transactionId: 1 })
      await f.db('snapshot_journal_bootstrap').update({ cursor })
      await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
      expect(await f.db('snapshot_journal_physical')).toEqual([])
      expect(await f.db('transactions')).toEqual([{ transactionId: 1 }])
    } finally {
      await f.close()
    }
  }
)
test('completed MySQL bootstrap is stable and a dangling terminal cursor refuses', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ stream: 17 })
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toEqual({
      complete: true,
      selected: 0,
      stream: 17,
      invalidated: false
    })
    await f.db('snapshot_journal_bootstrap').update({ cursor: '[]' })
    await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
  } finally {
    await f.close()
  }
})

test.each(['missingRevisionClock', 'nonBinaryText'] as const)(
  'malformed bootstrap driver %s rolls back progress',
  async kind => {
    const f = await driver()
    try {
      const stream = kind === 'nonBinaryText' ? 12 : 0
      await f.db(identities[stream].table).insert(sample(stream, 1))
      await f.db('snapshot_journal_bootstrap').update({ stream })
      const clock = await f.db('snapshot_journal_clock'),
        progress = await f.db('snapshot_journal_bootstrap')
      f.state[kind] = true
      await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
      expect(await f.db('snapshot_journal_physical')).toEqual([])
      expect(await f.db('snapshot_journal_clock')).toEqual(clock)
      expect(await f.db('snapshot_journal_bootstrap')).toEqual(progress)
    } finally {
      await f.close()
    }
  }
)

test.each([14, 15, 16])('MySQL stream %s preserves absent membership and its physical-table mapping', async stream => {
  const f = await driver()
  try {
    const source = identities[stream],
      extra = source.extra!
    const present = sample(stream, 1),
      absent = { ...sample(stream, 2), [extra]: 0 }
    if (stream === 16) absent.tableId = 1
    await f.db('snapshot_journal_bootstrap').update({ stream })
    await f.db(source.table).insert([present, absent])
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toMatchObject({
      selected: 2,
      invalidated: false
    })
    const rows = await f.db('snapshot_journal_scope').orderBy('id1')
    expect(rows.map(row => ({ tableId: row.tableId, id1: row.id1, present: row.present }))).toEqual([
      { tableId: stream === 14 ? 10 : stream === 15 ? 12 : 9, id1: 1, present: 1 },
      { tableId: stream === 14 ? 10 : stream === 15 ? 12 : 8, id1: 2, present: 0 }
    ])
  } finally {
    await f.close()
  }
})

test.each(['10', '9223372036854775807'])('MySQL can allocate the exact final allowed revision %s', async ceiling => {
  const f = await driver()
  f.k.client.config.client = 'mysql'
  try {
    await f.db('transactions').insert({ transactionId: 1 })
    await f.db('snapshot_journal_clock').update({ ceiling })
    f.state.next = BigInt(ceiling)
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toMatchObject({
      selected: 1,
      invalidated: false
    })
    expect(await f.db('snapshot_journal_physical').select(f.db.raw('CAST(revision AS TEXT) revision'))).toEqual([
      { revision: ceiling }
    ])
    expect(await f.db('snapshot_journal_invalid')).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([-1, 0, 1.5, 'invalid', 9007199254740992])(
  'MySQL invalid historical identity %p invalidates atomically and preserves source',
  async transactionId => {
    const f = await driver()
    try {
      const malformedResponse = typeof transactionId !== 'number' || !Number.isInteger(transactionId)
      await f.db('transactions').insert({ transactionId: malformedResponse ? 1 : transactionId })
      if (malformedResponse) f.state.invalidIdentity = transactionId
      expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toMatchObject({
        selected: 1,
        invalidated: true
      })
      expect(await f.db('snapshot_journal_invalid')).toEqual([{ id: 1, reason: 'key-out-of-range' }])
      expect(await f.db('snapshot_journal_physical')).toEqual([])
      expect((await f.db('snapshot_journal_bootstrap').first()).cursor).toBeNull()
      expect((await f.db('transactions').first()).transactionId).toBe(malformedResponse ? 1 : transactionId)
    } finally {
      await f.close()
    }
  }
)

test('MySQL accepts a 400-byte key through the final composite bootstrap cursor', async () => {
  const f = await driver()
  try {
    const fieldName = '😀'.repeat(100)
    await f.db('snapshot_journal_bootstrap').update({ stream: 12 })
    await f.db('certificate_fields').insert({ fieldName, certificateId: 1 })
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toMatchObject({
      selected: 1,
      invalidated: false
    })
    expect(Buffer.from((await f.db('snapshot_journal_physical').first()).exactText).toString('utf8')).toBe(fieldName)
    expect(await copySnapshotJournalBootstrapPage(f.k, 1000000)).toMatchObject({
      selected: 0,
      invalidated: false
    })
  } finally {
    await f.close()
  }
})

test('MySQL bootstrap charges an explicit immutable allowance across resumed pages', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ rowLimit: null })
    for (let first = 1; first <= 300; first += 50)
      await f.db('transactions').insert(Array.from({ length: 50 }, (_, offset) => sample(0, first + offset)))
    expect(await copySnapshotJournalBootstrapPage(f.k, 300)).toMatchObject({ selected: 256, invalidated: false })
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 0,
      cursor: '[256]',
      rowLimit: 300,
      rowsUsed: 256
    })
    const prior = await f.db('snapshot_journal_bootstrap').first()
    await expect(copySnapshotJournalBootstrapPage(f.k, 301)).rejects.toThrow('Invalid snapshot')
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual(prior)
    expect(await copySnapshotJournalBootstrapPage(f.k, 300)).toMatchObject({ selected: 44, invalidated: false })
    const full = await f.db('snapshot_journal_bootstrap').first()
    expect(full).toEqual({ id: 1, stream: 0, cursor: '[300]', rowLimit: 300, rowsUsed: 300 })
    await f.db('transactions').insert(sample(0, 301))
    expect(await copySnapshotJournalBootstrapPage(f.k, 300)).toEqual({
      complete: false,
      selected: 1,
      stream: 0,
      invalidated: true
    })
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual(full)
    expect(await f.db('snapshot_journal_invalid')).toEqual([{ id: 1, reason: 'capacity-exhausted' }])
    expect(Number((await f.db('snapshot_journal_physical').count('* AS n').first())!.n)).toBe(300)
    expect(Number((await f.db('transactions').count('* AS n').first())!.n)).toBe(301)
    await expect(copySnapshotJournalBootstrapPage(f.k, 301)).rejects.toThrow('Invalid snapshot')
    expect((await copySnapshotJournalBootstrapPage(f.k, 300)).selected).toBe(0)
  } finally {
    await f.close()
  }
})

test('MySQL bootstrap refuses a whole over-budget page before allocation or metadata writes', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ rowLimit: null })
    await f.db('transactions').insert([sample(0, 1), sample(0, 2)])
    const sequence = f.state.next
    expect(await copySnapshotJournalBootstrapPage(f.k, 1)).toEqual({
      complete: false,
      selected: 2,
      stream: 0,
      invalidated: true
    })
    expect(f.state.next).toBe(sequence)
    expect(await f.db('snapshot_journal_physical')).toEqual([])
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 0,
      cursor: null,
      rowLimit: 1,
      rowsUsed: 0
    })
    expect(await f.db('transactions')).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test('MySQL bootstrap rolls back first allowance binding and charge with failed metadata', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ rowLimit: null })
    await f.db('transactions').insert(sample(0, 1))
    f.state.failMetadata = true
    await expect(copySnapshotJournalBootstrapPage(f.k, 1)).rejects.toThrow('metadata write failed')
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 0,
      cursor: null,
      rowLimit: null,
      rowsUsed: 0
    })
    expect(await f.db('snapshot_journal_physical')).toEqual([])
    f.state.failMetadata = false
    await copySnapshotJournalBootstrapPage(f.k, 1)
    expect((await f.db('snapshot_journal_bootstrap').first()).rowsUsed).toBe(1)
    await copySnapshotJournalBootstrapPage(f.k, 1)
    expect((await f.db('snapshot_journal_bootstrap').first()).rowsUsed).toBe(1)
  } finally {
    await f.close()
  }
})

test('MySQL bootstrap charges examined records even when live metadata already owns the key', async () => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ rowLimit: null })
    await f.db('transactions').insert(sample(0, 1))
    const live = { tableId: 0, id1: 1, id2: 0, exactText: Buffer.from(''), revision: 9, generation: 7, present: 0 }
    await f.db('snapshot_journal_physical').insert(live)
    await copySnapshotJournalBootstrapPage(f.k, 1)
    expect(await f.db('snapshot_journal_physical').first()).toEqual(live)
    expect((await f.db('snapshot_journal_bootstrap').first()).rowsUsed).toBe(1)
  } finally {
    await f.close()
  }
})

test.each([0, 2147483647])('MySQL bootstrap persists boundary allowance %s for an empty stream', async allowance => {
  const f = await driver()
  try {
    await f.db('snapshot_journal_bootstrap').update({ rowLimit: null })
    expect(await copySnapshotJournalBootstrapPage(f.k, allowance)).toEqual({
      complete: false,
      selected: 0,
      stream: 0,
      invalidated: false
    })
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 1,
      cursor: null,
      rowLimit: allowance,
      rowsUsed: 0
    })
  } finally {
    await f.close()
  }
})

test.each([-1, 0.5, 2147483648, NaN, Infinity, '1', undefined, null])(
  'MySQL bootstrap rejects invalid allowance %s before I/O',
  async allowance => {
    const f = await driver()
    try {
      await expect(copySnapshotJournalBootstrapPage(f.k, allowance as number)).rejects.toThrow('Invalid snapshot')
      expect(f.queries).toEqual([])
    } finally {
      await f.close()
    }
  }
)

test.each([{ rowsUsed: 0.5 }, { rowLimit: 0.5 }, { rowLimit: null, rowsUsed: 1 }])(
  'MySQL bootstrap refuses malformed persisted budget %j',
  async patch => {
    const f = await driver()
    try {
      await f.db('snapshot_journal_bootstrap').update(patch)
      const before = await f.db('snapshot_journal_bootstrap').first()
      await expect(copySnapshotJournalBootstrapPage(f.k, 1000000)).rejects.toThrow('Invalid snapshot')
      expect(await f.db('snapshot_journal_bootstrap').first()).toEqual(before)
      expect(await f.db('snapshot_journal_physical')).toEqual([])
    } finally {
      await f.close()
    }
  }
)

test('MySQL bootstrap rejects caller transactions before a nested transaction or progress read', async () => {
  const f = await driver()
  try {
    const before = await f.db('snapshot_journal_bootstrap').first()
    await f.k.transaction(async t => {
      const count = f.queries.length
      await expect(copySnapshotJournalBootstrapPage(t, 1000000)).rejects.toThrow('Invalid snapshot')
      expect(f.queries).toHaveLength(count)
    })
    expect(await f.db('snapshot_journal_bootstrap').first()).toEqual(before)
  } finally {
    await f.close()
  }
})
