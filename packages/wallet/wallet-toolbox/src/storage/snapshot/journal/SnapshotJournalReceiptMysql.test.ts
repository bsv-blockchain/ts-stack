import { knex, type Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  snapshotJournalReceiptDdl,
  snapshotJournalReceiptBinding,
  recordSnapshotJournalReceipt,
  readSnapshotJournalReceipt,
  collectSnapshotJournalReceipts,
  type SnapshotJournalReceiptBinding
} from './SnapshotJournalReceipt'
import { snapshotJournalRevision } from './SnapshotJournalRevision'

const binding: SnapshotJournalReceiptBinding = {
  backend: '11'.repeat(32),
  epoch: '12345678-1234-4234-9234-123456789012',
  source: '22'.repeat(32),
  schema: '33'.repeat(32),
  storageIdentity: 'synthetic-storage',
  identityKey: '02' + '44'.repeat(32),
  userId: 1,
  chain: 'test'
}
const time = 1700000000000
const input = (id: number) => ({
  requestId: id.toString(16).padStart(64, '0'),
  highWater: snapshotJournalRevision('9007199254740993'),
  expiresAt: time + 60000
})
interface Query {
  sql: string
  bindings: Knex.RawBinding[]
  method: string
  response?: unknown
}

function stringifyBigints(rows: Array<Record<string, unknown>>): void {
  for (const row of rows)
    for (const field of ['expiresAt', 'receiptLifetimeMs'])
      if (row[field] !== undefined) row[field] = String(row[field])
}

function overrideBigints(
  rows: Array<Record<string, unknown>>,
  values: Partial<Record<'expiresAt' | 'receiptLifetimeMs', unknown>>
): void {
  for (const row of rows)
    for (const field of ['expiresAt', 'receiptLifetimeMs'] as const)
      if (row[field] !== undefined && Object.hasOwn(values, field)) row[field] = values[field]
}

// Real MySQL query compilation/response processing, backed by SQLite for DML
// and rollback. The independent native fixture proves MySQL isolation/locks.
async function fixture(strings: boolean) {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true }),
    k = knex({ client: 'mysql2' })
  for (const sql of snapshotJournalReceiptDdl(db)) await db.raw(sql)
  await db('snapshot_journal_retention').insert({ id: 1, floor: '0', receiptLimit: 2, receiptLifetimeMs: 2592000000 })
  const queries: Query[] = [],
    state = {
      failLock: false,
      now: time,
      storedBigints: {} as Partial<Record<'expiresAt' | 'receiptLifetimeMs', unknown>>
    }
  const connection = {
    __knexUid: 'receipt-driver',
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
    const respond = (rows: unknown) => {
      q.response = [rows, []]
      return q
    }
    if (state.failLock && /(?:for update|FOR SHARE) NOWAIT$/i.test(q.sql))
      throw Object.assign(new Error('owned fixture lock busy'), { code: 'ER_LOCK_NOWAIT' })
    if (q.sql === 'SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now')
      return respond([{ now: strings ? String(state.now) : state.now }])
    const sql = q.sql.replace(/ (?:for (?:share|update)(?: nowait)?|lock in share mode)$/i, '')
    const result = await db.raw(sql, q.bindings)
    if (Array.isArray(result)) {
      if (strings) stringifyBigints(result)
      overrideBigints(result, state.storedBigints)
      return respond(result)
    }
    return respond({ affectedRows: result?.changes ?? 0, insertId: result?.lastInsertRowid ?? 0 })
  }
  return {
    db,
    k,
    queries,
    state,
    close: async () => {
      await k.destroy()
      await db.destroy()
    }
  }
}

test.each([false, true])(
  'MySQL receipt operations preserve exact values and retry/rollback semantics (string BIGINT: %s)',
  async strings => {
    const f = await fixture(strings)
    try {
      const a = input(1),
        b = input(2),
        expected = { ...a, binding: snapshotJournalReceiptBinding(binding), floor: '0' }
      expect(await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))).toEqual(expected)
      expect(await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))).toEqual(expected)
      expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).toEqual(expected)
      await expect(
        f.k.transaction(async t => {
          await recordSnapshotJournalReceipt(t, binding, b)
          throw Error('rollback')
        })
      ).rejects.toThrow('rollback')
      expect(await f.db('snapshot_journal_receipts')).toHaveLength(1)
      await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, { ...binding, userId: 2 }, a))).rejects.toThrow()
      await f.db('snapshot_journal_retention').update({ floor: '9007199254740994' })
      await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).rejects.toThrow()
      expect(f.queries.some(q => /snapshot_journal_retention` limit \? for update nowait$/i.test(q.sql))).toBe(true)
      const receiptReads = f.queries.filter(
        q => q.sql.startsWith('select ') && q.sql.includes('snapshot_journal_receipts')
      )
      expect(receiptReads.length).toBeGreaterThan(0)
      expect(receiptReads.every(q => /FOR (?:SHARE|UPDATE) NOWAIT$/i.test(q.sql))).toBe(true)
      expect(receiptReads.every(q => !q.sql.includes('select *'))).toBe(true)
    } finally {
      await f.close()
    }
  }
)

test('MySQL expired capacity remains charged until collection commits', async () => {
  const f = await fixture(true)
  try {
    const a = input(1),
      b = input(2),
      c = input(3)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, b))
    await f.db('snapshot_journal_receipts').where('requestId', a.requestId).update({ expiresAt: 1 })
    await expect(f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))).rejects.toThrow()
    await expect(
      f.k.transaction(async t => {
        expect(await collectSnapshotJournalReceipts(t)).toBe(1)
        throw Error('collection rollback')
      })
    ).rejects.toThrow('collection rollback')
    await expect(f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))).rejects.toThrow()
    expect(await f.k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(1)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))
    expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, binding, b))).toMatchObject(b)
    const capacityQueries = f.queries.filter(q => q.sql.startsWith('select 1 as `occupied`'))
    expect(capacityQueries.length).toBeGreaterThan(0)
    expect(capacityQueries.every(q => /order by `requestId` asc limit \? for update nowait$/i.test(q.sql))).toBe(true)
    expect(capacityQueries.every(q => q.bindings.at(-1) === 3)).toBe(true)
    expect(
      f.queries.some(
        q =>
          q.sql.includes('order by `expiresAt` asc, `requestId` asc limit ? for update nowait') &&
          q.bindings.at(-1) === 64
      )
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test('MySQL lock refusal propagates and writes no partial receipt', async () => {
  const f = await fixture(false)
  try {
    f.state.failLock = true
    await expect(f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, input(1)))).rejects.toMatchObject({
      code: 'ER_LOCK_NOWAIT'
    })
    await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, input(1)))).rejects.toMatchObject({
      code: 'ER_LOCK_NOWAIT'
    })
    await expect(f.k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toMatchObject({
      code: 'ER_LOCK_NOWAIT'
    })
    expect(await f.db('snapshot_journal_receipts')).toEqual([])
  } finally {
    await f.close()
  }
})

test('bounded stored projections reject oversized identities and revisions', async () => {
  const f = await fixture(true)
  try {
    const a = input(1)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    const stored = await f.db('snapshot_journal_receipts').first()
    for (const change of [
      { binding: 'a'.repeat(100000) },
      { highWater: '1'.repeat(100000) },
      { floor: '1'.repeat(100000) }
    ]) {
      await f.db('snapshot_journal_receipts').update(change)
      await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).rejects.toThrow()
      await f.db('snapshot_journal_receipts').update(stored)
    }
    await f.db('snapshot_journal_receipts').update({ requestId: 'f'.repeat(100000), expiresAt: 1 })
    await expect(f.k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toThrow()
    expect(await f.db('snapshot_journal_receipts')).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('MySQL receipt tables carry the expiry index in the atomic table definition', async () => {
  const k = knex({ client: 'mysql2' })
  try {
    const ddl = snapshotJournalReceiptDdl(k)
    expect(ddl).toHaveLength(2)
    expect(ddl[1]).toContain('KEY snapshot_journal_receipts_expiry(expiresAt,requestId)')
    expect(
      ddl.every(sql => sql.endsWith('ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC'))
    ).toBe(true)
  } finally {
    await k.destroy()
  }
})

test('MySQL legacy alias retains current-read receipt and retention semantics', async () => {
  const f = await fixture(true)
  try {
    f.k.client.config.client = 'mysql'
    const a = input(1)
    expect(snapshotJournalReceiptDdl(f.k)).toHaveLength(2)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).toMatchObject(a)
    f.state.now = a.expiresAt
    expect(await f.k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(1)
    expect(await f.db('snapshot_journal_receipts')).toEqual([])
  } finally {
    await f.close()
  }
})

test('MySQL driver BIGINT responses reject noncanonical strings and nonprimitive numeric lookalikes', async () => {
  const f = await fixture(true)
  try {
    const a = input(1)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    for (const field of ['expiresAt', 'receiptLifetimeMs'] as const) {
      const value = field === 'expiresAt' ? a.expiresAt : 2592000000
      const invalid: unknown[] = [
        '0' + value,
        '+' + value,
        ' ' + value,
        value + ' ',
        value / 1000 + 'e3',
        value + '.0',
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        { valueOf: () => value, toString: () => String(value) }
      ]
      for (const response of invalid) {
        f.state.storedBigints = { [field]: response }
        await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).rejects.toThrow(
          WERR_INVALID_OPERATION
        )
        await expect(f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))).rejects.toThrow(
          WERR_INVALID_OPERATION
        )
      }
      f.state.storedBigints = { [field]: String(value) }
      expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).toMatchObject(a)
      f.state.storedBigints = {}
    }
    expect(await f.db('snapshot_journal_receipts')).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('MySQL receipt reads acquire shared nonwaiting locks and preserve the recorded expiry', async () => {
  const f = await fixture(false)
  try {
    const a = input(1)
    await f.k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    f.queries.length = 0
    expect(await f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).toMatchObject(a)
    const retentionReads = f.queries.filter(q => q.sql.includes('from `snapshot_journal_retention`'))
    expect(retentionReads).toHaveLength(1)
    expect(retentionReads[0].sql.endsWith('FOR SHARE NOWAIT')).toBe(true)
    await f.db('snapshot_journal_receipts').update({ expiresAt: a.expiresAt + 1 })
    await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
    await f.db('snapshot_journal_receipts').update({ expiresAt: a.expiresAt })
    f.state.now = a.expiresAt
    await expect(f.k.transaction(t => readSnapshotJournalReceipt(t, binding, a))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
  } finally {
    await f.close()
  }
})
