import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import {
  snapshotJournalDestinationWindowDdl,
  beginSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  advanceSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { decodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import {
  stageSnapshotJournalDestinationPage,
  snapshotJournalDestinationStageDdl,
  readSnapshotJournalDestinationPromotionPage
} from './SnapshotJournalDestinationStage'

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
const limits = { maximumBytes: 1048576, maximumPages: 256 }
let db: Knex
let directory: string
let filename: string
let binding: SnapshotJournalDestinationBinding
const sessionId = '91'.repeat(32)
const identityKey = '02' + '22'.repeat(32)

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-destination-stage-'))
  filename = join(directory, 'destination.sqlite')
  db = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw('PRAGMA busy_timeout = 0')
  await db.raw('CREATE TABLE users(userId INTEGER PRIMARY KEY,identityKey TEXT NOT NULL UNIQUE,activeStorage TEXT)')
  await db.raw('CREATE TABLE settings(storageIdentityKey TEXT NOT NULL,chain TEXT NOT NULL)')
  await db.raw('CREATE TABLE snapshot_sync_primary_epochs(userId INTEGER PRIMARY KEY,epoch INTEGER NOT NULL)')
  await db.raw(
    'CREATE TRIGGER test_primary_change AFTER UPDATE OF activeStorage ON users WHEN OLD.activeStorage IS NOT NEW.activeStorage BEGIN INSERT INTO snapshot_sync_primary_epochs(userId,epoch) VALUES(NEW.userId,1) ON CONFLICT(userId) DO UPDATE SET epoch=epoch+1; END'
  )
  await db.raw('CREATE TABLE test_staged_rows(id INTEGER PRIMARY KEY,value TEXT NOT NULL)')
  await db('users').insert({
    userId: 7,
    identityKey,
    activeStorage: 'destination'
  })
  await db('settings').insert({
    storageIdentityKey: 'destination',
    chain: 'mock'
  })
  await db.raw(snapshotJournalDestinationWindowDdl(db))
  for (const ddl of snapshotJournalDestinationStageDdl(db)) await db.raw(ddl)
  const source = {
    backend: '11'.repeat(32),
    epoch: '11111111-2222-4333-8444-555555555555',
    source: '33'.repeat(32),
    schema: '44'.repeat(32),
    storageIdentity: 'source',
    identityKey,
    userId: 3,
    chain: 'mock'
  }
  binding = {
    source,
    receipt: {
      requestId: '55'.repeat(32),
      binding: snapshotJournalReceiptBinding(source),
      highWater: snapshotJournalRevision('9'),
      floor: snapshotJournalRevision('0'),
      expiresAt: Date.now() + 60000
    },
    low: snapshotJournalRevision('1'),
    destinationBackend: '66'.repeat(32),
    destinationStorageIdentity: 'destination',
    destinationUserId: 7,
    primaryEpoch: snapshotJournalRevision('0'),
    activeStorage: 'destination'
  }
})
afterEach(async () => {
  try {
    await db.destroy()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function begin(): Promise<SnapshotJournalDestinationCheckpoint> {
  return await db.transaction(async trx => await beginSnapshotJournalDestinationWindow(trx, binding, sessionId))
}

function rawPage(text = 'é\u0000😀'): SnapshotJournalDeltaPage {
  const metadata = {
    revision: snapshotJournalRevision('3'),
    id1: 7,
    id2: 0,
    exactText: '',
    present: true
  }
  return {
    table: 'transactions',
    changes: [
      {
        metadata,
        present: true,
        row: {
          transactionId: 7,
          userId: 3,
          nullable: null,
          description: text,
          rawBoolean: 0,
          boolean: false,
          created_at: new Date(0),
          rawTx: Uint8Array.of(0, 128, 255)
        }
      }
    ],
    examined: 1,
    payloadBytes: 1024,
    complete: true,
    after: { revision: metadata.revision, id1: 7, id2: 0, exactText: '' }
  }
}
test('generated ordinary writer rollback preserves complete raw pages and leaves no charge or checkpoint drift', async () => {
  const state = await begin()
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        text: fc.array(fc.constantFrom('x', 'é', '中', '😀', '\u0000'), { maxLength: 16 }).map(chars => chars.join('')),
        bytes: fc.uint8Array({ maxLength: 128 }),
        nullable: fc.boolean(),
        flag: fc.boolean()
      }),
      async value => {
        const data = rawPage(value.text)
        if (!data.changes[0].present) throw new Error('Expected raw row')
        data.changes[0].row.rawTx = value.bytes
        data.changes[0].row.nullable = value.nullable ? null : value.text
        data.changes[0].row.rawBoolean = Number(value.flag)
        data.changes[0].row.boolean = value.flag
        await expect(
          db.transaction(async trx => {
            const result = await stageSnapshotJournalDestinationPage(trx, binding, state, data, limits)
            expect(result.checkpoint).toMatchObject({ sequence: 1, streamIndex: 1 })
            const rows = await trx('snapshot_reconciliation_stage_pages').select('payload', 'bytes')
            expect(rows).toHaveLength(1)
            expect(rows[0].bytes).toBe(rows[0].payload.byteLength)
            expect(decodeSnapshotJournalDeltaFrame(rows[0].payload, { stream: 'scope', tableId: 0 })).toEqual(data)
            throw new Error('Generated actual writer rollback')
          })
        ).rejects.toThrow('Generated actual writer rollback')
        expect(await db('snapshot_reconciliation_stage_pages')).toEqual([])
        expect(await db('snapshot_reconciliation_stage_budgets')).toEqual([])
        expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
          state
        )
      }
    ),
    controls
  )
})

async function intakeChain(): Promise<SnapshotJournalDestinationCheckpoint> {
  let state = await begin()
  const tables: SnapshotJournalDeltaPage['table'][] = [
    'transactions',
    'outputs',
    'certificates',
    'txLabels',
    'outputBaskets',
    'outputTags',
    'commissions',
    'syncStates',
    'provenTxs',
    'provenTxReqs',
    'txLabelMaps',
    'outputTagMaps',
    'certificateFields'
  ]
  for (let stream = 0; stream < 15; stream++) {
    const tableId = stream < 13 ? stream : stream === 13 ? 8 : 9
    const count = stream === 8 ? 3 : 1
    for (let index = 0; index < count; index++) {
      const page: SnapshotJournalDeltaPage = {
        table: tables[tableId],
        changes: [],
        examined: 0,
        payloadBytes: 0,
        complete: true
      }
      if (stream === 8) {
        const metadata = {
          revision: snapshotJournalRevision(String(3 + index)),
          id1: 71 + index,
          id2: 0,
          exactText: '',
          present: true
        }
        page.changes = [
          {
            metadata,
            present: true,
            row: { provenTxId: metadata.id1, rawTx: Uint8Array.of(index, 128, 255), nullable: null }
          }
        ]
        page.examined = 1
        page.payloadBytes = 1024
        page.complete = index === count - 1
        page.after = { revision: metadata.revision, id1: metadata.id1, id2: 0, exactText: '' }
      }
      state = (
        await db.transaction(async trx => await stageSnapshotJournalDestinationPage(trx, binding, state, page, limits))
      ).checkpoint
    }
  }
  expect(state.phase).toBe('promoting')
  return state
}

async function consumeChainPage(
  trx: Knex,
  state: SnapshotJournalDestinationCheckpoint,
  receiptSequence: number,
  examined: number
): Promise<SnapshotJournalDestinationCheckpoint> {
  // An empty staged frame is still one bounded promotion work item.
  return (
    await advanceSnapshotJournalDestinationWindow(
      trx,
      binding,
      state,
      {
        phase: 'promoting',
        examined: Math.max(1, examined),
        complete: false,
        promotionSequence: receiptSequence
      },
      async () => undefined
    )
  ).checkpoint
}

test('generated actual page loss matches an independent ordered custody model and every example rolls back', async () => {
  const initial = await intakeChain()
  const model = [
    { sequence: 9, streamIndex: 8, examined: 1 },
    { sequence: 10, streamIndex: 8, examined: 1 },
    { sequence: 11, streamIndex: 8, examined: 1 },
    { sequence: 16, streamIndex: 13, examined: 0 }
  ]
  const before = await db('snapshot_reconciliation_stage_chains').where({ tableId: 8 }).select()
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        hole: fc.integer({ min: -1, max: 3 }),
        prefix: fc.integer({ min: 0, max: 3 }),
        nonce: fc.uint8Array({ maxLength: 32 })
      }),
      async example => {
        await expect(
          db.transaction(async trx => {
            let state = initial
            for (let index = 0; index < example.prefix; index++) {
              const result = await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
              expect(result?.receipt).toMatchObject(model[index])
              if (!result) throw new Error('Expected model prefix')
              state = await consumeChainPage(trx, state, result.receipt.sequence, result.page.examined)
            }
            const hole = example.hole < example.prefix ? -1 : example.hole
            if (hole >= 0)
              await trx('snapshot_reconciliation_stage_pages').where({ sequence: model[hole].sequence }).delete()
            await trx('test_staged_rows').insert({
              id: 123,
              value: Buffer.from(example.nonce).toString('hex')
            })
            for (let index = example.prefix; index < model.length; index++) {
              if (index === hole) {
                const queries: string[] = []
                const capture = (query: { sql: string }) => queries.push(query.sql)
                trx.on('query', capture)
                try {
                  await expect(readSnapshotJournalDestinationPromotionPage(trx, binding, state)).rejects.toThrow(
                    'Invalid or exhausted'
                  )
                } finally {
                  trx.removeListener('query', capture)
                }
                expect(queries.some(sql => sql.includes('substr') && sql.includes('payload'))).toBe(false)
                break
              }
              const result = await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
              expect(result?.receipt).toMatchObject(model[index])
              if (!result) throw new Error('Expected independent next staged frame')
              state = await consumeChainPage(trx, state, result.receipt.sequence, result.page.examined)
            }
            if (hole < 0) expect(await readSnapshotJournalDestinationPromotionPage(trx, binding, state)).toBeUndefined()
            throw new Error('Generated custody model rollback')
          })
        ).rejects.toThrow('Generated custody model rollback')
        expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
          initial
        )
        expect(await db('snapshot_reconciliation_stage_chains').where({ tableId: 8 }).select()).toEqual(before)
        expect(
          await db('snapshot_reconciliation_stage_pages').where({ tableId: 8 }).orderBy('sequence').select('sequence')
        ).toEqual(model.map(({ sequence }) => ({ sequence })))
        expect(await db('test_staged_rows')).toEqual([])
      }
    ),
    controls
  )
})
