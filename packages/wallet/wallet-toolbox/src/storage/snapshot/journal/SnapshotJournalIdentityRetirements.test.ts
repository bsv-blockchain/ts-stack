import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mysqlReadSnapshotFixture } from '../../../../test/utils/mysqlReadSnapshotFixture'
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
  snapshotJournalIdentityLedgerDdl,
  type SnapshotJournalIdentityReference
} from './SnapshotJournalIdentityLedger'
import {
  applySnapshotJournalIdentityTransition,
  snapshotJournalIdentityRetirementsDdl
} from './SnapshotJournalIdentityRetirements'

jest.setTimeout(30000)
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
      expiresAt: Date.now() + 60000
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

function reference(id = 10, generation = '2', identity = 'a'.repeat(64)): SnapshotJournalIdentityReference {
  return {
    tableId: 4,
    incomingId: id,
    generation: snapshotJournalRevision(generation),
    naturalIdentity: identity,
    required: false
  }
}
async function replace(
  reference: SnapshotJournalIdentityReference,
  localId: number,
  maximumPendingAssociations = 8
): Promise<void> {
  await db.transaction(
    async trx =>
      await applySnapshotJournalIdentityTransition(
        trx,
        binding,
        state,
        [reference],
        { maximumMappings: 8, maximumPendingAssociations },
        async () => ({
          assignments: new Map([['4:' + reference.incomingId, localId]]),
          result: undefined
        })
      )
  )
}

test.each([0, 1, 3, null])(
  'unsupported retirement version %s refuses without invoking semantic merge',
  async version => {
    const merge = jest.fn(async () => ({ assignments: new Map<string, number>(), result: undefined }))
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(applySnapshotJournalIdentityTransition, undefined, [
            trx,
            binding,
            state,
            [],
            { maximumMappings: 8, maximumPendingAssociations: 8, version },
            merge
          ])
      )
    ).rejects.toThrow('Invalid or exhausted journal identity retirement custody')
    expect(merge).not.toHaveBeenCalled()
    expect(await db('snapshot_reconciliation_identity_retirement_budgets')).toEqual([])
  }
)

test.each(['mysql', 'mysql2'])(
  'installed %s query builders bound retirement DATA and reject damaged prior custody before merge',
  async client => {
    // Only SQL construction and negative synthetic driver DATA are asserted.
    // Real server, source/native ownership and final custody qualification stay separate.
    const specimen = await db('snapshot_reconciliation_windows').first(),
      merge = jest.fn(async () => ({ assignments: new Map<string, number>(), result: undefined })),
      fixture = mysqlReadSnapshotFixture(undefined, [], sql => {
        if (sql.startsWith('UPDATE')) return { affectedRows: 1 }
        if (sql.includes('FROM `USERS`')) return [{ userId: 7, activeStorage: binding.activeStorage }]
        if (sql.includes('FROM `SETTINGS`')) return [{ storageIdentityKey: 'destination', chain: 'mock' }]
        if (sql.includes('FROM `SNAPSHOT_SYNC_PRIMARY_EPOCHS`')) return [{ epoch: '0' }]
        if (sql.includes('UNIX_TIMESTAMP')) return [{ now: Date.now() }]
        if (sql.includes('FROM `SNAPSHOT_RECONCILIATION_WINDOWS`')) return [specimen]
        if (sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_BUDGETS`'))
          return [{ maximumMappings: '8', mappings: '1' }]
        if (sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_MAPS`'))
          return [
            {
              incomingId: '10',
              localId: '701',
              generation: '2',
              naturalIdentity: 'b'.repeat(64),
              sourceGeneration: 'b'.repeat(64),
              seenSession: state.sessionId
            }
          ]
        if (sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_RETIREMENT_BUDGETS`'))
          return [{ maximumPendingAssociations: '8', pendingAssociations: '1' }]
        if (sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_RETIREMENTS`'))
          return [{ retiredBySession: 'damaged session', retiredAtSequence: '0' }]
        return []
      })
    fixture.db.client.config.client = client
    try {
      expect(snapshotJournalIdentityRetirementsDdl(fixture.db).filter(sql => sql.startsWith('CREATE TABLE'))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC')
        ])
      )
      await expect(
        fixture.db.transaction(
          async trx =>
            await applySnapshotJournalIdentityTransition(
              trx,
              binding,
              state,
              [reference()],
              { maximumMappings: 8, maximumPendingAssociations: 8, version: 2 },
              merge
            )
        )
      ).rejects.toThrow('Invalid or exhausted journal identity retirement custody')
      const budget = fixture.events.find(sql =>
          sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_RETIREMENT_BUDGETS`')
        ),
        queue = fixture.events.find(sql => sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_RETIREMENTS`'))
      expect(budget).toContain('OCTET_LENGTH(CAST(`PENDINGASSOCIATIONS` AS CHAR)) BETWEEN 1 AND 16')
      expect(queue).toContain('OCTET_LENGTH(`RETIREDBYSESSION`)=64')
      expect(queue).toContain('OCTET_LENGTH(CAST(`RETIREDATSEQUENCE` AS CHAR)) BETWEEN 1 AND 16')
      expect(merge).not.toHaveBeenCalled()
      expect(fixture.events.some(sql => /^(INSERT|UPDATE).*SNAPSHOT_RECONCILIATION_IDENTITY/.test(sql))).toBe(false)
      expect(fixture.events.at(-1)).toBe('RELEASE')
    } finally {
      await fixture.db.destroy()
    }
  }
)

test('durably records the prior association before a committed replacement', async () => {
  await replace(reference(), 701)
  await replace(reference(10, '3', 'b'.repeat(64)), 702)
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '3', localId: 702 }
  ])
  expect(
    await db('snapshot_reconciliation_identity_retirements').select(
      'incomingId',
      'generation',
      'naturalIdentity',
      'localId',
      'retiredBySession',
      'retiredAtSequence'
    )
  ).toEqual([
    {
      incomingId: 10,
      generation: '2',
      naturalIdentity: 'a'.repeat(64),
      localId: 701,
      retiredBySession: sessionId,
      retiredAtSequence: state.sequence
    }
  ])
  expect(await db('snapshot_reconciliation_identity_retirement_budgets').select('pendingAssociations')).toEqual([
    { pendingAssociations: 1 }
  ])
})

test('a caught semantic failure rolls back its savepoint while unrelated outer work commits', async () => {
  await replace(reference(), 701)
  await db.transaction(async trx => {
    await expect(
      applySnapshotJournalIdentityTransition(
        trx,
        binding,
        state,
        [reference(10, '3', 'b'.repeat(64))],
        { maximumMappings: 8, maximumPendingAssociations: 8 },
        async inner => {
          await inner('test_staged_rows').insert({ id: 99, value: 'uncommitted semantic change' })
          throw new Error('semantic merge refused')
        }
      )
    ).rejects.toThrow('semantic merge refused')
    await trx('test_staged_rows').insert({ id: 100, value: 'independent outer work' })
  })
  expect(await db('test_staged_rows')).toEqual([{ id: 100, value: 'independent outer work' }])
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '2', localId: 701 }
  ])
  expect(await db('snapshot_reconciliation_identity_retirements')).toEqual([])
  expect(await db('snapshot_reconciliation_identity_retirement_budgets').select('pendingAssociations')).toEqual([
    { pendingAssociations: 0 }
  ])
})

test('preserves a shared destination object and its other active source association', async () => {
  await replace(reference(), 701)
  await replace(reference(11), 701)
  await db('test_staged_rows').insert({ id: 701, value: 'shared object' })
  await replace(reference(10, '3', 'b'.repeat(64)), 702)
  expect(await db('test_staged_rows')).toEqual([{ id: 701, value: 'shared object' }])
  expect(
    await db('snapshot_reconciliation_identity_maps').select('incomingId', 'localId').orderBy('incomingId')
  ).toEqual([
    { incomingId: 10, localId: 702 },
    { incomingId: 11, localId: 701 }
  ])
  expect(await db('snapshot_reconciliation_identity_retirements').select('incomingId', 'localId')).toEqual([
    { incomingId: 10, localId: 701 }
  ])
})

test('repeated retirement of the identical old association does not reset or double-charge it', async () => {
  await replace(reference(), 701, 2)
  await replace(reference(10, '2', 'b'.repeat(64)), 702, 2)
  await replace(reference(), 701, 2)
  await replace(reference(10, '2', 'b'.repeat(64)), 702, 2)
  expect(await db('snapshot_reconciliation_identity_retirements').select('localId').orderBy('localId')).toEqual([
    { localId: 701 },
    { localId: 702 }
  ])
  expect(await db('snapshot_reconciliation_identity_retirement_budgets').select('pendingAssociations')).toEqual([
    { pendingAssociations: 2 }
  ])
})

test('a full retirement allowance refuses before semantic callback and preserves the current map', async () => {
  await replace(reference(), 701, 1)
  await replace(reference(10, '3', 'b'.repeat(64)), 702, 1)
  let callbacks = 0
  await expect(
    db.transaction(
      async trx =>
        await applySnapshotJournalIdentityTransition(
          trx,
          binding,
          state,
          [reference(10, '4', 'c'.repeat(64))],
          { maximumMappings: 8, maximumPendingAssociations: 1 },
          async () => {
            callbacks++
            return { assignments: new Map([['4:10', 703]]), result: undefined }
          }
        )
    )
  ).rejects.toThrow('Invalid or exhausted')
  expect(callbacks).toBe(0)
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '3', localId: 702 }
  ])
  expect(await db('snapshot_reconciliation_identity_retirements').select('localId')).toEqual([{ localId: 701 }])
})

test('replacement connection recovers committed retirement custody after a lost reply', async () => {
  await replace(reference(), 701)
  await replace(reference(10, '3', 'b'.repeat(64)), 702)
  const other = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    expect(await other('snapshot_reconciliation_identity_retirements').select('generation', 'localId')).toEqual([
      { generation: '2', localId: 701 }
    ])
    await other.transaction(
      async trx =>
        await applySnapshotJournalIdentityTransition(
          trx,
          binding,
          state,
          [reference(10, '3', 'b'.repeat(64))],
          { maximumMappings: 8, maximumPendingAssociations: 8 },
          async (_inner, associations) => {
            expect(associations.get('4:10')?.localId).toBe(702)
            return { assignments: new Map([['4:10', 702]]), result: undefined }
          }
        )
    )
    expect(await other('snapshot_reconciliation_identity_retirement_budgets').select('pendingAssociations')).toEqual([
      { pendingAssociations: 1 }
    ])
  } finally {
    await other.destroy()
  }
})

test('outer window rollback couples association replacement, custody and checkpoint', async () => {
  await replace(reference(), 701)
  await expect(
    db.transaction(async trx => {
      await advanceSnapshotJournalDestinationWindow(
        trx,
        binding,
        state,
        { phase: 'promoting', examined: 1, complete: false, promotionSequence: 1 },
        async inner =>
          await applySnapshotJournalIdentityTransition(
            inner,
            binding,
            state,
            [reference(10, '3', 'b'.repeat(64))],
            { maximumMappings: 8, maximumPendingAssociations: 8 },
            async () => ({ assignments: new Map([['4:10', 702]]), result: undefined })
          )
      )
      throw new Error('outer checkpoint rollback')
    })
  ).rejects.toThrow('outer checkpoint rollback')
  expect(await db('snapshot_reconciliation_identity_retirements')).toEqual([])
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '2', localId: 701 }
  ])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test.each(['selection', 'away-and-back', 'epoch'] as const)(
  'a primary %s change during semantic work refuses and restores the savepoint',
  async change => {
    await replace(reference(), 701)
    await expect(
      db.transaction(
        async trx =>
          await applySnapshotJournalIdentityTransition(
            trx,
            binding,
            state,
            [reference(10, '3', 'b'.repeat(64))],
            { maximumMappings: 8, maximumPendingAssociations: 8 },
            async inner => {
              if (change === 'epoch') await inner('snapshot_sync_primary_epochs').insert({ userId: 7, epoch: 1 })
              else {
                await inner('users').where('userId', 7).update({ activeStorage: 'changed' })
                if (change === 'away-and-back')
                  await inner('users').where('userId', 7).update({ activeStorage: 'destination' })
              }
              return { assignments: new Map([['4:10', 702]]), result: undefined }
            }
          )
      )
    ).rejects.toThrow('Invalid or stale')
    expect(await db('users').select('activeStorage')).toEqual([{ activeStorage: 'destination' }])
    expect(await db('snapshot_sync_primary_epochs')).toEqual([])
    expect(await db('snapshot_reconciliation_identity_retirements')).toEqual([])
    expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
      { generation: '2', localId: 701 }
    ])
  }
)

test('retirement refuses a supplied cursor outside the actual promoting checkpoint before merge', async () => {
  const merge = jest.fn(async () => ({ assignments: new Map<string, number>(), result: undefined }))
  await expect(
    db.transaction(
      async trx =>
        await Reflect.apply(applySnapshotJournalIdentityTransition, undefined, [
          trx,
          binding,
          { ...state, after: { revision: '2', id1: 10, id2: 0 } },
          [],
          { maximumMappings: 8, maximumPendingAssociations: 8 },
          merge
        ])
    )
  ).rejects.toThrow('Invalid or stale journal destination window')
  expect(merge).not.toHaveBeenCalled()
})
