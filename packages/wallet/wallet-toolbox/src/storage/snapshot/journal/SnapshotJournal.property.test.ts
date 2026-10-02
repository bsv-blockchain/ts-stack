import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision as rev
} from './SnapshotJournalRevision'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  readSnapshotJournalMetadataPage,
  snapshotJournalMetadataQuery,
  type SnapshotJournalInterval,
  type SnapshotJournalPosition
} from './SnapshotJournalPage'
import {
  snapshotJournalSqliteObserverSql,
  SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL
} from './SnapshotJournalSqliteObservers'
import { installSnapshotJournalSqliteClock } from './SnapshotJournalSqliteClock'
import { readGenerationIndexState } from '../../schema/snapshotSqliteIndexState'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import {
  fixture,
  value,
  keyOf,
  replace,
  tables,
  numeric,
  profiles
} from '../../../../test/utils/snapshotSqliteFixtures'
import { installGeneration } from '../../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../../schema/snapshotSqliteIndexBootstrap'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyParameters = {
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
}
fc.configureGlobal(propertyParameters)

describe('SnapshotJournalRevision', () => {
  const boundaries = [
    '0',
    '1',
    '9',
    '10',
    '9007199254740991',
    '9007199254740992',
    '9007199254740993',
    '9223372036854775806',
    '9223372036854775807'
  ]
  test.each(boundaries)('preserves exact canonical revision %s', value => {
    expect(snapshotJournalRevision(value)).toBe(value)
  })

  test.each([
    undefined,
    null,
    true,
    0,
    1,
    1n,
    NaN,
    Infinity,
    [],
    {},
    '',
    '00',
    '01',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '1\n',
    '1.0',
    '1e3',
    '١',
    '９',
    '9223372036854775808',
    '9999999999999999999',
    '10000000000000000000',
    '1'.repeat(10000)
  ])('refuses a noncanonical or out-of-range revision %p', value => {
    expect(() => snapshotJournalRevision(value)).toThrow(WERR_INVALID_OPERATION)
    expect(() => snapshotJournalRevision(value)).toThrow('Invalid snapshot journal revision')
  })

  test('canonical ordering agrees with independent bigint arithmetic through the entire range', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 9223372036854775807n }),
        fc.bigInt({ min: 0n, max: 9223372036854775807n }),
        (a, b) => {
          const left = snapshotJournalRevision(a.toString()),
            right = snapshotJournalRevision(b.toString())
          expect(compareSnapshotJournalRevisions(left, right)).toBe(a === b ? 0 : a < b ? -1 : 1)
          expect(compareSnapshotJournalRevisions(left, left)).toBe(0)
          expect(snapshotJournalRevision(JSON.parse(JSON.stringify(left)))).toBe(left)
        }
      ),
      propertyParameters
    )
  })

  test('SQLite preserves exact decimal positions above 2^53 with typed range predicates', async () => {
    const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await k.raw(
        "CREATE TABLE revisions(revision INTEGER NOT NULL PRIMARY KEY CHECK(typeof(revision)='integer' AND revision>=0))"
      )
      for (const revision of boundaries) await k('revisions').insert({ revision })
      const exact = await k('revisions').select(k.raw('CAST(revision AS TEXT) AS revision')).orderBy('revision')
      // ORDER BY the integer column explicitly; the text alias otherwise changes ordering.
      const sorted = await k('revisions')
        .select(k.raw('CAST(revisions.revision AS TEXT) AS exactRevision'))
        .orderBy('revisions.revision')
      expect(sorted.map(row => snapshotJournalRevision(row.exactRevision))).toEqual(boundaries)
      expect(exact).toHaveLength(boundaries.length)
      const page = await k('revisions')
        .select(k.raw('CAST(revision AS TEXT) AS exactRevision'))
        .whereRaw('revision > CAST(? AS INTEGER)', ['9007199254740992'])
        .orderBy('revision')
        .limit(2)
      expect(page.map(row => snapshotJournalRevision(row.exactRevision))).toEqual([
        '9007199254740993',
        '9223372036854775806'
      ])
      const query = k('revisions')
        .whereRaw('revision > CAST(? AS INTEGER)', ['9007199254740992'])
        .orderBy('revision')
        .limit(2)
        .toSQL()
      const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
      expect(plan.some(row => row.detail.includes('SEARCH revisions USING INTEGER PRIMARY KEY'))).toBe(true)
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
      await expect(
        k('revisions')
          .where('revision', MAX_SNAPSHOT_JOURNAL_REVISION)
          .update({ revision: k.raw('revision+1') })
      ).rejects.toThrow()
      expect(
        (
          await k('revisions')
            .select(k.raw('CAST(revision AS TEXT) AS exactRevision'))
            .whereRaw('revision = CAST(? AS INTEGER)', [MAX_SNAPSHOT_JOURNAL_REVISION])
            .first()
        ).exactRevision
      ).toBe(MAX_SNAPSHOT_JOURNAL_REVISION)
    } finally {
      await k.destroy()
    }
  })
})

describe('SnapshotJournalPage', () => {
  const base = 9007199254740992n
  let interval: SnapshotJournalInterval
  beforeEach(() => {
    interval = {
      stream: 'scope',
      tableId: 12,
      userId: 1,
      floor: rev('0'),
      low: rev(String(base)),
      high: rev(String(base + 10n)),
      limit: 2
    }
  })

  async function database(): Promise<Knex> {
    const k = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await k.raw(
      'CREATE TABLE snapshot_journal_scope(tableId INTEGER,userId INTEGER,id1 INTEGER,id2 INTEGER,exactText TEXT COLLATE BINARY,revision INTEGER,present INTEGER,PRIMARY KEY(tableId,userId,id1,id2,exactText))'
    )
    await k.raw(
      'CREATE INDEX snapshot_journal_scope_page ON snapshot_journal_scope(userId,tableId,revision,id1,id2,exactText)'
    )
    await k.raw(
      'CREATE TABLE snapshot_journal_physical(tableId INTEGER,id1 INTEGER,id2 INTEGER,exactText TEXT COLLATE BINARY,revision INTEGER,generation INTEGER,present INTEGER,PRIMARY KEY(tableId,id1,id2,exactText))'
    )
    await k.raw(
      'CREATE INDEX snapshot_journal_physical_page ON snapshot_journal_physical(tableId,revision,id1,id2,exactText)'
    )
    return k
  }

  const compare = (a: SnapshotJournalPosition, b: SnapshotJournalPosition) =>
    (BigInt(a.revision) < BigInt(b.revision) ? -1 : BigInt(a.revision) > BigInt(b.revision) ? 1 : 0) ||
    a.id1 - b.id1 ||
    a.id2 - b.id2 ||
    Buffer.compare(Buffer.from(a.exactText), Buffer.from(b.exactText))

  test('real SQLite pages preserve 64-bit revisions, byte-exact ties and fixed upper bounds', async () => {
    const k = await database()
    try {
      const rows = ['a', 'A', 'a ', 'a\0b', 'é', '中', '😀'].map((exactText, i) => ({
        tableId: 12,
        userId: 1,
        id1: i < 5 ? 1 : 2,
        id2: 0,
        exactText,
        revision: rev(String(base + BigInt(i < 4 ? 1 : 2))),
        present: i % 2
      }))
      await k('snapshot_journal_scope').insert(rows)
      await k('snapshot_journal_scope').insert({ ...rows[0], userId: 2 })
      await k('snapshot_journal_scope').insert({ ...rows[0], tableId: 3 })
      await k('snapshot_journal_scope').insert({
        ...rows[0],
        id1: 999,
        revision: String(base + 11n)
      })
      const actual = []
      let after: SnapshotJournalPosition | undefined
      for (let pages = 0; pages < 10; pages++) {
        const page = await readSnapshotJournalMetadataPage(k, { ...interval, after })
        expect(page.examined).toBe(page.rows.length)
        expect(page.examined).toBeLessThanOrEqual(2)
        actual.push(...page.rows)
        if (page.complete) break
        expect(page.after).toBeDefined()
        after = page.after
      }
      expect(actual).toEqual(
        rows.sort(compare).map(({ tableId: _table, userId: _user, present, ...row }) => ({
          ...row,
          present: present === 1
        }))
      )
      const query = snapshotJournalMetadataQuery(k, { ...interval, after }).toSQL()
      const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + query.sql, query.bindings)
      expect(plan.some(row => row.detail.includes('SEARCH j USING INDEX snapshot_journal_scope_page'))).toBe(true)
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
    } finally {
      await k.destroy()
    }
  })

  test('physical global pages charge every examined row and preserve exact insertion generations', async () => {
    const k = await database()
    try {
      await k('snapshot_journal_physical').insert(
        Array.from({ length: 5 }, (_, i) => ({
          tableId: 8,
          id1: i + 1,
          id2: 0,
          exactText: '',
          revision: String(base + BigInt(i) + 1n),
          generation: String(base + 1n),
          present: i % 2
        }))
      )
      const page = await readSnapshotJournalMetadataPage(k, {
        ...interval,
        stream: 'physical',
        tableId: 8
      })
      expect(page.examined).toBe(2)
      expect(page.complete).toBe(false)
      expect(page.rows.map(row => row.generation)).toEqual([String(base + 1n), String(base + 1n)])
      expect(page.rows.map(row => row.present)).toEqual([false, true])
      expect(await k('snapshot_journal_scope')).toEqual([])
    } finally {
      await k.destroy()
    }
  })

  test('late SQLite pages seek the complete composite cursor within a large tied revision', async () => {
    const k = await database()
    try {
      for (let first = 1; first <= 10000; first += 200) {
        await k('snapshot_journal_scope').insert(
          Array.from({ length: 200 }, (_, i) => ({
            tableId: 12,
            userId: 1,
            id1: first + i,
            id2: 0,
            exactText: '',
            revision: String(base + 1n),
            present: 1
          }))
        )
      }
      const request = {
        ...interval,
        after: { revision: rev(String(base + 1n)), id1: 9900, id2: 0, exactText: '' }
      }
      expect((await readSnapshotJournalMetadataPage(k, request)).rows.map(row => row.id1)).toEqual([9901, 9902])
      const sql = snapshotJournalMetadataQuery(k, request).toSQL()
      const plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + sql.sql, sql.bindings)
      expect(plan.some(row => row.detail.includes('(revision,id1,id2,exactText)>(?,?,?,?)'))).toBe(true)
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
      const program: Array<{ opcode: string; p4: string | null }> = await k.raw('EXPLAIN ' + sql.sql, sql.bindings)
      expect(program.some(step => ['SeekGE', 'SeekGT'].includes(step.opcode) && step.p4 === '6')).toBe(true)
    } finally {
      await k.destroy()
    }
  })

  test('quiescent intervals issue no journal query, and stale floors refuse before I/O', async () => {
    const k = await database()
    const seen = jest.fn()
    k.on('query', seen)
    try {
      expect(await readSnapshotJournalMetadataPage(k, { ...interval, high: interval.low })).toEqual({
        rows: [],
        examined: 0,
        complete: true
      })
      await expect(readSnapshotJournalMetadataPage(k, { ...interval, floor: interval.high })).rejects.toThrow(
        'Invalid snapshot journal interval or metadata'
      )
      expect(seen).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  })

  test.each([
    { limit: 0 },
    { limit: 257 },
    { limit: 1.5 },
    { limit: NaN },
    { userId: 0 },
    { userId: Number.MAX_SAFE_INTEGER + 1 },
    { tableId: 13 },
    { tableId: -1 },
    { stream: 'physical', tableId: 12 },
    { stream: 'unknown' },
    { high: '0' },
    { low: '01' },
    { high: '9223372036854775808' },
    { after: { revision: String(base), id1: 1, id2: 0, exactText: '' } },
    { after: { revision: String(base + 11n), id1: 1, id2: 0, exactText: '' } },
    { after: { revision: String(base + 10n), id1: 0, id2: 0, exactText: '' } },
    { after: { revision: String(base + 10n), id1: 1, id2: -1, exactText: '' } },
    { after: { revision: String(base + 10n), id1: 1, id2: 0, exactText: '😀'.repeat(101) } },
    { after: { revision: String(base + 10n), id1: 1, id2: 0, exactText: '\ud800' } }
  ])('malformed request refuses before SQL: %p', async change => {
    const k = await database()
    const seen = jest.fn()
    k.on('query', seen)
    try {
      await expect(
        readSnapshotJournalMetadataPage(k, { ...interval, ...change } as SnapshotJournalInterval)
      ).rejects.toThrow()
      expect(seen).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  })

  test.each([
    { present: 2 },
    { present: 'true' },
    { id1: 0 },
    { id2: -1 },
    { exactText: '😀'.repeat(101) },
    { exactText: Buffer.from([0xff]) },
    { generation: '0' },
    { generation: String(base + 2n) }
  ])('invalid native metadata is never emitted: %p', async change => {
    const k = await database()
    try {
      await k('snapshot_journal_physical').insert({
        tableId: 8,
        id1: 1,
        id2: 0,
        exactText: '',
        revision: String(base + 1n),
        generation: String(base + 1n),
        present: 1,
        ...change
      })
      await expect(
        readSnapshotJournalMetadataPage(k, { ...interval, stream: 'physical', tableId: 8 })
      ).rejects.toThrow()
    } finally {
      await k.destroy()
    }
  })

  test('generated bounded pages equal an independent exact integer and byte-order oracle', async () => {
    const k = await database()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.record({
              userId: fc.integer({ min: 1, max: 2 }),
              tableId: fc.constantFrom(3, 12),
              id1: fc.integer({ min: 1, max: 8 }),
              id2: fc.integer({ min: 0, max: 3 }),
              exactText: fc.constantFrom('', 'a', 'A', 'a ', 'é', '😀', 'a\0b'),
              offset: fc.integer({ min: 0, max: 11 }),
              present: fc.boolean()
            }),
            {
              maxLength: 40,
              selector: row => JSON.stringify([row.userId, row.tableId, row.id1, row.id2, row.exactText])
            }
          ),
          fc.integer({ min: 1, max: 6 }),
          async (records, limit) => {
            await k('snapshot_journal_scope').delete()
            const rows = records.map(({ offset, present, ...row }) => ({
              ...row,
              revision: rev(String(base + BigInt(offset))),
              present: Number(present)
            }))
            if (rows.length) await k('snapshot_journal_scope').insert(rows)
            const actual = []
            let after: SnapshotJournalPosition | undefined
            for (let pageIndex = 0; pageIndex <= rows.length; pageIndex++) {
              const page = await readSnapshotJournalMetadataPage(k, { ...interval, limit, after })
              expect(page.examined).toBeLessThanOrEqual(limit)
              actual.push(...page.rows)
              if (page.complete) break
              after = page.after
            }
            expect(actual).toEqual(
              rows
                .filter(
                  row =>
                    row.tableId === 12 &&
                    row.userId === 1 &&
                    BigInt(row.revision) > base &&
                    BigInt(row.revision) <= base + 10n
                )
                .sort(compare)
                .map(({ tableId: _table, userId: _user, present, ...row }) => ({
                  ...row,
                  present: present === 1
                }))
            )
          }
        ),
        propertyParameters
      )
    } finally {
      await k.destroy()
    }
  })

  test.each(['oversized response', 'at lower bound', 'above upper bound', 'out of order', 'null text'])(
    'driver response integrity rejects %s before returning a page',
    async kind => {
      const k = await database()
      const original = k.client.processResponse.bind(k.client)
      const row = { revisionText: String(base + 1n), id1: 1, id2: 0, exactText: '', present: 1 }
      const rows: Array<Record<string, unknown>> = [row]
      if (kind === 'oversized response') rows.push({ ...row, id1: 2 }, { ...row, id1: 3 })
      if (kind === 'at lower bound') row.revisionText = interval.low
      if (kind === 'above upper bound') row.revisionText = String(base + 11n)
      if (kind === 'out of order') rows.push({ ...row })
      if (kind === 'null text') rows[0] = { ...row, exactText: null }
      const spy = jest.spyOn(k.client, 'processResponse').mockImplementation((...args: unknown[]) => {
        const query = args[0] as { sql: string }
        return query.sql.includes('AS `j` INDEXED BY') ? rows : original(...args)
      })
      try {
        await expect(readSnapshotJournalMetadataPage(k, interval)).rejects.toThrow(
          'Invalid snapshot journal interval or metadata'
        )
        expect(spy).toHaveBeenCalled()
      } finally {
        spy.mockRestore()
        await k.destroy()
      }
    }
  )
  test('cursor text must be a string before any SQL is issued', async () => {
    const k = await database(),
      seen = jest.fn()
    k.on('query', seen)
    try {
      await expect(
        readSnapshotJournalMetadataPage(k, {
          ...interval,
          after: { revision: interval.high, id1: 1, id2: 0, exactText: Buffer.from('a') }
        } as unknown as SnapshotJournalInterval)
      ).rejects.toThrow('Invalid snapshot journal interval or metadata')
      expect(seen).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  })
  test('page query refuses unsupported drivers before SQL', async () => {
    const k = await database(),
      seen = jest.fn()
    k.client.config.client = 'unsupported'
    k.on('query', seen)
    try {
      await expect(readSnapshotJournalMetadataPage(k, interval)).rejects.toThrow(
        'Unsupported snapshot journal SQL driver'
      )
      expect(seen).not.toHaveBeenCalled()
    } finally {
      await k.destroy()
    }
  })
})

describe('SnapshotJournalSqliteObservers', () => {
  // Internal journal qualification; reader advertisement remains a separate gate.

  const q = (name: string) => '"' + name.replaceAll('"', '""') + '"'
  const scopeKey = 'tableId,userId,id1,id2,exactText'
  const physicalKey = 'tableId,id1,id2,exactText'
  const tuple = (table: string, prefix: string) => {
    const key = numeric.find(([name]) => name === table)?.[1]
    if (key) return [prefix + '.' + q(key), '0', "''"]
    if (table === 'tx_labels_map') return [prefix + '.txLabelId', prefix + '.transactionId', "''"]
    if (table === 'output_tags_map') return [prefix + '.outputTagId', prefix + '.outputId', "''"]
    return [prefix + '.certificateId', '0', prefix + '.fieldName']
  }
  async function installCandidate(k: Knex, reverse: boolean) {
    const definitions = await snapshotJournalSqliteObserverSql(k)
    await installSnapshotJournalSqliteClock(k, snapshotJournalRevision('1000000000'))
    for (const ddl of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await k.raw(ddl)
    const prior: Array<{ name: string; sql: string }> = await k('sqlite_master')
      .where('type', 'trigger')
      .whereIn('tbl_name', tables)
      .select('name', 'sql')
    for (const definition of definitions) await k.raw(definition)
    if (reverse)
      for (const trigger of prior) {
        await k.raw('DROP TRIGGER ??', [trigger.name])
        await k.raw(trigger.sql)
      }
  }
  async function expected(k: Knex) {
    const selections = profiles.map(
      ([table, key], id) => `SELECT ${id} tableId,userId,${q(key)} id1,0 id2,'' exactText FROM ${q(table)}`
    )
    for (const [id, table, left, leftKey, right, rightKey] of [
      [10, 'tx_labels_map', 'tx_labels', 'txLabelId', 'transactions', 'transactionId'],
      [11, 'output_tags_map', 'output_tags', 'outputTagId', 'outputs', 'outputId']
    ])
      for (const [parent, key] of [
        [left, leftKey],
        [right, rightKey]
      ])
        selections.push(
          `SELECT ${id},p.userId,m.${leftKey},m.${rightKey},'' FROM ${table} m JOIN ${parent} p ON m.${key}=p.${key}`
        )
    selections.push(
      'SELECT 12,userId,certificateId,0,fieldName FROM certificate_fields',
      'SELECT 12,c.userId,f.certificateId,0,f.fieldName FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId',
      "SELECT 9,t.userId,r.provenTxReqId,0,'' FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid",
      "SELECT 8,t.userId,p.provenTxId,0,'' FROM transactions t JOIN proven_txs p ON p.provenTxId=t.provenTxId",
      "SELECT 8,t.userId,p.provenTxId,0,'' FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid JOIN proven_txs p ON p.provenTxId=r.provenTxId"
    )
    return await k.raw(
      'SELECT * FROM (' + selections.join(' UNION ') + ') ORDER BY tableId,userId,id1,id2,exactText COLLATE BINARY'
    )
  }
  async function exact(k: Knex) {
    expect(
      await k('snapshot_journal_scope').where('present', 1).select(scopeKey.split(',')).orderBy(scopeKey.split(','))
    ).toEqual(await expected(k))
    for (const [tableId, table] of tables.entries()) {
      const keys = tuple(table, 's')
      const rows = await k.raw(
        `SELECT s.*,g.generation AS candidateGeneration,g.present AS candidatePresent FROM ${q(table)} s LEFT JOIN snapshot_journal_physical g ON g.tableId=${tableId} AND g.id1=${keys[0]} AND g.id2=${keys[1]} AND g.exactText COLLATE BINARY=${keys[2]} COLLATE BINARY`
      )
      for (const row of rows) {
        expect(row.candidatePresent).toBe(1)
        expect(row.candidateGeneration).toBeGreaterThan(0)
      }
    }
  }

  test.each(
    ['BINARY', 'NOCASE', 'RTRIM'].flatMap(collation =>
      [false, true].flatMap(reverse => [false, true].map(recursive => ({ collation, reverse, recursive })))
    )
  )(
    'all thirteen source/scope observers, collation=$collation order=$reverse recursion=$recursive',
    async ({ collation, reverse, recursive }) => {
      const k = await fixture(collation, recursive, false)
      try {
        for (const table of tables)
          await k.schema.alterTable(table, t => {
            void t.text('payload')
            void t.text('quoted"payload')
            void t.integer('updated_at').notNullable().defaultTo(0)
          })
        const plan = await installGeneration(k)
        for (let n = 0; n < 100; n++) if ((await copyGenerationPage(k, plan)).complete) break
        await installCandidate(k, reverse)
        for (const table of tables)
          for (const id of [1, 2])
            await k(table).insert({
              ...value(table, id, id, id),
              payload: 'original'
            })
        await exact(k)
        const before = await k('snapshot_journal_physical').orderBy(physicalKey.split(','))
        const scopeBefore = await k('snapshot_journal_scope').orderBy(scopeKey.split(','))
        for (const table of tables) await k(table).update({ payload: 'same-timestamp update' })
        await exact(k)
        const after = await k('snapshot_journal_physical').orderBy(physicalKey.split(','))
        expect(after.map(r => r.generation)).toEqual(before.map(r => r.generation))
        after.forEach((r, i) => expect(r.revision).toBeGreaterThan(before[i].revision))
        const scopeAfter = await k('snapshot_journal_scope').orderBy(scopeKey.split(','))
        expect(scopeAfter).toHaveLength(scopeBefore.length)
        scopeAfter.forEach((row, i) => {
          if (row.tableId !== 8 && row.tableId !== 9) expect(row.revision).toBeGreaterThan(scopeBefore[i].revision)
        })
        for (const table of tables) await k(table).update({ payload: 'same-timestamp update' })
        expect(await k('snapshot_journal_physical').orderBy(physicalKey.split(','))).toEqual(after)
        await k.raw(
          'CREATE TRIGGER candidate_nested_owner AFTER INSERT ON transactions WHEN NEW.userId=2 BEGIN UPDATE transactions SET userId=3 WHERE transactionId=NEW.transactionId; END'
        )
        await replace(k, 'transactions', value('transactions', 1, 2, 2))
        await exact(k)
        await k.raw(
          "CREATE TRIGGER candidate_nested_reinsert AFTER UPDATE ON outputs WHEN NEW.payload='replace-inside' BEGIN DELETE FROM outputs WHERE outputId=NEW.outputId; INSERT INTO outputs(outputId,userId,transactionId,vout,payload,updated_at) VALUES(NEW.outputId,NEW.userId,NEW.transactionId,NEW.vout,'nested-new',NEW.updated_at); END"
        )
        const oldGeneration = (
          await k('snapshot_journal_physical').where({ tableId: 1, id1: 1, id2: 0, exactText: '' }).first()
        ).generation
        await k('outputs').where('outputId', 1).update({ payload: 'replace-inside' })
        await exact(k)
        expect(
          (await k('snapshot_journal_physical').where({ tableId: 1, id1: 1, id2: 0, exactText: '' }).first()).generation
        ).toBeGreaterThan(oldGeneration)
        const field = await k('certificate_fields').where('certificateId', 1).first()
        const renamed = collation === 'RTRIM' ? field.fieldName + ' ' : field.fieldName.toUpperCase()
        await k('certificate_fields')
          .where({ certificateId: 1, fieldName: field.fieldName })
          .update({ fieldName: renamed })
        await exact(k)
        expect(
          await k('snapshot_journal_scope').where({
            tableId: 12,
            id1: 1,
            exactText: field.fieldName,
            present: 1
          })
        ).toEqual([])
        const originalLabel = await k('tx_labels').where('txLabelId', 1).first()
        const labelGeneration = (
          await k('snapshot_journal_physical').where({ tableId: 3, id1: 1, id2: 0, exactText: '' }).first()
        ).generation
        await k('tx_labels').where('txLabelId', 1).update({ userId: 4 })
        await exact(k)
        expect(
          (await k('snapshot_journal_physical').where({ tableId: 3, id1: 1, id2: 0, exactText: '' }).first()).generation
        ).toBe(labelGeneration)
        expect(
          (
            await k('snapshot_journal_scope')
              .where({
                tableId: 3,
                userId: originalLabel.userId,
                id1: 1,
                id2: 0,
                exactText: ''
              })
              .first()
          ).present
        ).toBe(0)
        await k('tx_labels').where('txLabelId', 1).delete()
        await exact(k)
        await k('tx_labels').insert(originalLabel)
        await exact(k)
        expect(
          (await k('snapshot_journal_physical').where({ tableId: 3, id1: 1, id2: 0, exactText: '' }).first()).generation
        ).toBeGreaterThan(labelGeneration)
        const globalScopes = await k('snapshot_journal_scope').where('tableId', 8).orderBy(scopeKey.split(','))
        const proofBefore = await k('snapshot_journal_physical')
          .where({ tableId: 8, id1: 1, id2: 0, exactText: '' })
          .first()
        await k('proven_txs').where('provenTxId', 1).update({ payload: 'new global payload with equal timestamp' })
        const proofAfter = await k('snapshot_journal_physical')
          .where({ tableId: 8, id1: 1, id2: 0, exactText: '' })
          .first()
        expect(proofAfter.generation).toBe(proofBefore.generation)
        expect(proofAfter.revision).toBeGreaterThan(proofBefore.revision)
        expect(await k('snapshot_journal_scope').where('tableId', 8).orderBy(scopeKey.split(','))).toEqual(globalScopes)
        await exact(k)
        await fc.assert(
          fc.asyncProperty(
            fc.array(
              fc.record({
                table: fc.integer({ min: 0, max: 12 }),
                kind: fc.integer({ min: 0, max: 3 }),
                id: fc.integer({ min: 1, max: 5 }),
                other: fc.integer({ min: 1, max: 5 }),
                user: fc.integer({ min: 1, max: 3 })
              }),
              { minLength: 1, maxLength: 10 }
            ),
            async ops => {
              for (const op of ops) {
                const table = tables[op.table]
                if (op.kind === 0) await replace(k, table, value(table, op.id, op.other, op.user))
                else if (op.kind === 1)
                  await k(table)
                    .where(keyOf(table, op.id, op.other))
                    .delete()
                else {
                  const query = k(table)
                    .where(keyOf(table, op.id, op.other))
                    .update(value(table, op.other, op.id, op.user))
                    .toSQL()
                  await k.raw(
                    query.sql.replace(/^update/i, op.kind === 2 ? 'UPDATE OR REPLACE' : 'UPDATE OR IGNORE'),
                    query.bindings
                  )
                }
                await exact(k)
              }
            }
          ),
          propertyParameters
        )
      } finally {
        await k.destroy()
      }
    },
    60000
  )

  test.each([false, true].flatMap(reverse => [false, true].map(recursive => ({ reverse, recursive }))))(
    'actual migrated schema and independent WAL view, order=$reverse recursion=$recursive',
    async ({ reverse, recursive }) => {
      const directory = await mkdtemp(join(tmpdir(), 'ts569-journal-actual-'))
      const filename = join(directory, 'wallet.sqlite')
      const k = knex({
        client: 'better-sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
      const reader = knex({
        client: 'better-sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
      const source = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions('test'),
        knex: k
      })
      let view: Knex.Transaction | undefined
      try {
        await k.raw('PRAGMA journal_mode=WAL')
        await source.migrate('candidate journal fixture', 'synthetic-candidate-journal')
        await source.makeAvailable()
        await k.raw('PRAGMA recursive_triggers=' + Number(recursive))
        const users = []
        for (const identity of ['02' + '11'.repeat(32), '03' + '22'.repeat(32)])
          users.push((await source.findOrInsertUser(identity)).user.userId)
        await installCandidate(k, reverse)
        expect(await readGenerationIndexState(k)).toBe('v2')
        await seedArchiveClosure(source, users[0], users[1])
        await exact(k)
        const physicalBefore = await k('snapshot_journal_physical').orderBy(physicalKey.split(','))
        const scopeBefore = await k('snapshot_journal_scope').orderBy(scopeKey.split(','))
        const highBefore = (await k('snapshot_journal_clock').first()).revision
        view = await reader.transaction()
        expect((await view('snapshot_journal_clock').first()).revision).toBe(highBefore)
        for (const table of tables) {
          const timestamps = await k(table).select('updated_at')
          await k(table).update({ created_at: '2026-01-01T00:00:00.001Z' })
          expect(await k(table).select('updated_at')).toEqual(timestamps)
        }
        await exact(k)
        expect(await view('snapshot_journal_physical').orderBy(physicalKey.split(','))).toEqual(physicalBefore)
        expect(await view('snapshot_journal_scope').orderBy(scopeKey.split(','))).toEqual(scopeBefore)
        const physicalAfter = await k('snapshot_journal_physical').orderBy(physicalKey.split(','))
        expect(physicalAfter.map(r => r.generation)).toEqual(physicalBefore.map(r => r.generation))
        expect(
          new Set((await k('snapshot_journal_physical').where('revision', '>', highBefore)).map(r => r.tableId))
        ).toEqual(new Set(tables.map((_, id) => id)))
        await view.rollback()
        view = undefined
        const beforeRollback = await k('snapshot_journal_physical').orderBy(physicalKey.split(','))
        const rollbackHigh = (await k('snapshot_journal_clock').first()).revision
        await k.transaction(async trx => {
          await trx('tx_labels').where('txLabelId', 1).update({ label: 'rolled-back label' })
          await trx.rollback()
        })
        expect(await k('snapshot_journal_physical').orderBy(physicalKey.split(','))).toEqual(beforeRollback)
        expect((await k('snapshot_journal_clock').first()).revision).toBe(rollbackHigh)
        for (const [tableId, table] of tables.entries()) {
          const original = await k(table).first()
          const key = numeric[tableId]?.[1]
          const identity = {
            tableId,
            id1: key
              ? original[key]
              : table === 'certificate_fields'
                ? original.certificateId
                : table === 'tx_labels_map'
                  ? original.txLabelId
                  : original.outputTagId,
            id2:
              table === 'tx_labels_map' ? original.transactionId : table === 'output_tags_map' ? original.outputId : 0,
            exactText: table === 'certificate_fields' ? original.fieldName : ''
          }
          const before = await k('snapshot_journal_physical').where(identity).first()
          await replace(k, table, original)
          await exact(k)
          const after = await k('snapshot_journal_physical').where(identity).first()
          expect(after.generation).toBeGreaterThan(before.generation)
        }
        expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
      } finally {
        if (view) await view.rollback()
        await reader.destroy()
        await source.destroy()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60000
  )

  async function journalFixture(): Promise<Knex> {
    const k = await fixture('BINARY', false, false)
    const plan = await installGeneration(k)
    for (let n = 0; n < 100; n++) if ((await copyGenerationPage(k, plan)).complete) break
    await installCandidate(k, false)
    return k
  }

  test.each(tables)(
    'changing a %s key preserves the old tombstone and starts a new physical generation',
    async table => {
      const k = await journalFixture()
      try {
        const tableId = tables.indexOf(table)
        await k(table).insert(value(table, 1, 1, 1))
        const before = await k('snapshot_journal_physical').where('tableId', tableId).first()
        const original = keyOf(table, 1, 1)
        const changed = keyOf(table, 2, 2)
        await k(table).where(original).update(changed)
        expect(await k(table).where(original)).toEqual([])
        expect(await k(table).where(changed)).toHaveLength(1)
        const old = await k('snapshot_journal_physical')
          .where({
            tableId,
            id1: before.id1,
            id2: before.id2,
            exactText: before.exactText
          })
          .first()
        expect(old.present).toBe(0)
        expect(old.generation).toBe(before.generation)
        expect(old.revision).toBeGreaterThan(before.revision)
        const current = await k('snapshot_journal_physical').where({ tableId, present: 1 }).first()
        expect(current).toBeDefined()
        expect(current.generation).toBeGreaterThan(before.generation)
        expect(current.revision).toBe(current.generation)
      } finally {
        await k.destroy()
      }
    }
  )

  test.each(['sqlite3', 'better-sqlite3'])('SQLite observer alias %s prepares every table', async client => {
    const k = await journalFixture()
    k.client.config.client = client
    try {
      const definitions = await snapshotJournalSqliteObserverSql(k)
      expect(definitions).toHaveLength(51)
    } finally {
      await k.destroy()
    }
  })

  test('SQLite observer preparation refuses a foreign driver before querying its schema', async () => {
    const raw = jest.fn(),
      k = { client: { config: { client: 'mysql2' } }, raw } as unknown as Knex
    await expect(snapshotJournalSqliteObserverSql(k)).rejects.toThrow('Snapshot journal observers require SQLite')
    expect(raw).not.toHaveBeenCalled()
  })

  test('all thirteen observers preserve exact revision and generation values above 2^53', async () => {
    const k = await journalFixture()
    try {
      await k('snapshot_journal_clock').update({
        ceiling: '9223372036854775807',
        revision: '9007199254740992'
      })
      for (const table of tables) await k(table).insert(value(table, 1, 1, 1))
      const rows = await k('snapshot_journal_physical')
        .select('tableId', k.raw('CAST(revision AS TEXT) revision'), k.raw('CAST(generation AS TEXT) generation'))
        .orderBy('tableId')
      expect(rows.map(row => row.tableId)).toEqual(Array.from({ length: 13 }, (_, i) => i))
      for (const row of rows) {
        expect(typeof row.revision).toBe('string')
        expect(BigInt(row.revision)).toBeGreaterThan(9007199254740992n)
        expect(row.generation).toBe(row.revision)
      }
      expect(await k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 1,
        reason: null
      })
    } finally {
      await k.destroy()
    }
  })

  test.each(['capacity', 'signed63'])('%s exhaustion preserves all thirteen standard source writes', async kind => {
    const k = await journalFixture()
    try {
      await k('snapshot_journal_clock').update(
        kind === 'capacity' ? { ceiling: 1 } : { ceiling: '9223372036854775807', revision: '9223372036854775806' }
      )
      for (const table of tables) await k(table).insert(value(table, 1, 1, 1))
      for (const table of tables) expect(await k(table).count('* AS n').first()).toEqual({ n: 1 })
      expect(await k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 0,
        reason: kind === 'capacity' ? 'capacity-exhausted' : 'revision-exhausted'
      })
      const before = await k('snapshot_journal_physical').select('tableId', 'id1', 'id2', 'exactText')
      await k('tx_labels').insert(value('tx_labels', 2, 2, 2))
      expect(await k('snapshot_journal_physical').select('tableId', 'id1', 'id2', 'exactText')).toEqual(before)
    } finally {
      await k.destroy()
    }
  })

  test('400-byte field keys remain exact and 401 bytes invalidate without losing source data', async () => {
    const k = await journalFixture()
    try {
      const accepted = '😀'.repeat(100),
        oversized = accepted + 'x'
      await k('certificates').insert(value('certificates', 1, 1, 1))
      await k('certificate_fields').insert({
        ...value('certificate_fields', 1, 1, 1),
        fieldName: accepted
      })
      expect(await k('snapshot_journal_clock').first('enabled')).toEqual({
        enabled: 1
      })
      expect((await k('snapshot_journal_scope').where({ tableId: 12, userId: 1 }).first()).exactText).toBe(accepted)
      await k('certificate_fields').insert({
        ...value('certificate_fields', 1, 1, 1),
        fieldName: oversized
      })
      expect(await k('certificate_fields').pluck('fieldName')).toEqual([accepted, oversized])
      expect(await k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 0,
        reason: 'key-out-of-range'
      })
      expect(await k('snapshot_journal_physical').where('exactText', oversized)).toEqual([])
    } finally {
      await k.destroy()
    }
  })

  test('an out-of-range numeric key invalidates atomically and rollback restores every observer', async () => {
    const k = await journalFixture()
    try {
      const before = await k('snapshot_journal_clock').first()
      await expect(
        k.transaction(async t => {
          await t.raw("INSERT INTO tx_labels(txLabelId,userId,label) VALUES(9007199254740992,1,'beyond exact wire ID')")
          expect(await t('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
            enabled: 0,
            reason: 'key-out-of-range'
          })
          throw new Error('rollback invalidation')
        })
      ).rejects.toThrow('rollback invalidation')
      expect(await k('snapshot_journal_clock').first()).toEqual(before)
      expect(await k('snapshot_journal_scope')).toEqual([])
      expect(await k('snapshot_journal_physical')).toEqual([])
      expect(await k('tx_labels')).toEqual([])
      await k.raw(
        "INSERT INTO tx_labels(txLabelId,userId,label) VALUES(9007199254740992,1,'committed beyond exact wire ID')"
      )
      expect(await k('tx_labels').count('* AS n').first()).toEqual({ n: 1 })
      expect(await k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
        enabled: 0,
        reason: 'key-out-of-range'
      })
    } finally {
      await k.destroy()
    }
  })
})
