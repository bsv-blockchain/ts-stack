import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import {
  succeedSnapshotJournalDestinationWindow,
  snapshotJournalDestinationWindowDdl,
  beginSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  advanceSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

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

const history = fc.record({
  prefix: fc.integer({ min: 0, max: 3 }),
  id: fc.integer({ min: 1, max: 1000000 }),
  generation: fc.integer({ min: 1, max: 1000000 }),
  value: fc.array(fc.constantFrom('x', 'é', '中', '😀', '\u0000'), { maxLength: 24 }).map(parts => parts.join(''))
})

const promotionOrder = [
  'provenTxs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'outputs',
  'txLabelMaps',
  'outputTagMaps',
  'certificates',
  'certificateFields',
  'commissions',
  'provenTxReqs'
]

test('generated prefixes traverse all fifteen source streams and twelve promotion tables before acknowledgement and coherent succession', async () => {
  await fc.assert(
    fc.asyncProperty(history, async value => {
      await expect(
        db.transaction(async trx => {
          const actual = {
            ...binding,
            source: { ...binding.source },
            low: snapshotJournalRevision(String(value.generation)),
            receipt: {
              ...binding.receipt,
              highWater: snapshotJournalRevision(String(value.generation + 2))
            }
          }
          let state = await beginSnapshotJournalDestinationWindow(trx, actual, sessionId)
          let expectedSequence = 0
          for (let index = 0; index < value.prefix; index++) {
            const after = {
              revision: snapshotJournalRevision(String(value.generation + 1)),
              id1: value.id + index,
              id2: 0,
              exactText: ''
            }
            const before = state
            state = (
              await advanceSnapshotJournalDestinationWindow(
                trx,
                actual,
                state,
                { phase: 'intake', examined: 1, complete: false, after },
                async k => {
                  await k('test_staged_rows').insert({ id: index + 1, value: value.value })
                }
              )
            ).checkpoint
            expectedSequence++
            expect(state).toMatchObject({
              phase: 'intake',
              streamIndex: 0,
              sequence: expectedSequence,
              after
            })
            const duplicate = jest.fn(async () => undefined)
            await expect(
              advanceSnapshotJournalDestinationWindow(
                trx,
                actual,
                before,
                { phase: 'intake', examined: 1, complete: false, after },
                duplicate
              )
            ).rejects.toThrow('Invalid or stale')
            expect(duplicate).not.toHaveBeenCalled()
            expect(await readSnapshotJournalDestinationWindow(trx, actual)).toEqual(state)
          }
          for (let streamIndex = 0; streamIndex < 15; streamIndex++) {
            expect(state).toMatchObject({
              phase: 'intake',
              streamIndex,
              tableIndex: 0,
              promotionSequence: 0
            })
            state = (
              await advanceSnapshotJournalDestinationWindow(
                trx,
                actual,
                state,
                {
                  phase: 'intake',
                  examined: 0,
                  complete: true,
                  ...(state.after === undefined ? {} : { after: state.after })
                },
                async () => undefined
              )
            ).checkpoint
            expectedSequence++
            expect(state.sequence).toBe(expectedSequence)
          }
          const observed: string[] = []
          for (const [tableIndex, name] of promotionOrder.entries()) {
            expect(state).toMatchObject({
              phase: 'promoting',
              streamIndex: 15,
              tableIndex,
              promotionSequence: 0
            })
            state = (
              await advanceSnapshotJournalDestinationWindow(
                trx,
                actual,
                state,
                { phase: 'promoting', examined: 0, complete: true, promotionSequence: 0 },
                async () => {
                  observed.push(name)
                }
              )
            ).checkpoint
            expectedSequence++
          }
          expect(observed).toEqual(promotionOrder)
          expect(state).toMatchObject({
            phase: 'acknowledged',
            sequence: expectedSequence,
            streamIndex: 15,
            tableIndex: 12,
            promotionSequence: 0
          })
          expect(await readSnapshotJournalDestinationWindow(trx, actual)).toEqual(state)
          const next = {
            ...actual,
            low: actual.receipt.highWater,
            receipt: {
              ...actual.receipt,
              requestId: '57'.repeat(32),
              highWater: snapshotJournalRevision(String(value.generation + 3))
            }
          }
          const cleanup = jest.fn(async (k: Knex) => {
            await k('test_staged_rows').del()
          })
          const successor = await succeedSnapshotJournalDestinationWindow(
            trx,
            actual,
            state,
            next,
            '93'.repeat(32),
            cleanup
          )
          expect(successor).toMatchObject({
            phase: 'intake',
            streamIndex: 0,
            tableIndex: 0,
            sequence: 0
          })
          const progress = (
            await advanceSnapshotJournalDestinationWindow(
              trx,
              next,
              successor,
              { phase: 'intake', examined: 0, complete: true },
              async () => undefined
            )
          ).checkpoint
          expect(
            await succeedSnapshotJournalDestinationWindow(trx, actual, state, next, '93'.repeat(32), cleanup)
          ).toEqual(progress)
          expect(cleanup).toHaveBeenCalledTimes(1)
          expect(await trx('test_staged_rows')).toEqual([])
          throw new Error('Generated window history rollback')
        })
      ).rejects.toThrow('Generated window history rollback')
      expect(await db('snapshot_reconciliation_windows')).toEqual([])
      expect(await db('test_staged_rows')).toEqual([])
    }),
    controls
  )
})

test('generated callback failures and primary changes roll back every actual write and checkpoint', async () => {
  await fc.assert(
    fc.asyncProperty(history, fc.boolean(), async (value, changePrimary) => {
      const state = await begin()
      const apply = jest.fn(async (k: Knex) => {
        await k('test_staged_rows').insert({ id: value.id, value: value.value })
        if (changePrimary) {
          await k('users').where('userId', 7).update('activeStorage', 'another')
          await k('users').where('userId', 7).update('activeStorage', 'destination')
        } else throw new Error('Generated callback failure')
      })
      await expect(
        db.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              { phase: 'intake', examined: 0, complete: true },
              apply
            )
        )
      ).rejects.toThrow(changePrimary ? 'Invalid or stale' : 'Generated callback failure')
      expect(apply).toHaveBeenCalledTimes(1)
      expect(await db('test_staged_rows')).toEqual([])
      expect(await db('snapshot_sync_primary_epochs')).toEqual([])
      expect((await db('users').first()).activeStorage).toBe('destination')
      expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
    }),
    controls
  )
})

test('generated repeated and regressed journal positions cannot invoke the destination callback', async () => {
  await fc.assert(
    fc.asyncProperty(history, async value => {
      await expect(
        db.transaction(async trx => {
          const state = await beginSnapshotJournalDestinationWindow(trx, binding, sessionId)
          const after = {
            revision: snapshotJournalRevision('2'),
            id1: value.id + 1,
            id2: 0,
            exactText: value.value
          }
          const next = (
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              { phase: 'intake', examined: 1, complete: false, after },
              async () => undefined
            )
          ).checkpoint
          for (const cursor of [after, { ...after, id1: value.id }]) {
            const apply = jest.fn(async () => undefined)
            await expect(
              advanceSnapshotJournalDestinationWindow(
                trx,
                binding,
                next,
                { phase: 'intake', examined: 1, complete: false, after: cursor },
                apply
              )
            ).rejects.toThrow('Invalid or stale')
            expect(apply).not.toHaveBeenCalled()
            expect(await readSnapshotJournalDestinationWindow(trx, binding)).toEqual(next)
          }
          throw new Error('Generated monotonic cursor rollback')
        })
      ).rejects.toThrow('Generated monotonic cursor rollback')
      expect(await db('snapshot_reconciliation_windows')).toEqual([])
    }),
    controls
  )
})
