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
  advanceSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import { snapshotJournalIdentityLedgerDdl } from './SnapshotJournalIdentityLedger'
import {
  applySnapshotJournalIdentityTransition,
  snapshotJournalIdentityRetirementsDdl
} from './SnapshotJournalIdentityRetirements'

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
let db: Knex
let directory: string
let filename: string
let state: SnapshotJournalDestinationCheckpoint
let binding: SnapshotJournalDestinationBinding
const sessionId = '91'.repeat(32)
const identityKey = '02' + '22'.repeat(32)

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-destination-window-'))
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
      highWater: snapshotJournalRevision('1000'),
      floor: snapshotJournalRevision('0'),
      expiresAt: Date.now() + 3600000
    },
    low: snapshotJournalRevision('1'),
    destinationBackend: '66'.repeat(32),
    destinationStorageIdentity: 'destination',
    destinationUserId: 7,
    primaryEpoch: snapshotJournalRevision('0'),
    activeStorage: 'destination'
  }
  for (const sql of [...snapshotJournalIdentityLedgerDdl(db), ...snapshotJournalIdentityRetirementsDdl(db)])
    await db.raw(sql)
  state = await begin()
  for (let stream = 0; stream < 15; stream++) {
    state = (
      await db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            { phase: 'intake', examined: 0, complete: true },
            async () => undefined
          )
      )
    ).checkpoint
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

test('generated independent history retains every superseded association and rolls back all custody', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 3 }),
          table: fc.constantFrom(4 as const, 5 as const),
          replace: fc.boolean(),
          rename: fc.boolean(),
          target: fc.integer({ min: 100, max: 110 })
        }),
        { minLength: 1, maxLength: 6 }
      ),
      async history => {
        const model = new Map<
          string,
          {
            tableId: 4 | 5
            incomingId: number
            generation: number
            naturalIdentity: string
            localId: number
          }
        >()
        const pending = new Map<
          string,
          {
            tableId: 4 | 5
            incomingId: number
            generation: string
            naturalIdentity: string
            localId: number
          }
        >()
        await expect(
          db.transaction(async trx => {
            for (const event of history) {
              const key = event.table + ':' + event.id
              const old = model.get(key)
              const generation = old === undefined ? 1 : old.generation + (event.replace ? 1 : 0)
              const naturalIdentity = (event.rename ? 'b' : 'a').repeat(64)
              const same = old !== undefined && old.generation === generation && old.naturalIdentity === naturalIdentity
              const localId = same ? old.localId : event.target
              if (old !== undefined && !same) {
                const retired = {
                  tableId: old.tableId,
                  incomingId: old.incomingId,
                  generation: String(old.generation),
                  naturalIdentity: old.naturalIdentity,
                  localId: old.localId
                }
                pending.set(
                  JSON.stringify([
                    retired.tableId,
                    retired.incomingId,
                    retired.generation,
                    retired.naturalIdentity,
                    retired.localId
                  ]),
                  retired
                )
              }
              await applySnapshotJournalIdentityTransition(
                trx,
                binding,
                state,
                [
                  {
                    tableId: event.table,
                    incomingId: event.id,
                    generation: snapshotJournalRevision(String(generation)),
                    naturalIdentity,
                    required: same
                  }
                ],
                { maximumMappings: 8, maximumPendingAssociations: 8 },
                async () => ({ assignments: new Map([[key, localId]]), result: undefined })
              )
              model.set(key, {
                tableId: event.table,
                incomingId: event.id,
                generation,
                naturalIdentity,
                localId
              })
            }
            const order = (
              a: {
                tableId: number
                incomingId: number
                generation: string
                naturalIdentity: string
                localId: number
              },
              b: typeof a
            ) =>
              a.tableId - b.tableId ||
              a.incomingId - b.incomingId ||
              a.generation.localeCompare(b.generation) ||
              a.naturalIdentity.localeCompare(b.naturalIdentity) ||
              a.localId - b.localId
            expect(
              await trx('snapshot_reconciliation_identity_retirements')
                .select('tableId', 'incomingId', 'generation', 'naturalIdentity', 'localId')
                .orderBy(['tableId', 'incomingId', 'generation', 'naturalIdentity', 'localId'])
            ).toEqual([...pending.values()].sort(order))
            expect(
              await trx('snapshot_reconciliation_identity_maps')
                .select('tableId', 'incomingId', 'generation', 'naturalIdentity', 'localId')
                .orderBy(['tableId', 'incomingId'])
            ).toEqual([...model.values()].map(row => ({ ...row, generation: String(row.generation) })).sort(order))
            expect(
              await trx('snapshot_reconciliation_identity_retirement_budgets').select('pendingAssociations')
            ).toEqual([{ pendingAssociations: pending.size }])
            expect(await trx('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([
              { mappings: model.size }
            ])
            throw new Error('generated retirement rollback')
          })
        ).rejects.toThrow('generated retirement rollback')
        expect(await db('snapshot_reconciliation_identity_retirements')).toEqual([])
        expect(await db('snapshot_reconciliation_identity_maps')).toEqual([])
        expect(await db('snapshot_reconciliation_identity_retirement_budgets')).toEqual([])
        expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
        expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
          state
        )
      }
    ),
    controls
  )
})
