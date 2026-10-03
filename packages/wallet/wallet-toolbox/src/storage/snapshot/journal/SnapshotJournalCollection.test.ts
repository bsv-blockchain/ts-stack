import { knex, type Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } from './SnapshotJournalSqliteClock'
import { SNAPSHOT_JOURNAL_SQLITE_GENERATION_DDL } from './SnapshotJournalSqliteGeneration'
import { SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL } from './SnapshotJournalSqliteObservers'
import { snapshotJournalReceiptDdl } from './SnapshotJournalReceipt'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  collectSnapshotJournalTombstones,
  snapshotJournalCollectionQuery,
  type SnapshotJournalCollectionRequest
} from './SnapshotJournalCollection'

const epoch = '12345678-1234-4234-9234-123456789012'
const request = (stream: 'scope' | 'physical' = 'scope', limit = 256): SnapshotJournalCollectionRequest => ({
  epoch,
  floor: snapshotJournalRevision('50'),
  stream,
  limit
})
let k: Knex, directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ts569-collection-'))
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await k.raw('PRAGMA journal_mode=WAL')
  await k.raw('PRAGMA busy_timeout=0')
  for (const ddl of [
    SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL,
    SNAPSHOT_JOURNAL_SQLITE_GENERATION_DDL,
    ...SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL,
    ...snapshotJournalReceiptDdl(k)
  ])
    await k.raw(ddl)
  await k('snapshot_journal_clock').insert({ id: 1, revision: 100, ceiling: 100000, enabled: 1, reason: null })
  await k('snapshot_journal_generation').insert({
    id: 1,
    version: 1,
    epoch,
    source: 'a'.repeat(64),
    ceiling: '100000',
    complete: 1
  })
  await k('snapshot_journal_retention').insert({ id: 1, floor: '50', receiptLimit: 128, receiptLifetimeMs: 60000 })
})
afterEach(async () => {
  await k.destroy()
  await rm(directory, { recursive: true, force: true })
})
const scope = (id1: number, present: number, revision = 10) => ({
  tableId: 0,
  userId: 1,
  id1,
  id2: 0,
  exactText: '',
  revision,
  present
})

test('the bound counts live rows; later tombstones require another primary-key page', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => scope(i + 1, Number(i < 260), i >= 290 ? 60 : 10))
  for (let n = 0; n < rows.length; n += 100) await k('snapshot_journal_scope').insert(rows.slice(n, n + 100))
  const first = await k.transaction(t => collectSnapshotJournalTombstones(t, request()))
  expect(first).toMatchObject({ examined: 256, removed: 0, complete: false })
  expect(await k('snapshot_journal_scope')).toHaveLength(300)
  const second = await k.transaction(t => collectSnapshotJournalTombstones(t, { ...request(), after: first!.after }))
  expect(second).toMatchObject({ examined: 44, removed: 30, complete: true })
  expect(await k('snapshot_journal_scope').orderBy('id1')).toEqual(
    rows.filter(row => row.present === 1 || row.revision > 50)
  )
  const sql = snapshotJournalCollectionQuery(k, { ...request(), after: first!.after }).toSQL()
  const plan: Array<{ detail: string }> = await k.raw(
    'EXPLAIN QUERY PLAN ' + sql.sql,
    sql.bindings as Knex.RawBinding[]
  )
  expect(plan.some(row => /SEARCH j USING INDEX sqlite_autoindex_snapshot_journal_scope_1/.test(row.detail))).toBe(true)
  expect(plan.some(row => /TEMP B-TREE/.test(row.detail))).toBe(false)
  expect(sql.sql).not.toMatch(/where.*(?:present|revision)/)
})

test('physical keys preserve exact UTF-8 order and resume after deleted positions', async () => {
  const texts = ['😀', 'é', 'Z', 'A']
  const rows = texts.map(exactText => ({
    tableId: 12,
    id1: 1,
    id2: 0,
    exactText,
    revision: 40,
    generation: 30,
    present: 0
  }))
  await k('snapshot_journal_physical').insert(rows)
  await k('snapshot_journal_scope').insert(scope(1, 0))
  const first = await k.transaction(t => collectSnapshotJournalTombstones(t, request('physical', 2)))
  expect(first).toMatchObject({ examined: 2, removed: 2, complete: false, after: { key: { exactText: 'Z' } } })
  const second = await k.transaction(t =>
    collectSnapshotJournalTombstones(t, { ...request('physical', 2), after: first!.after })
  )
  expect(second).toMatchObject({ removed: 2, after: { key: { exactText: '😀' } } })
  const last = await k.transaction(t =>
    collectSnapshotJournalTombstones(t, { ...request('physical', 2), after: second!.after })
  )
  expect(last).toEqual({ examined: 0, removed: 0, complete: true, after: second!.after })
  expect(await k('snapshot_journal_scope')).toHaveLength(1)
})

test('epoch, stream and floor mismatches never collect another pass', async () => {
  await k('snapshot_journal_scope').insert(scope(1, 0))
  const cursor = { ...request(), key: { tableId: 0, userId: 1, id1: 1, id2: 0, exactText: '' } }
  for (const change of [
    { epoch: '12345678-1234-4234-9234-123456789013' },
    { floor: snapshotJournalRevision('49') },
    { stream: 'physical' as const }
  ])
    await expect(
      k.transaction(t => collectSnapshotJournalTombstones(t, { ...request(), after: { ...cursor, ...change } }))
    ).rejects.toThrow()
  await expect(
    k.transaction(t => collectSnapshotJournalTombstones(t, { ...request(), floor: snapshotJournalRevision('49') }))
  ).rejects.toThrow()
  await k('snapshot_journal_generation').update({ complete: 0 })
  await expect(k.transaction(t => collectSnapshotJournalTombstones(t, request()))).rejects.toThrow()
  expect(await k('snapshot_journal_scope')).toHaveLength(1)
  expect((await k('snapshot_journal_clock').first()).revision).toBe(100)
})

test('collection rollback restores deleted metadata; a lost acknowledgement leaves its committed result', async () => {
  await k('snapshot_journal_scope').insert([scope(1, 0), scope(2, 1)])
  await expect(
    k.transaction(async t => {
      await collectSnapshotJournalTombstones(t, request())
      throw new Error('before commit')
    })
  ).rejects.toThrow('before commit')
  expect(await k('snapshot_journal_scope')).toHaveLength(2)
  await expect(
    (async () => {
      await k.transaction(t => collectSnapshotJournalTombstones(t, request()))
      throw new Error('lost acknowledgement')
    })()
  ).rejects.toThrow('lost acknowledgement')
  expect(await k('snapshot_journal_scope').select('id1')).toEqual([{ id1: 2 }])
})

test.each([
  { present: 2 },
  { revision: 0 },
  { exactText: 'x'.repeat(401) },
  { exactText: Buffer.from([255]) },
  { id1: 0 }
])('corrupt metadata %o refuses the whole page before deletion', async change => {
  await k('snapshot_journal_scope').insert([scope(1, 0), { ...scope(2, 0), ...change }])
  await expect(k.transaction(t => collectSnapshotJournalTombstones(t, request()))).rejects.toThrow()
  expect(await k('snapshot_journal_scope')).toHaveLength(2)
})

test.each([0, 257, Number.MAX_SAFE_INTEGER + 1, '1', null])(
  'rejects invalid bound %p before mutating the clock',
  async limit => {
    await expect(
      k.transaction(t =>
        collectSnapshotJournalTombstones(t, { ...request(), limit } as SnapshotJournalCollectionRequest)
      )
    ).rejects.toThrow()
    expect((await k('snapshot_journal_clock').first()).revision).toBe(100)
  }
)

test('a disabled generation never deletes metadata or advances its floor', async () => {
  await k('snapshot_journal_scope').insert(scope(1, 0))
  await k('snapshot_journal_clock').update({ enabled: 0, reason: 'capacity-exhausted' })
  expect(await k.transaction(t => collectSnapshotJournalTombstones(t, request()))).toBeUndefined()
  expect(await k('snapshot_journal_scope')).toHaveLength(1)
  expect((await k('snapshot_journal_retention').first()).floor).toBe('50')
})

test('collection requires a caller-owned transaction before allocating a revision', async () => {
  await expect(collectSnapshotJournalTombstones(k, request())).rejects.toThrow(
    'Invalid snapshot journal tombstone collection state'
  )
  expect((await k('snapshot_journal_clock').first()).revision).toBe(100)
})

test('300 seeded independent ledgers preserve the live view across bounded passes', async () => {
  let seed = 3242026
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % bound
  }
  for (let n = 0; n < 300; n++) {
    const stream = n % 2 ? 'scope' : 'physical',
      table = 'snapshot_journal_' + stream
    const fields =
      stream === 'scope' ? ['tableId', 'userId', 'id1', 'id2', 'exactText'] : ['tableId', 'id1', 'id2', 'exactText']
    const order = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      for (const field of fields) {
        const difference =
          field === 'exactText'
            ? Buffer.compare(Buffer.from(a[field] as string), Buffer.from(b[field] as string))
            : (a[field] as number) - (b[field] as number)
        if (difference) return difference
      }
      return 0
    }
    const source = Array.from({ length: 16 }, (_unused, i) => {
      const revision = [1, 49, 50, 51, 70][random(5)]
      return {
        tableId: random(13),
        ...(stream === 'scope' ? { userId: random(3) + 1 } : {}),
        id1: i + 1,
        id2: random(4),
        exactText: ['', 'A', 'Z', 'é', '😀', 'é'.repeat(200)][random(6)],
        revision,
        present: random(2),
        ...(stream === 'physical' ? { generation: revision } : {})
      }
    }).sort(order)
    await k(table).delete()
    await k(table).insert(source)
    const bound = random(8) + 1
    let input = request(stream, bound),
      examined = 0
    while (true) {
      const position = input.after?.key
      const expected = source.filter(row => position === undefined || order(row, { ...position }) > 0).slice(0, bound)
      const result = await k.transaction(t => collectSnapshotJournalTombstones(t, input))
      expect(result).toMatchObject({
        examined: expected.length,
        removed: expected.filter(row => row.present === 0 && row.revision <= 50).length,
        complete: expected.length < bound
      })
      examined += result!.examined
      if (expected.length) {
        const last = expected[expected.length - 1]
        expect(result!.after!.key).toEqual(
          Object.fromEntries(fields.map(field => [field, last[field as keyof typeof last]]))
        )
      }
      if (result!.complete) break
      input = { ...input, after: result!.after }
    }
    expect(examined).toBe(source.length)
    const retained = await k(table).select()
    retained.sort(order)
    expect(retained).toEqual(source.filter(row => row.present === 1 || row.revision > 50))
  }
}, 60000)

test.each(['mysql', 'mysql2'])(
  'MySQL %s generates a bounded exact composite range with current locks',
  async client => {
    const mysql = knex({ client: 'mysql2' })
    mysql.client.config.client = client
    try {
      for (const stream of ['scope', 'physical'] as const) {
        const key = { tableId: 12, ...(stream === 'scope' ? { userId: 41 } : {}), id1: 987, id2: 12, exactText: 'é' }
        const input = { ...request(stream, 19), after: { epoch, floor: request().floor, stream, key } }
        const sql = snapshotJournalCollectionQuery(mysql, input).toSQL()
        const fields =
          stream === 'scope' ? ['tableId', 'userId', 'id1', 'id2', 'exactText'] : ['tableId', 'id1', 'id2', 'exactText']
        const operands = stream === 'scope' ? [12, 41, 987, 12, Buffer.from('é')] : [12, 987, 12, Buffer.from('é')]
        const ranges = fields.map(
          (field, i) =>
            '(' +
            [...fields.slice(0, i).map(prefix => '`j`.`' + prefix + '` = ?'), '`j`.`' + field + '` > ?'].join(' and ') +
            ')'
        )
        const where = '`j`.`tableId` >= ? and (' + ranges.join(' or ') + ')'
        expect(sql.sql).toContain('FORCE INDEX (`PRIMARY`)')
        expect(sql.sql).toContain(
          'where ' +
            where +
            ' order by ' +
            fields.map(field => '`j`.`' + field + '` asc').join(', ') +
            ' limit ? for update nowait'
        )
        expect(sql.bindings).toEqual([12, ...fields.flatMap((_field, i) => operands.slice(0, i + 1)), 19])
        expect(sql.sql).toContain('substr(`j`.`exactText`,1,401)')
        expect(sql.sql).toContain('substr(CAST(`j`.`revision` AS CHAR),1,20)')
        if (stream === 'physical') expect(sql.sql).toContain('substr(CAST(`j`.`generation` AS CHAR),1,20)')
        expect(sql.sql).not.toMatch(/where.*(?:present|revision)/)
      }
    } finally {
      await mysql.destroy()
    }
  }
)

test('unsupported drivers refuse before a collection query can be constructed', async () => {
  for (const client of ['pg', 'mysql-compatible', '', undefined]) {
    const unsupported = { client: { config: { client } } } as unknown as Knex
    expect(() => snapshotJournalCollectionQuery(unsupported, request())).toThrow(WERR_INVALID_OPERATION)
  }
})

test('all cursor envelopes and key bounds reject with the established error identity', () => {
  const validKey = { tableId: 0, userId: 1, id1: 1, id2: 0, exactText: '' }
  const validCursor = { epoch, floor: request().floor, stream: 'scope' as const, key: validKey }
  const invalidRequests: unknown[] = [
    undefined,
    null,
    1,
    'scope',
    Object.assign([], request()),
    { ...request(), epoch: null },
    { ...request(), epoch: 'x' + epoch },
    { ...request(), epoch: epoch + 'x' },
    { ...request(), epoch: epoch.replace('-4', '-3') },
    { ...request(), stream: 'unknown' },
    { ...request(), after: null },
    { ...request(), after: Object.assign([], validCursor) },
    { ...request(), after: { ...validCursor, key: null } },
    { ...request(), after: { ...validCursor, key: Object.assign([], validKey) } }
  ]
  for (const change of [
    { tableId: -1 },
    { tableId: 13 },
    { tableId: 0.5 },
    { userId: 0 },
    { userId: 1.5 },
    { userId: Number.MAX_SAFE_INTEGER + 1 },
    { id1: 0 },
    { id1: 1.5 },
    { id1: '1' },
    { id2: -1 },
    { id2: 0.5 },
    { exactText: null },
    { exactText: '\ud800' },
    { exactText: 'é'.repeat(201) }
  ])
    invalidRequests.push({ ...request(), after: { ...validCursor, key: { ...validKey, ...change } } })
  invalidRequests.push({ ...request('physical'), after: { ...validCursor, stream: 'physical', key: validKey } })
  for (const input of invalidRequests)
    expect(() => snapshotJournalCollectionQuery(k, input as SnapshotJournalCollectionRequest)).toThrow(
      WERR_INVALID_OPERATION
    )
  expect(() =>
    snapshotJournalCollectionQuery(k, {
      ...request(),
      after: { ...validCursor, key: { ...validKey, exactText: 'é'.repeat(200) } }
    })
  ).not.toThrow()
})

test.each(['scope', 'physical'] as const)(
  'MySQL %s parses exact stored keys and deletes only the eligible row',
  async stream => {
    const mysql = knex({ client: 'mysql2' }),
      queries: Array<{ sql: string; bindings: unknown[] }> = []
    const row = (exactText: string, revisionText: string, present: number | boolean) => ({
      tableId: 12,
      ...(stream === 'scope' ? { userId: '41' } : {}),
      id1: '987',
      id2: '12',
      exactBytes: Buffer.from(exactText),
      revisionText,
      present,
      ...(stream === 'physical' ? { generationText: '30' } : {})
    })
    let records: Array<Record<string, unknown>> = [row('Z', '49', false), row('é', '51', false), row('😀', '49', true)]
    let generations: Array<Record<string, unknown>> = [{ id: 1, version: 1, complete: 1, epoch }]
    let floor = '50',
      allocated = '9007199254740993',
      deleted = 1
    function response(sql: string): unknown {
      if (sql.includes('from `snapshot_journal_clock`')) return [{ ceiling: '9223372036854775807' }]
      if (sql.includes('from `snapshot_journal_invalid`')) return []
      if (sql.startsWith('SELECT CAST(LAST_INSERT_ID()')) return [{ revision: allocated }]
      if (sql.includes('from `snapshot_journal_generation`')) return generations
      if (sql.includes('from `snapshot_journal_retention`'))
        return [{ id: 1, floor, receiptLimit: 128, receiptLifetimeMs: '60000' }]
      if (sql.includes('FORCE INDEX (`PRIMARY`)')) return records
      if (sql.startsWith('delete from')) return { affectedRows: deleted }
      if (sql.startsWith('insert into')) return { affectedRows: 1, insertId: 1 }
      if (/^(BEGIN|COMMIT|ROLLBACK);?$/.test(sql)) return { affectedRows: 0 }
      throw new Error('Unexpected synthetic MySQL query: ' + sql)
    }
    const connection = {
      query(
        q: { sql: string },
        bindings: unknown[],
        callback: (error: Error | null, rows?: unknown, fields?: unknown[]) => void
      ) {
        queries.push({ sql: q.sql, bindings })
        callback(null, response(q.sql), [])
      }
    }
    jest.spyOn(mysql.client, 'acquireConnection').mockResolvedValue(connection)
    jest.spyOn(mysql.client, 'releaseConnection').mockResolvedValue(undefined)
    const key = { tableId: 12, ...(stream === 'scope' ? { userId: 41 } : {}), id1: 987, id2: 12, exactText: 'A' },
      input = { ...request(stream, 4), after: { epoch, floor: request().floor, stream, key } }
    try {
      expect(await mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).toEqual({
        examined: 3,
        removed: 1,
        complete: true,
        after: { epoch, floor: request().floor, stream, key: { ...key, exactText: '😀' } }
      })
      const deletes = queries.filter(q => q.sql.startsWith('delete from `snapshot_journal_' + stream + '`'))
      expect(deletes).toHaveLength(1)
      expect(deletes[0].bindings).toEqual([0, '49', 12, ...(stream === 'scope' ? [41] : []), 987, 12, Buffer.from('Z')])
      expect(deletes[0].sql).toContain('`revision` = CAST(? AS SIGNED)')
      for (const table of ['clock', 'generation', 'retention'])
        expect(queries.find(q => q.sql.includes('from `snapshot_journal_' + table + '`'))!.sql).toContain(
          'for update nowait'
        )
      const gen = queries.find(q => q.sql.includes('from `snapshot_journal_generation`'))!
      expect(gen.bindings).toEqual([2])
      expect(gen.sql).toContain('substr(`epoch`,1,37)')
      const projection = ['tableId', ...(stream === 'scope' ? ['userId'] : []), 'id1', 'id2', 'present']
      expect(
        queries
          .find(q => q.sql.includes('FORCE INDEX (`PRIMARY`)'))!
          .sql.startsWith('select ' + projection.map(field => '`j`.`' + field + '`').join(', ') + ', substr(')
      ).toBe(true)
      for (const invalid of [
        ' 987',
        '987 ',
        '0987',
        '+987',
        '987.0',
        '9.87e2',
        '0x3db',
        'Infinity',
        '9007199254740992'
      ]) {
        queries.length = 0
        records = [{ ...row('Z', '49', 0), id1: invalid }]
        await expect(mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).rejects.toThrow(
          WERR_INVALID_OPERATION
        )
        expect(queries.some(q => q.sql.startsWith('delete from `snapshot_journal_' + stream + '`'))).toBe(false)
      }
      const refuses = async () => {
        queries.length = 0
        await expect(mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).rejects.toThrow(
          WERR_INVALID_OPERATION
        )
        expect(queries.some(q => q.sql.startsWith('delete from `snapshot_journal_' + stream + '`'))).toBe(false)
      }
      const validGeneration = { id: 1, version: 1, complete: 1, epoch }
      for (const state of [
        [],
        [validGeneration, validGeneration],
        [{ ...validGeneration, id: 2 }],
        [{ ...validGeneration, version: 2 }],
        [{ ...validGeneration, complete: 0 }],
        [{ ...validGeneration, epoch: epoch.slice(0, -1) + '3' }]
      ]) {
        generations = state
        records = [row('Z', '50', 0)]
        await refuses()
      }
      generations = [validGeneration]
      for (const invalidFloor of ['49', '9007199254740994']) {
        floor = invalidFloor
        await refuses()
      }
      floor = '50'
      allocated = '49'
      await refuses()
      allocated = '50'
      records = [{ ...row('Z', '50', 0), ...(stream === 'physical' ? { generationText: '50' } : {}) }]
      expect(await mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).toMatchObject({ removed: 1 })
      allocated = '9007199254740993'
      for (const change of [
        { tableId: '012' },
        { id2: '012' },
        ...(stream === 'scope' ? [{ userId: '041' }] : []),
        { exactBytes: Uint8Array.from([255]) },
        { exactBytes: Buffer.alloc(401, 65) },
        { present: '0' },
        { present: 2 },
        { revisionText: '0' },
        ...(stream === 'physical' ? [{ generationText: '0' }, { generationText: '51' }] : [])
      ]) {
        records = [row('B', '49', 0), { ...row('Z', '50', 0), ...change }]
        await refuses()
      }
      for (const badPage of [
        [row('B', '49', 0), row('B', '49', 0)],
        [row('Z', '49', 0), row('B', '49', 0)],
        [row('A', '49', 0)],
        Array.from({ length: 5 }, (_v, i) => row('B' + i, '49', 0)),
        ...['tableId', ...(stream === 'scope' ? ['userId'] : []), 'id1', 'id2'].map(field => [
          row('B', '49', 0),
          { ...row('Z', '49', 0), [field]: field === 'tableId' ? 11 : 1 }
        ])
      ]) {
        records = badPage
        await refuses()
      }
      records = [row('é'.repeat(200), '50', 0)]
      expect(await mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).toMatchObject({ removed: 1 })
      for (const affected of [0, 2]) {
        deleted = affected
        await expect(mysql.transaction(t => collectSnapshotJournalTombstones(t, input))).rejects.toThrow(
          WERR_INVALID_OPERATION
        )
      }
      deleted = 1
      records = []
      expect(await mysql.transaction(t => collectSnapshotJournalTombstones(t, request(stream)))).toEqual({
        examined: 0,
        removed: 0,
        complete: true
      })
    } finally {
      await mysql.destroy()
    }
  }
)
