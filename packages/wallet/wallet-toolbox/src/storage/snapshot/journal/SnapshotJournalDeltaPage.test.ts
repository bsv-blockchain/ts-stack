import { knex, type Knex } from 'knex'
import { readSnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { encodeSnapshotJournalDeltaFrame, decodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import type { SnapshotJournalInterval } from './SnapshotJournalPage'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.setTimeout(30000)

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
  directory = mkdtempSync(join(tmpdir(), 'journal-delta-'))
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

async function insert(tableId: number, id = 10, data = Buffer.from([0, 1, 255])): Promise<Record<string, unknown>> {
  const [table, key] = fixtures[tableId]
  const row: Record<string, unknown> = { [key]: id, data, nullable: null }
  if (tableId < 8 || tableId === 12) row.userId = 1
  if (tableId === 10) row.transactionId = 20
  if (tableId === 11) row.outputId = 20
  if (tableId === 12) row.fieldName = 'X\0é'
  if (tableId === 10 || tableId === 11 || tableId === 12) {
    const parent =
      tableId === 10
        ? ['transactions', 'transactionId']
        : tableId === 11
          ? ['outputs', 'outputId']
          : ['certificates', 'certificateId']
    await db(parent[0]).insert({ [parent[1]]: tableId === 12 ? id : 20, userId: 1 })
  }
  await db(table).insert(row)
  if (tableId < 8)
    await db('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: 1,
      snapshotRowId: id
    })
  else if (tableId < 10)
    await db('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId: 1,
      rowId: id,
      refs: 1,
      present: 1
    })
  else if (tableId < 12) {
    await db(tableId === 10 ? 'tx_labels' : 'output_tags').insert({ [key]: id, userId: 1 })
    await db('snapshot_relation_keys_v2').insert({
      snapshotTableId: tableId - 10,
      snapshotUserId: 1,
      snapshotLeftId: id,
      snapshotRightId: 20,
      snapshotMembership: 3
    })
  } else
    await db('snapshot_certificate_field_keys_v2').insert({
      snapshotUserId: 1,
      snapshotCertificateId: id,
      snapshotFieldName: row.fieldName,
      snapshotMembership: 3
    })
  await db('snapshot_journal_scope').insert({
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

describe('internal pinned journal delta materialization', () => {
  test.each(fixtures.map((entry, id) => [id, ...entry] as const))(
    'reads every original column in journal table%s (%s)',
    async (id, _table, _key, expectedTable) => {
      const expected = await insert(id)
      await db.transaction(async trx => {
        const page = await readSnapshotJournalDeltaPage(trx, interval(id))
        expect(page.table).toBe(expectedTable)
        expect(page.changes).toHaveLength(1)
        expect(page.changes[0].present).toBe(true)
        if (!page.changes[0].present) throw new Error('Expected stored payload')
        expect(page.changes[0].row).toEqual(expected)
        expect(Object.getPrototypeOf(page.changes[0].row)).toBe(Object.prototype)
        const context = { stream: 'scope' as const, tableId: id }
        const decoded = decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(page, context), context)
        const restored = decoded.changes[0]
        expect(restored.metadata).toEqual(page.changes[0].metadata)
        if (!restored.present) throw new Error('Expected framed stored payload')
        expect(Object.keys(restored.row).sort()).toEqual(Object.keys(expected).sort())
        for (const [field, value] of Object.entries(expected)) {
          if (field === 'data') expect(Array.from(restored.row[field] as Uint8Array)).toEqual([0, 1, 255])
          else expect(restored.row[field]).toEqual(value)
        }
        expect(page.examined).toBe(1)
        expect(page.complete).toBe(true)
        expect(page.after).toEqual({
          revision: '1',
          id1: 10,
          id2: id === 10 || id === 11 ? 20 : 0,
          exactText: id === 12 ? 'X\0é' : ''
        })
      })
    }
  )

  test('returns a tombstone without requiring source columns or an existing row', async () => {
    await db('snapshot_journal_scope').insert({
      tableId: 0,
      userId: 1,
      id1: 10,
      id2: 0,
      exactText: '',
      revision: 1,
      present: 0
    })
    await db.schema.dropTable('transactions')
    await db.transaction(async trx => {
      const queries: string[] = []
      trx.on('query', ({ sql }: { sql: string }) => queries.push(sql))
      const page = await readSnapshotJournalDeltaPage(trx, interval(0))
      expect(page.changes).toEqual([
        {
          metadata: { revision: '1', id1: 10, id2: 0, exactText: '', present: false },
          present: false
        }
      ])
      expect(queries.some(sql => sql.includes('pragma_table_info') || sql.includes('transactions'))).toBe(false)
    })
  })

  test('advances across unrelated physical changes before a relevant packed payload', async () => {
    await insert(8, 20)
    await db('snapshot_journal_physical').insert(
      [10, 20].map((id, index) => ({
        tableId: 8,
        id1: id,
        id2: 0,
        exactText: '',
        revision: index + 1,
        generation: 1,
        present: 1
      }))
    )
    await db.transaction(async trx => {
      const first = await readSnapshotJournalDeltaPage(trx, interval(8, { stream: 'physical', limit: 1 }))
      expect(first.changes).toEqual([])
      expect(first.examined).toBe(1)
      expect(first.complete).toBe(false)
      const next = await readSnapshotJournalDeltaPage(
        trx,
        interval(8, { stream: 'physical', after: first.after, limit: 1 })
      )
      expect(next.changes).toHaveLength(1)
      expect(next.changes[0].metadata.generation).toBe('1')
      expect(next.after?.id1).toBe(20)
    })
  })

  test('refuses an oversized first row before selecting its payload', async () => {
    await insert(0, 10, Buffer.alloc(4096, 7))
    await db.transaction(async trx => {
      const queries: string[] = []
      trx.on('query', ({ sql }: { sql: string }) => queries.push(sql))
      await expect(readSnapshotJournalDeltaPage(trx, interval(0), 1024)).rejects.toBeInstanceOf(
        SnapshotResourceLimitError
      )
      expect(queries.some(sql => sql.includes('`transactions`.*'))).toBe(false)
    })
  })

  test('retains the exact bounded prefix and resumes the unconsumed row', async () => {
    await insert(0, 10)
    await insert(0, 20)
    await db.transaction(async trx => {
      const first = await readSnapshotJournalDeltaPage(trx, interval(0, { limit: 1 }))
      const limited = await readSnapshotJournalDeltaPage(trx, interval(0), first.payloadBytes)
      expect(limited.changes).toHaveLength(1)
      expect(limited.after).toEqual(first.after)
      expect(limited.complete).toBe(false)
      const next = await readSnapshotJournalDeltaPage(trx, interval(0, { after: limited.after }))
      expect(next.changes).toHaveLength(1)
      expect(next.after?.id1).toBe(20)
      expect(next.complete).toBe(true)
    })
  })

  test('uses the pinned payload view while an independent writer commits metadata and bytes', async () => {
    const expected = await insert(0)
    const writer = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    const replacement = Buffer.from([22, 33, 44])
    try {
      await writer.raw('PRAGMA busy_timeout = 0')
      await db.transaction(async trx => {
        const pinned = await readSnapshotJournalDeltaPage(trx, interval(0))
        await writer.transaction(async write => {
          await write('transactions').where('transactionId', 10).update('data', replacement)
          await write('snapshot_journal_scope').where('tableId', 0).update('revision', 2)
        })
        const repeated = await readSnapshotJournalDeltaPage(trx, interval(0))
        expect(repeated).toEqual(pinned)
        expect(repeated.changes[0].present).toBe(true)
        if (!repeated.changes[0].present) throw new Error('Expected pinned payload')
        expect(repeated.changes[0].row).toEqual(expected)
      })
      await db.transaction(async trx => {
        const fresh = await readSnapshotJournalDeltaPage(trx, interval(0))
        expect(fresh.changes[0].metadata.revision).toBe('2')
        if (!fresh.changes[0].present) throw new Error('Expected current payload')
        expect(fresh.changes[0].row.data).toEqual(replacement)
      })
    } finally {
      await writer.destroy()
    }
  })

  test('refuses a still-present scope entry with a different actual owner', async () => {
    await insert(0)
    await db('transactions').where('transactionId', 10).update('userId', 2)
    await db.transaction(async trx => {
      await expect(readSnapshotJournalDeltaPage(trx, interval(0))).rejects.toThrow('Invalid or inconsistent')
    })
  })

  test('refuses a relation whose other parent belongs to another profile', async () => {
    await insert(10)
    await db('transactions').where('transactionId', 20).update('userId', 2)
    await db.transaction(async trx => {
      await expect(readSnapshotJournalDeltaPage(trx, interval(10))).rejects.toThrow('Invalid or inconsistent')
    })
  })

  test('does not treat case-equivalent text as the exact journal identity', async () => {
    await insert(12)
    await db('snapshot_journal_scope').where('tableId', 12).update('exactText', 'x\0é')
    await db.transaction(async trx => {
      await expect(readSnapshotJournalDeltaPage(trx, interval(12))).rejects.toThrow('Invalid or inconsistent')
    })
  })

  test('refuses a nontransaction connection and validates empty-interval byte limits', async () => {
    await expect(readSnapshotJournalDeltaPage(db, interval(0))).rejects.toThrow('Invalid or inconsistent')
    await db.transaction(async trx => {
      await expect(
        readSnapshotJournalDeltaPage(trx, interval(0, { high: snapshotJournalRevision('0') }), 0)
      ).rejects.toThrow('Invalid or inconsistent')
    })
  })
})
