import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import {
  readSnapshotJournalDeltaPage,
  type SnapshotJournalDelta,
  type SnapshotJournalDeltaPage
} from './SnapshotJournalDeltaPage'
import type { SnapshotJournalInterval, SnapshotJournalPosition } from './SnapshotJournalPage'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.setTimeout(30000)
const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}

// Independent standard-table/key fixture in journal order. It does not import
// the implementation's descriptors, source queries or observer SQL.
const fixtures = [
  ['transactions', 'transactionId', 'transactions'],
  ['outputs', 'outputId', 'outputs'],
  ['certificates', 'certificateId', 'certificates'],
  ['tx_labels', 'txLabelId', 'txLabels'],
  ['output_baskets', 'basketId', 'outputBaskets'],
  ['output_tags', 'outputTagId', 'outputTags'],
  ['commissions', 'commissionId', 'commissions'],
  ['sync_states', 'syncStateId', 'syncStates'],
  ['proven_txs', 'provenTxId', 'provenTxs'],
  ['proven_tx_reqs', 'provenTxReqId', 'provenTxReqs'],
  ['tx_labels_map', 'txLabelId', 'txLabelMaps'],
  ['output_tags_map', 'outputTagId', 'outputTagMaps'],
  ['certificate_fields', 'certificateId', 'certificateFields']
] as const

const interval = (tableId: number, overrides: Partial<SnapshotJournalInterval> = {}): SnapshotJournalInterval => ({
  stream: 'scope',
  tableId,
  userId: 1,
  floor: snapshotJournalRevision('0'),
  low: snapshotJournalRevision('0'),
  high: snapshotJournalRevision('9'),
  limit: 256,
  ...overrides
})
let db: Knex
let directory: string
let filename: string

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-delta-property-'))
  filename = join(directory, 'source.sqlite')
  db = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw('PRAGMA busy_timeout = 0')
  for (const [index, [table, key]] of fixtures.entries()) {
    await db.schema.createTable(table, t => {
      t.integer(key).notNullable()
      if (index === 10) t.integer('transactionId').notNullable()
      if (index === 11) t.integer('outputId').notNullable()
      if (index === 12) t.text('fieldName').notNullable()
      if (index < 8 || index === 12) t.integer('userId').notNullable()
      t.binary('data')
      t.text('nullable')
      t.primary(
        index === 10
          ? [key, 'transactionId']
          : index === 11
            ? [key, 'outputId']
            : index === 12
              ? [key, 'fieldName']
              : [key]
      )
    })
  }
  await db.raw(
    'CREATE TABLE snapshot_profile_keys_v2(snapshotTableId INTEGER,snapshotUserId INTEGER,snapshotRowId INTEGER,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotRowId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_relation_keys_v2(snapshotTableId INTEGER,snapshotUserId INTEGER,snapshotLeftId INTEGER,snapshotRightId INTEGER,snapshotMembership INTEGER,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotLeftId,snapshotRightId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_certificate_field_keys_v2(snapshotUserId INTEGER,snapshotCertificateId INTEGER,snapshotFieldName TEXT,snapshotMembership INTEGER,PRIMARY KEY(snapshotUserId,snapshotFieldName,snapshotCertificateId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_global_keys_v2(tableId INTEGER,userId INTEGER,rowId INTEGER,refs INTEGER,present INTEGER,PRIMARY KEY(tableId,userId,rowId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_journal_scope(tableId INTEGER,userId INTEGER,id1 INTEGER,id2 INTEGER,exactText TEXT COLLATE BINARY,revision INTEGER,present INTEGER,PRIMARY KEY(tableId,userId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE INDEX snapshot_journal_scope_page ON snapshot_journal_scope(userId,tableId,revision,id1,id2,exactText)'
  )
  await db.raw(
    'CREATE TABLE snapshot_journal_physical(tableId INTEGER,id1 INTEGER,id2 INTEGER,exactText TEXT COLLATE BINARY,revision INTEGER,generation INTEGER,present INTEGER,PRIMARY KEY(tableId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE INDEX snapshot_journal_physical_page ON snapshot_journal_physical(tableId,revision,id1,id2,exactText)'
  )
})
afterEach(async () => {
  try {
    await db.destroy()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function insert(
  k: Knex,
  tableId: number,
  id = 10,
  data = Buffer.from([0, 1, 255]),
  fieldName = 'X\0é'
): Promise<Record<string, unknown>> {
  const [table, key] = fixtures[tableId]
  const row: Record<string, unknown> = { [key]: id, data, nullable: null }
  if (tableId < 8 || tableId === 12) row.userId = 1
  if (tableId === 10) row.transactionId = 20
  if (tableId === 11) row.outputId = 20
  if (tableId === 12) row.fieldName = fieldName
  if (tableId === 10 || tableId === 11 || tableId === 12) {
    const parent =
      tableId === 10
        ? ['transactions', 'transactionId']
        : tableId === 11
          ? ['outputs', 'outputId']
          : ['certificates', 'certificateId']
    await k(parent[0]).insert({ [parent[1]]: tableId === 12 ? id : 20, userId: 1 })
  }
  await k(table).insert(row)
  if (tableId < 8)
    await k('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: 1,
      snapshotRowId: id
    })
  else if (tableId < 10)
    await k('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId: 1,
      rowId: id,
      refs: 1,
      present: 1
    })
  else if (tableId < 12) {
    await k(tableId === 10 ? 'tx_labels' : 'output_tags').insert({ [key]: id, userId: 1 })
    await k('snapshot_relation_keys_v2').insert({
      snapshotTableId: tableId - 10,
      snapshotUserId: 1,
      snapshotLeftId: id,
      snapshotRightId: 20,
      snapshotMembership: 3
    })
  } else
    await k('snapshot_certificate_field_keys_v2').insert({
      snapshotUserId: 1,
      snapshotCertificateId: id,
      snapshotFieldName: row.fieldName,
      snapshotMembership: 3
    })
  await k('snapshot_journal_scope').insert({
    tableId,
    userId: 1,
    id1: id,
    id2: tableId === 10 || tableId === 11 ? 20 : 0,
    exactText: tableId === 12 ? row.fieldName : '',
    revision: 1,
    present: 1
  })
  return row
}

const unicode = fc
  .array(fc.constantFrom('x', 'é', '中', '😀', '\u0000'), { maxLength: 32 })
  .map(parts => parts.join(''))
const example = fc.record({
  tableId: fc.integer({ min: 0, max: 12 }),
  id: fc.integer({ min: 1, max: 1000000 }),
  data: fc.uint8Array({ maxLength: 256 }),
  text: unicode,
  nullable: fc.boolean(),
  revision: fc.integer({ min: 1, max: 1000000 })
})

test('generated all-table raw payloads, nullable cells and exact journal identities are read from the same actual source transaction', async () => {
  await fc.assert(
    fc.asyncProperty(example, async value => {
      await expect(
        db.transaction(async trx => {
          const expected = await insert(trx, value.tableId, value.id, Buffer.from(value.data), value.text)
          expected.nullable = value.nullable ? null : value.text
          const [table, key, name] = fixtures[value.tableId]
          await trx(table).where(key, value.id).update({ nullable: expected.nullable })
          await trx('snapshot_journal_scope')
            .where({ tableId: value.tableId, userId: 1 })
            .update({ revision: value.revision })
          const metadata = {
            revision: snapshotJournalRevision(String(value.revision)),
            id1: value.id,
            id2: value.tableId === 10 || value.tableId === 11 ? 20 : 0,
            exactText: value.tableId === 12 ? value.text : '',
            present: true
          }
          const page = await readSnapshotJournalDeltaPage(
            trx,
            interval(value.tableId, { high: metadata.revision }),
            8192
          )
          expect(page.table).toBe(name)
          expect(page.changes).toEqual([{ metadata, present: true, row: expected }])
          expect(page.examined).toBe(1)
          expect(page.complete).toBe(true)
          expect(page.after).toEqual({
            revision: metadata.revision,
            id1: metadata.id1,
            id2: metadata.id2,
            exactText: metadata.exactText
          })
          throw new Error('Generated reader fixture rollback')
        })
      ).rejects.toThrow('Generated reader fixture rollback')
      expect(await db('snapshot_journal_scope')).toEqual([])
    }),
    controls
  )
})

test('generated byte admission refusal precedes every raw payload fetch and leaves the actual source unchanged', async () => {
  await fc.assert(
    fc.asyncProperty(example, async value => {
      await expect(
        db.transaction(async trx => {
          const expected = await insert(trx, value.tableId, value.id, Buffer.from(value.data), value.text)
          const queries: string[] = [],
            [table, key] = fixtures[value.tableId]
          const capture = (query: { sql: string }) => {
            queries.push(query.sql)
          }
          trx.on('query', capture)
          try {
            await expect(readSnapshotJournalDeltaPage(trx, interval(value.tableId), 1)).rejects.toBeInstanceOf(
              SnapshotResourceLimitError
            )
          } finally {
            trx.removeListener('query', capture)
          }
          expect(queries.some(sql => sql.includes('select') && sql.includes('.*'))).toBe(false)
          expect(await trx(table).where(key, value.id).first()).toEqual(expected)
          throw new Error('Generated precharge fixture rollback')
        })
      ).rejects.toThrow('Generated precharge fixture rollback')
      expect(await db('snapshot_journal_scope')).toEqual([])
    }),
    controls
  )
})

test('generated durable tombstones preserve exact keys and advance source progress without materializing deleted payloads', async () => {
  await fc.assert(
    fc.asyncProperty(example, async value => {
      await expect(
        db.transaction(async trx => {
          const metadata = {
            revision: snapshotJournalRevision(String(value.revision)),
            id1: value.id,
            id2: value.tableId === 10 || value.tableId === 11 ? 20 : 0,
            exactText: value.tableId === 12 ? value.text : '',
            present: false
          }
          await trx('snapshot_journal_scope').insert({
            ...metadata,
            revision: value.revision,
            tableId: value.tableId,
            userId: 1,
            present: 0
          })
          const queries: string[] = [],
            capture = (query: { sql: string }) => {
              queries.push(query.sql)
            }
          trx.on('query', capture)
          let page: SnapshotJournalDeltaPage
          try {
            page = await readSnapshotJournalDeltaPage(trx, interval(value.tableId, { high: metadata.revision }))
          } finally {
            trx.removeListener('query', capture)
          }
          expect(page.changes).toEqual([{ metadata, present: false }])
          expect(page.examined).toBe(1)
          expect(page.complete).toBe(true)
          expect(page.after).toEqual({
            revision: metadata.revision,
            id1: metadata.id1,
            id2: metadata.id2,
            exactText: metadata.exactText
          })
          expect(
            queries.some(sql => sql.includes('pragma_table_info') || (sql.includes('select') && sql.includes('.*')))
          ).toBe(false)
          throw new Error('Generated tombstone fixture rollback')
        })
      ).rejects.toThrow('Generated tombstone fixture rollback')
      expect(await db('snapshot_journal_scope')).toEqual([])
    }),
    controls
  )
})

test('generated bounded physical pages consume every event while preserving only actual profile members and their raw cells', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(8, 9),
      fc.integer({ min: 1, max: 4 }),
      fc.array(
        fc.record({
          member: fc.boolean(),
          present: fc.boolean(),
          data: fc.uint8Array({ maxLength: 128 })
        }),
        { minLength: 1, maxLength: 12 }
      ),
      async (tableId, limit, events) => {
        await expect(
          db.transaction(async trx => {
            const expected: SnapshotJournalDelta[] = []
            for (const [index, event] of events.entries()) {
              const id = index + 1000
              const metadata = {
                revision: snapshotJournalRevision(String(index + 1)),
                generation: snapshotJournalRevision('1'),
                id1: id,
                id2: 0,
                exactText: '',
                present: event.present
              }
              if (event.member && event.present) {
                const row = await insert(trx, tableId, id, Buffer.from(event.data))
                expected.push({ metadata, present: true, row })
              } else {
                await trx('snapshot_global_keys_v2').insert({
                  tableId: tableId === 8 ? 1 : 0,
                  userId: 1,
                  rowId: id,
                  refs: event.member ? 1 : 0,
                  present: event.present ? 1 : 0
                })
                if (event.member) expected.push({ metadata, present: false })
              }
              await trx('snapshot_journal_physical').insert({
                ...metadata,
                tableId,
                revision: index + 1,
                generation: 1,
                present: event.present ? 1 : 0
              })
            }
            const changes: SnapshotJournalDelta[] = []
            let after: SnapshotJournalPosition | undefined
            let examined = 0
            let complete = false
            // A full final page may require one empty observation, but a cursor
            // may never skip an irrelevant event or remain stuck before completion.
            for (let count = 0; count <= events.length && !complete; count++) {
              const page = await readSnapshotJournalDeltaPage(
                trx,
                interval(tableId, {
                  stream: 'physical',
                  high: snapshotJournalRevision(String(events.length)),
                  limit,
                  ...(after === undefined ? {} : { after })
                }),
                8192
              )
              expect(page.examined).toBeLessThanOrEqual(limit)
              expect(page.payloadBytes).toBeLessThanOrEqual(8192)
              if (!page.complete) expect(page.examined).toBeGreaterThan(0)
              changes.push(...page.changes)
              examined += page.examined
              after = page.after
              complete = page.complete
            }
            expect(complete).toBe(true)
            expect(examined).toBe(events.length)
            expect(changes).toEqual(expected)
            expect(after).toEqual({
              revision: snapshotJournalRevision(String(events.length)),
              id1: events.length + 999,
              id2: 0,
              exactText: ''
            })
            throw new Error('Generated physical fixture rollback')
          })
        ).rejects.toThrow('Generated physical fixture rollback')
        expect(await db('snapshot_journal_physical')).toEqual([])
      }
    ),
    controls
  )
})
