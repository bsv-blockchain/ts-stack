import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  readSnapshotJournalSourceGenerations,
  snapshotJournalSourceIndexes,
  type SnapshotJournalSourceIndexes,
  type SnapshotJournalSourceReference
} from './SnapshotJournalSourceGenerations'
import { mysqlReadSnapshotFixture } from '../../../../test/utils/mysqlReadSnapshotFixture'

jest.setTimeout(30000)

let db: Knex
let directory: string
const high = snapshotJournalRevision('9223372036854775807')
const definitions = [
  [0, 'transactions', 'transactionId'],
  [1, 'outputs', 'outputId'],
  [2, 'certificates', 'certificateId'],
  [3, 'tx_labels', 'txLabelId'],
  [4, 'output_baskets', 'basketId'],
  [5, 'output_tags', 'outputTagId'],
  [6, 'commissions', 'commissionId'],
  [8, 'proven_txs', 'provenTxId'],
  [9, 'proven_tx_reqs', 'provenTxReqId']
] as const
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-source-generations-'))
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw(
    'CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE TABLE snapshot_profile_keys_v2(snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotRowId INTEGER NOT NULL,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotRowId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_global_keys_v2(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,rowId INTEGER NOT NULL,refs INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,userId,rowId))'
  )
  for (const [, name, key] of definitions)
    await db.raw('CREATE TABLE ??(?? INTEGER PRIMARY KEY,userId INTEGER NOT NULL)', [name, key])
})
afterEach(async () => {
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
  jest.restoreAllMocks()
})
async function live(
  k: Knex,
  tableId: SnapshotJournalSourceReference['tableId'],
  incomingId: number,
  generation = '2',
  revision = '9',
  userId = 1
): Promise<void> {
  const [, name, key] = definitions.find(row => row[0] === tableId)!
  await k(name).insert({ [key]: incomingId, userId })
  await k('snapshot_journal_physical').insert({
    tableId,
    id1: incomingId,
    id2: 0,
    exactText: '',
    generation,
    revision,
    present: 1
  })
  if (tableId < 7)
    await k('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: userId,
      snapshotRowId: incomingId
    })
  else
    await k('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId,
      rowId: incomingId,
      refs: 1,
      present: 1
    })
}
async function read(references: SnapshotJournalSourceReference[], profile = 1, ceiling = high) {
  return await db.transaction(
    async trx => await readSnapshotJournalSourceGenerations(trx, profile, ceiling, references)
  )
}

test('resolves all nine independent numeric entity types in the selected profile', async () => {
  const references: SnapshotJournalSourceReference[] = []
  for (const [tableId] of definitions) {
    await live(db, tableId, 10)
    references.push({ tableId, incomingId: 10 })
  }
  const actual = await read(references)
  expect([...actual]).toEqual(references.map(row => [row.tableId + ':10', { generation: '2', revision: '9' }]))
})
test('retains an unchanged parent generation older than the new delta window', async () => {
  await live(db, 4, 10, '2', '7')
  expect((await read([{ tableId: 4, incomingId: 10 }], 1, snapshotJournalRevision('100'))).get('4:10')).toEqual({
    generation: '2',
    revision: '7'
  })
})
test('preserves exact generation and revision values above JavaScript safe integer range', async () => {
  await live(db, 4, 10, '9007199254740993', '9223372036854775807')
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')).toEqual({
    generation: '9007199254740993',
    revision: '9223372036854775807'
  })
})
test('a live physical row in another profile cannot resolve as a parent', async () => {
  await live(db, 4, 10, '2', '9', 2)
  await expect(read([{ tableId: 4, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('a shared global object requires current retained membership for this profile', async () => {
  await live(db, 8, 10, '2', '9', 2)
  await expect(read([{ tableId: 8, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
  await db('snapshot_global_keys_v2').insert({
    tableId: 1,
    userId: 1,
    rowId: 10,
    refs: 1,
    present: 1
  })
  expect((await read([{ tableId: 8, incomingId: 10 }])).get('8:10')?.generation).toBe('2')
  await db('snapshot_global_keys_v2').where({ tableId: 1, userId: 1, rowId: 10 }).update({ refs: 0 })
  await expect(read([{ tableId: 8, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('a new source call sees a replacement generation instead of caching the old identity', async () => {
  await live(db, 4, 10)
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('2')
  await db.transaction(async trx => {
    await trx('output_baskets').where({ basketId: 10 }).delete()
    await trx('output_baskets').insert({ basketId: 10, userId: 1 })
    await trx('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ generation: '12', revision: '12' })
  })
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('12')
})
test('a rolled-back replacement retains the original physical identity', async () => {
  await live(db, 4, 10)
  await expect(
    db.transaction(async trx => {
      await trx('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ generation: '12', revision: '12' })
      expect(
        (await readSnapshotJournalSourceGenerations(trx, 1, high, [{ tableId: 4, incomingId: 10 }])).get('4:10')
          ?.generation
      ).toBe('12')
      throw new Error('source replacement rollback')
    })
  ).rejects.toThrow('source replacement rollback')
  expect((await read([{ tableId: 4, incomingId: 10 }])).get('4:10')?.generation).toBe('2')
})
test('deduplicates and detaches the bounded reference set before its first asynchronous boundary', async () => {
  await live(db, 4, 10)
  await db.transaction(async trx => {
    const refs: SnapshotJournalSourceReference[] = [
      { tableId: 4, incomingId: 10 },
      { tableId: 4, incomingId: 10 }
    ]
    const pending = readSnapshotJournalSourceGenerations(trx, 1, high, refs)
    refs[0].incomingId = 11
    refs.length = 0
    expect([...(await pending)]).toEqual([['4:10', { generation: '2', revision: '9' }]])
  })
})
test('refuses absent, withdrawn or post-window physical metadata', async () => {
  await live(db, 4, 10)
  await expect(read([{ tableId: 4, incomingId: 11 }])).rejects.toThrow('Missing or inconsistent')
  await expect(read([{ tableId: 4, incomingId: 10 }], 1, snapshotJournalRevision('8'))).rejects.toThrow()
  await db('snapshot_journal_physical').where({ tableId: 4, id1: 10 }).update({ present: 0 })
  await expect(read([{ tableId: 4, incomingId: 10 }])).rejects.toThrow('Missing or inconsistent')
})
test('bounds references before SQL and refuses provenance/composite table IDs', async () => {
  let queries = 0
  db.on('query', () => queries++)
  await db.transaction(async trx => {
    const initial = queries
    await expect(
      readSnapshotJournalSourceGenerations(
        trx,
        1,
        high,
        Array.from({ length: 257 }, () => ({ tableId: 4 as const, incomingId: 10 }))
      )
    ).rejects.toThrow('Missing or inconsistent')
    await expect(
      readSnapshotJournalSourceGenerations(trx, 1, high, [
        { tableId: 7 as SnapshotJournalSourceReference['tableId'], incomingId: 10 }
      ])
    ).rejects.toThrow('Missing or inconsistent')
    expect(queries).toBe(initial)
  })
})

test('detached index DATA accepts only complete installed states and retains no caller object', () => {
  const input: SnapshotJournalSourceIndexes = { profile: 'v2', relation: true, certificate: 'v2', global: true }
  const actual = snapshotJournalSourceIndexes(db, input)
  expect(actual).toEqual(input)
  expect(actual).not.toBe(input)
  input.profile = false
  expect(actual.profile).toBe('v2')
  for (const field of ['profile', 'relation', 'certificate', 'global'])
    for (const invalid of [false, undefined, null, '', 'v1', 1])
      expect(() =>
        snapshotJournalSourceIndexes(db, {
          profile: 'v2',
          relation: 'v2',
          certificate: 'v2',
          global: 'v2',
          [field]: invalid
        } as SnapshotJournalSourceIndexes)
      ).toThrow('Missing or inconsistent pinned journal source generation')
})

test.each([0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1])(
  'invalid profile or incoming ID %s refuses before source SQL',
  async value => {
    await db.transaction(async trx => {
      const observe = jest.fn()
      db.on('query', observe)
      try {
        await expect(readSnapshotJournalSourceGenerations(trx, value as number, high, [])).rejects.toThrow(
          'Missing or inconsistent pinned journal source generation'
        )
        await expect(
          readSnapshotJournalSourceGenerations(trx, 1, high, [{ tableId: 4, incomingId: value as number }])
        ).rejects.toThrow('Missing or inconsistent pinned journal source generation')
        expect(observe).not.toHaveBeenCalled()
      } finally {
        db.off('query', observe)
      }
    })
  }
)

test('root, unsupported backend, zero high-water and non-array references cannot issue source DATA', async () => {
  const error = 'Missing or inconsistent pinned journal source generation'
  await expect(readSnapshotJournalSourceGenerations(db, 1, high, [])).rejects.toThrow(error)
  await db.transaction(async trx => {
    const original = trx.client.config.client
    try {
      // This remains the real SQLite transaction. A changed/unknown backend
      // label must refuse; it cannot manufacture native producer membership.
      trx.client.config.client = 'unsupported-driver'
      await expect(readSnapshotJournalSourceGenerations(trx, 1, high, [])).rejects.toThrow(error)
    } finally {
      trx.client.config.client = original
    }
    await expect(readSnapshotJournalSourceGenerations(trx, 1, snapshotJournalRevision('0'), [])).rejects.toThrow(error)
    for (const references of [undefined, null, {}, { length: 1 }])
      await expect(
        readSnapshotJournalSourceGenerations(trx, 1, high, references as SnapshotJournalSourceReference[])
      ).rejects.toThrow(error)
  })
})

test('the exact reference ceiling remains admitted and duplicate coordinates share one source query', async () => {
  await live(db, 4, 10)
  const observe = jest.fn()
  db.on('query', observe)
  try {
    await db.transaction(async trx => {
      observe.mockClear()
      const references = Array.from({ length: 256 }, () => ({ tableId: 4 as const, incomingId: 10 }))
      expect([...(await readSnapshotJournalSourceGenerations(trx, 1, high, references))]).toEqual([
        ['4:10', { generation: '2', revision: '9' }]
      ])
      expect(observe).toHaveBeenCalledTimes(1)
    })
  } finally {
    db.off('query', observe)
  }
})

test.each([
  { journalGeneration: '0', journalRevision: '9' },
  { journalGeneration: '10', journalRevision: '9' },
  { journalGeneration: '2', journalRevision: '11' }
])('inconsistent returned identity DATA %j cannot cross the pinned high-water fence', async patch => {
  await live(db, 4, 10)
  const original = db.client.config.postProcessResponse
  db.client.config.postProcessResponse = response =>
    Array.isArray(response) && response[0]?.journalGeneration !== undefined
      ? response.map(row => ({ ...row, ...patch }))
      : response
  try {
    await expect(read([{ tableId: 4, incomingId: 10 }], 1, snapshotJournalRevision('10'))).rejects.toThrow(
      'Missing or inconsistent pinned journal source generation'
    )
  } finally {
    db.client.config.postProcessResponse = original
  }
})

test.each(['mysql2', 'mysql'])(
  'installed MySQL query construction retains exact bounded revision projections for %s',
  async client => {
    // Reuse the installed Knex transaction/query builders and bounded synthetic
    // wire fixture. This is SQL construction/driver DATA evidence; the separate
    // real MySQL container contract remains the server qualification.
    const fixture = mysqlReadSnapshotFixture(undefined, [
      { journalGeneration: '2', journalRevision: '9', journalPresent: true }
    ])
    fixture.db.client.config.client = client
    try {
      expect(snapshotJournalSourceIndexes(fixture.db)).toEqual({
        profile: true,
        relation: true,
        certificate: true,
        global: true
      })
      const actual = await fixture.db.transaction(
        async trx => await readSnapshotJournalSourceGenerations(trx, 1, high, [{ tableId: 4, incomingId: 10 }])
      )
      expect([...actual]).toEqual([['4:10', { generation: '2', revision: '9' }]])
      const selects = fixture.events.filter(sql => sql.startsWith('SELECT'))
      expect(selects).toHaveLength(1)
      for (const field of ['GENERATION', 'REVISION']) {
        expect(selects[0]).toContain(`OCTET_LENGTH(CAST(\`${field}\` AS CHAR)) BETWEEN 1 AND 19`)
        expect(selects[0]).toContain(`\`${field}\` BETWEEN 1 AND CAST(? AS SIGNED)`)
      }
      expect(selects[0]).toContain('CASE WHEN `PRESENT` IN (0,1) THEN `PRESENT` ELSE NULL END AS `JOURNALPRESENT`')
      expect(fixture.events.at(-1)).toBe('RELEASE')
    } finally {
      await fixture.db.destroy()
    }
  }
)
