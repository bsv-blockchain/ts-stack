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
import {
  prepareSnapshotJournalIdentityLedger,
  snapshotJournalIdentityLedgerDdl,
  type SnapshotJournalIdentityReference
} from './SnapshotJournalIdentityLedger'

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
  for (const sql of snapshotJournalIdentityLedgerDdl(db)) await db.raw(sql)
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

test('generated source history independently predicts acknowledged identity, aliasing and rollback', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 3 }),
          table: fc.constantFrom(4 as const, 5 as const),
          replace: fc.boolean(),
          rename: fc.boolean(),
          proposedLocalId: fc.integer({ min: 100, max: 110 })
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
            identity: string
            localId: number
          }
        >()
        await expect(
          db.transaction(async trx => {
            for (const event of history) {
              const modelKey = event.table + ':' + event.id
              const old = model.get(modelKey)
              const generation = old === undefined ? 1 : old.generation + (event.replace ? 1 : 0)
              const identity = (event.rename ? 'b' : 'a').repeat(64)
              const unchanged = old !== undefined && old.generation === generation && old.identity === identity
              const desired = unchanged ? old.localId : event.proposedLocalId
              const request: SnapshotJournalIdentityReference = {
                tableId: event.table,
                incomingId: event.id,
                generation: snapshotJournalRevision(String(generation)),
                naturalIdentity: identity,
                required: unchanged
              }
              const actual = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [request], {
                maximumMappings: 8
              })
              expect(actual.associations.get(modelKey)).toEqual(
                unchanged
                  ? {
                      generation: String(old.generation),
                      naturalIdentity: old.identity,
                      localId: old.localId
                    }
                  : undefined
              )
              expect(actual.previous.get(modelKey)).toEqual(
                old !== undefined && !unchanged
                  ? {
                      generation: String(old.generation),
                      naturalIdentity: old.identity,
                      localId: old.localId
                    }
                  : undefined
              )
              await actual.persist(new Map([[modelKey, desired]]))
              model.set(modelKey, {
                tableId: event.table,
                incomingId: event.id,
                generation,
                identity,
                localId: desired
              })
            }
            const expectedRows = [...model.values()]
              .map(row => ({
                tableId: row.tableId,
                incomingId: row.incomingId,
                generation: String(row.generation),
                naturalIdentity: row.identity,
                localId: row.localId
              }))
              .sort((a, b) => a.tableId - b.tableId || a.incomingId - b.incomingId)
            expect(
              await trx('snapshot_reconciliation_identity_maps')
                .select('tableId', 'incomingId', 'generation', 'naturalIdentity', 'localId')
                .orderBy(['tableId', 'incomingId'])
            ).toEqual(expectedRows)
            expect(await trx('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([
              { mappings: model.size }
            ])
            throw new Error('generated identity rollback')
          })
        ).rejects.toThrow('generated identity rollback')
        expect(await db('snapshot_reconciliation_identity_maps').select('incomingId')).toEqual([])
        expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([])
        expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
          state
        )
      }
    ),
    controls
  )
})
