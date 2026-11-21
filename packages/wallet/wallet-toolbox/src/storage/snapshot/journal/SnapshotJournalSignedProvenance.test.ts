import {
  snapshotJournalProvenanceDdl,
  applySnapshotJournalProvenancePage,
  readSnapshotJournalProvenancePage
} from './SnapshotJournalProvenance'
import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { snapshotSyncTables } from '../SnapshotSync'
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
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

jest.setTimeout(30000)
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

test('real acknowledged provenance preserves signed keys through intake, bounded restart pages and explicit zero cursor', async () => {
  for (const ddl of snapshotJournalProvenanceDdl(db)) await db.raw(ddl)
  let state = await begin()
  const advance = async (
    step: Parameters<typeof advanceSnapshotJournalDestinationWindow>[3],
    apply: (trx: Knex) => Promise<void> = async () => undefined
  ) => {
    const result = await db.transaction(
      async trx => await advanceSnapshotJournalDestinationWindow(trx, binding, state, step, apply)
    )
    state = result.checkpoint
  }
  for (let index = 0; index < 7; index++) await advance({ phase: 'intake', examined: 0, complete: true })
  const ids = [-Number.MAX_SAFE_INTEGER, -1, 0, 7]
  for (const [index, id] of ids.entries()) {
    const revision = snapshotJournalRevision(String(index + 2))
    const after = { revision, id1: id, id2: 0, exactText: '' }
    const page: SnapshotJournalDeltaPage = {
      table: 'syncStates',
      changes: [
        {
          metadata: { ...after, present: true },
          present: true,
          row: { syncStateId: id, userId: 3, syncMap: 'independent\u0000雪' + id }
        }
      ],
      examined: 1,
      payloadBytes: 0,
      complete: index === ids.length - 1,
      after
    }
    await advance(
      { phase: 'intake', examined: 1, complete: page.complete, after },
      async trx =>
        await applySnapshotJournalProvenancePage(trx, binding, state, page, {
          maximumProvenanceRows: 10,
          maximumProvenanceBytes: 1048576
        })
    )
  }
  while (state.phase === 'intake') await advance({ phase: 'intake', examined: 0, complete: true })
  for (const _table of snapshotSyncTables)
    await advance({ phase: 'promoting', examined: 0, complete: true, promotionSequence: 0 })
  expect(state.phase).toBe('acknowledged')
  const read = async (after?: number) =>
    await db.transaction(async trx => await readSnapshotJournalProvenancePage(trx, binding, state, after, 2))
  const first = await read()
  expect(first.rows.map(row => row.incomingId)).toEqual(ids.slice(0, 2))
  expect(first.complete).toBe(false)
  const second = await read(first.after)
  expect(second.rows.map(row => row.incomingId)).toEqual(ids.slice(2))
  expect(second.complete).toBe(true)
  expect([...first.rows, ...second.rows].map(row => row.raw.syncStateId)).toEqual(ids)
  expect([...first.rows, ...second.rows].map(row => row.raw.syncMap)).toEqual(ids.map(id => 'independent\u0000雪' + id))
  expect((await read(0)).rows.map(row => row.incomingId)).toEqual([7])
  expect((await read(7)).rows).toEqual([])
  expect(await db.schema.hasTable('sync_states')).toBe(false)
})
