import {
  snapshotJournalCapturedIdentitiesDdl,
  readSnapshotJournalCapturedIdentities
} from './SnapshotJournalCapturedIdentities'
import { readSnapshotJournalNotificationMappings } from './SnapshotJournalDestinationIdentities'
import { brc38ImportTargetIndexName } from '../../portable/Brc38ImportTargetIndexes'
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
  retireSnapshotJournalDestinationWindow,
  replaceSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import {
  prepareSnapshotJournalIdentityLedger,
  snapshotJournalIdentityLedgerDdl,
  type SnapshotJournalIdentityReference
} from './SnapshotJournalIdentityLedger'

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

function reference(
  incomingId = 10,
  generation = '2',
  naturalIdentity = 'a'.repeat(64),
  required = false
): SnapshotJournalIdentityReference {
  return {
    tableId: 4,
    incomingId,
    generation: snapshotJournalRevision(generation),
    naturalIdentity,
    required
  }
}
async function write(reference: SnapshotJournalIdentityReference, localId: number, maximumMappings = 8): Promise<void> {
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference], {
      maximumMappings
    })
    await prepared.persist(new Map([['4:' + reference.incomingId, localId]]))
  })
}

test.each([0, 1, 3, null])('unsupported ledger version %s refuses before creating association DATA', async version => {
  await expect(
    db.transaction(
      async trx =>
        await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
          trx,
          binding,
          state,
          [reference()],
          { maximumMappings: 8, version }
        ])
    )
  ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
  expect(await db('snapshot_reconciliation_identity_maps')).toEqual([])
})

test.each(['generation', 'naturalIdentity', 'required'] as const)(
  'duplicate reference with conflicting %s cannot create an association',
  async field => {
    const first = reference(),
      second = { ...first, [field]: field === 'generation' ? '3' : field === 'naturalIdentity' ? 'b'.repeat(64) : true }
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            state,
            [first, second],
            { maximumMappings: 8 }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
    expect(await db('snapshot_reconciliation_identity_maps')).toEqual([])
  }
)

test('identical duplicate references consume exactly one mapping and one durable assignment', async () => {
  await db.transaction(async trx => {
    const first = reference(),
      prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [first, { ...first }], {
        maximumMappings: 1
      })
    await prepared.persist(new Map([['4:10', 701]]))
  })
  expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
  expect(await db('snapshot_reconciliation_identity_maps').select('localId')).toEqual([{ localId: 701 }])
})

test.each([false, true])(
  'independent association validation result %s controls reuse of the actual stored DATA',
  async valid => {
    await write(reference(), 701)
    await db.transaction(async trx => {
      const validate = jest.fn(
          async (actual: Knex, requested: SnapshotJournalIdentityReference, association: { localId: number }) => {
            expect(actual).toBe(trx)
            expect(requested).toEqual(reference())
            expect(association.localId).toBe(701)
            association.localId = 999
            return valid
          }
        ),
        prepared = await prepareSnapshotJournalIdentityLedger(
          trx,
          binding,
          state,
          [reference()],
          { maximumMappings: 8 },
          validate
        )
      expect(validate).toHaveBeenCalledTimes(1)
      expect(prepared.associations.get('4:10')?.localId).toBe(valid ? 701 : undefined)
      expect(prepared.previous.get('4:10')?.localId).toBe(valid ? undefined : 701)
      await prepared.persist(new Map([['4:10', valid ? 701 : 702]]))
    })
    expect(await db('snapshot_reconciliation_identity_maps').select('localId')).toEqual([
      { localId: valid ? 701 : 702 }
    ])
  }
)

test('bounded integer strings returned after actual SQLite reads retain the same durable association', async () => {
  await write(reference(), 701)
  const original = db.client.config.postProcessResponse
  db.client.config.postProcessResponse = response =>
    Array.isArray(response)
      ? response.map(row => {
          if (row === null || typeof row !== 'object') return row
          const copy = { ...row }
          for (const field of ['incomingId', 'localId', 'mappings', 'maximumMappings'])
            if (typeof copy[field] === 'number') copy[field] = String(copy[field])
          return copy
        })
      : response
  try {
    await db.transaction(async trx => {
      const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], {
        maximumMappings: 8
      })
      expect(prepared.associations.get('4:10')?.localId).toBe(701)
      await prepared.persist(new Map([['4:10', 701]]))
    })
  } finally {
    db.client.config.postProcessResponse = original
  }
  expect(await db('snapshot_reconciliation_identity_maps').select('localId')).toEqual([{ localId: 701 }])
})

test('ledger preflight requires a real supported transaction and backend', async () => {
  await expect(prepareSnapshotJournalIdentityLedger(db, binding, state, [], { maximumMappings: 8 })).rejects.toThrow(
    'Invalid, stale or exhausted journal identity ledger'
  )
  const original = db.client.config.client
  db.client.config.client = 'pg'
  try {
    expect(() => snapshotJournalIdentityLedgerDdl(db)).toThrow('Invalid, stale or exhausted journal identity ledger')
  } finally {
    db.client.config.client = original
  }
})

test.each(['mysql', 'mysql2'])(
  'installed %s query builders retain bounded ledger projections and refuse malformed driver DATA',
  async client => {
    // This is synthetic-wire SQL construction/negative DATA evidence, never
    // real MySQL, native ownership or a successful destination admission.
    const specimen = await db('snapshot_reconciliation_windows').first(),
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
              generation: '0',
              naturalIdentity: 'a'.repeat(64),
              sourceGeneration: 'b'.repeat(64),
              seenSession: state.sessionId
            }
          ]
        return []
      })
    fixture.db.client.config.client = client
    try {
      expect(snapshotJournalIdentityLedgerDdl(fixture.db).filter(sql => sql.startsWith('CREATE TABLE'))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC')
        ])
      )
      await expect(
        fixture.db.transaction(
          async trx =>
            await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], { maximumMappings: 8 })
        )
      ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
      const budget = fixture.events.find(sql => sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_BUDGETS`')),
        records = fixture.events.find(sql => sql.includes('FROM `SNAPSHOT_RECONCILIATION_IDENTITY_MAPS`'))
      expect(budget).toContain('OCTET_LENGTH(CAST(`MAXIMUMMAPPINGS` AS CHAR)) BETWEEN 1 AND 16')
      expect(records).toContain('OCTET_LENGTH(`NATURALIDENTITY`) BETWEEN ? AND ?')
      expect(records).toContain('OCTET_LENGTH(CAST(`LOCALID` AS CHAR)) BETWEEN 1 AND 16')
      expect(fixture.events.some(sql => /^(INSERT|UPDATE).*SNAPSHOT_RECONCILIATION_IDENTITY/.test(sql))).toBe(false)
      expect(fixture.events.at(-1)).toBe('RELEASE')
    } finally {
      await fixture.db.destroy()
    }
  }
)

test('keeps renumbered destination IDs for unchanged required parents', async () => {
  await write(reference(), 701)
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(
      trx,
      binding,
      state,
      [reference(10, '2', 'a'.repeat(64), true)],
      { maximumMappings: 8 }
    )
    expect(prepared.associations.get('4:10')).toEqual({
      generation: '2',
      naturalIdentity: 'a'.repeat(64),
      localId: 701
    })
    expect(prepared.previous.size).toBe(0)
    await prepared.persist(new Map([['4:10', 701]]))
  })
  expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
})

test('exposes a deleted and reused source ID without inheriting its previous local ID', async () => {
  await write(reference(), 701)
  await db('test_staged_rows').insert({ id: 701, value: 'independently shared old object' })
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(
      trx,
      binding,
      state,
      [reference(10, '3', 'b'.repeat(64))],
      { maximumMappings: 8 }
    )
    expect(prepared.associations.size).toBe(0)
    expect(prepared.previous.get('4:10')).toEqual({
      generation: '2',
      naturalIdentity: 'a'.repeat(64),
      localId: 701
    })
    await prepared.persist(new Map([['4:10', 702]]))
  })
  expect(await db('test_staged_rows')).toEqual([{ id: 701, value: 'independently shared old object' }])
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '3', localId: 702 }
  ])
})

test('requires exact acknowledged generation and natural identity for a parent', async () => {
  await write(reference(), 701)
  await expect(
    db.transaction(
      async trx =>
        await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference(10, '3', 'b'.repeat(64), true)], {
          maximumMappings: 8
        })
    )
  ).rejects.toThrow('Invalid, stale')
  expect(await db('snapshot_reconciliation_identity_maps').select('generation', 'localId')).toEqual([
    { generation: '2', localId: 701 }
  ])
})

test('reports a natural identity change even within the same physical generation', async () => {
  await write(reference(), 701)
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(
      trx,
      binding,
      state,
      [reference(10, '2', 'b'.repeat(64))],
      { maximumMappings: 8 }
    )
    expect(prepared.associations.size).toBe(0)
    expect(prepared.previous.get('4:10')?.localId).toBe(701)
    await prepared.persist(new Map([['4:10', 702]]))
  })
  expect(await db('snapshot_reconciliation_identity_maps').select('naturalIdentity', 'localId')).toEqual([
    { naturalIdentity: 'b'.repeat(64), localId: 702 }
  ])
})

test('outer rollback preserves the prior association and mapping charge', async () => {
  await write(reference(), 701)
  await expect(
    db.transaction(async trx => {
      const prepared = await prepareSnapshotJournalIdentityLedger(
        trx,
        binding,
        state,
        [reference(10, '3', 'b'.repeat(64)), reference(11)],
        { maximumMappings: 8 }
      )
      await prepared.persist(
        new Map([
          ['4:10', 702],
          ['4:11', 703]
        ])
      )
      throw new Error('identity rollback')
    })
  ).rejects.toThrow('identity rollback')
  expect(await db('snapshot_reconciliation_identity_maps').select('incomingId', 'generation', 'localId')).toEqual([
    { incomingId: 10, generation: '2', localId: 701 }
  ])
  expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test('a replacement owner sees a committed association after the reply was lost', async () => {
  await write(reference(), 701)
  const replacement = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    await replacement.transaction(async trx => {
      const prepared = await prepareSnapshotJournalIdentityLedger(
        trx,
        binding,
        state,
        [reference(10, '2', 'a'.repeat(64), true)],
        { maximumMappings: 8 }
      )
      expect(prepared.associations.get('4:10')?.localId).toBe(701)
      await prepared.persist(new Map([['4:10', 701]]))
    })
    expect(await replacement('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
  } finally {
    await replacement.destroy()
  }
})

test('capacity counts new keys while identity replacement preserves the existing charge', async () => {
  await write(reference(), 701, 1)
  await write(reference(10, '3', 'b'.repeat(64)), 702, 1)
  await expect(write(reference(11), 703, 1)).rejects.toThrow('Invalid, stale')
  expect(await db('snapshot_reconciliation_identity_maps').select('incomingId', 'localId')).toEqual([
    { incomingId: 10, localId: 702 }
  ])
  expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
})

test('canonical source identity is stable when equivalent input fields are reordered', async () => {
  await write(reference(), 701)
  const reordered: SnapshotJournalDestinationBinding = {
    ...binding,
    source: Object.fromEntries(Object.entries(binding.source).reverse()) as SnapshotJournalDestinationBinding['source']
  }
  const reorderedState = Object.fromEntries(
    Object.entries(state).reverse()
  ) as unknown as SnapshotJournalDestinationCheckpoint
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(
      trx,
      reordered,
      reorderedState,
      [reference(10, '2', 'a'.repeat(64), true)],
      { maximumMappings: 8 }
    )
    expect(prepared.associations.get('4:10')?.localId).toBe(701)
    await prepared.persist(new Map([['4:10', 701]]))
  })
  expect(await db('snapshot_reconciliation_identity_budgets')).toHaveLength(1)
})

test('V2 profile data survives source replacement but old IDs are not reusable current associations', async () => {
  await db('snapshot_reconciliation_windows').delete()
  binding = { ...binding, lineageVersion: 2 }
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
  await write(reference(10, '10'), 701)
  const previousBinding = binding,
    previousState = state
  const source = { ...binding.source, epoch: '22222222-2222-4333-8444-555555555555' }
  binding = {
    ...binding,
    bootstrap: true,
    source,
    low: snapshotJournalRevision('0'),
    receipt: {
      ...binding.receipt,
      requestId: '77'.repeat(32),
      binding: snapshotJournalReceiptBinding(source),
      highWater: snapshotJournalRevision('2')
    }
  }
  await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, previousBinding, previousState))
  state = await db.transaction(
    async trx =>
      await replaceSnapshotJournalDestinationWindow(
        trx,
        previousBinding,
        previousState,
        binding,
        '88'.repeat(32),
        async () => undefined
      )
  )
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
  const request = reference(10, '1')
  await db.transaction(async trx => {
    const actual = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [request], { maximumMappings: 8 })
    expect(actual.associations.size).toBe(0)
    expect(actual.previous.get(request.tableId + ':' + request.incomingId)?.localId).toBe(701)
    await actual.persist(new Map([[request.tableId + ':' + request.incomingId, 702]]))
  })
  await db.transaction(async trx => {
    const actual = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [{ ...request, required: true }], {
      maximumMappings: 8
    })
    expect(actual.associations.get(request.tableId + ':' + request.incomingId)?.localId).toBe(702)
  })
})

async function capturedRequestReferences() {
  for (const sql of snapshotJournalCapturedIdentitiesDdl(db)) await db.raw(sql)
  const frameDigest = 'f'.repeat(64),
    scope = {
      userId: binding.destinationUserId,
      sourceStorageIdentity: binding.source.storageIdentity,
      sessionId: state.sessionId,
      binding: state.binding,
      frameDigest
    },
    captured = (incomingId: number, tableId = 0, required = 1) => ({
      ...scope,
      changeIndex: 0,
      tableId,
      incomingId,
      generation: '2',
      naturalIdentity: 'a'.repeat(64),
      naturalKeyJson: JSON.stringify(
        tableId === 0 ? { tableId: 0, reference: 'transaction-' + incomingId } : { tableId, txid: String(incomingId) }
      ),
      required
    })
  await db('snapshot_reconciliation_identity_frames').insert({
    ...scope,
    windowSequence: 0,
    identities: 131,
    sealed: 1,
    changes: 1
  })
  for (let first = 1; first <= 129; first += 64) {
    await db('snapshot_reconciliation_captured_identities').insert(
      Array.from({ length: Math.min(64, 130 - first) }, (_, index) => captured(first + index))
    )
  }
  await db('snapshot_reconciliation_captured_identities').insert([captured(300, 8), captured(400, 9, 0)])
  return { scope, captured, frameDigest }
}
test('request captured point selection bounds notification batches and excludes them from scalar final maps', async () => {
  const { frameDigest } = await capturedRequestReferences()
  await db.transaction(async trx => {
    const first = await readSnapshotJournalCapturedIdentities(trx, binding, state, frameDigest, 0),
      points = await readSnapshotJournalCapturedIdentities(trx, binding, state, frameDigest, 0, undefined, {
        kind: 'transaction-points',
        ids: [129, 1, 129, 900]
      }),
      scalar = await readSnapshotJournalCapturedIdentities(trx, binding, state, frameDigest, 0, undefined, {
        kind: 'request-scalars'
      })
    expect(first).toHaveLength(128)
    expect(points.map(row => row.incomingId)).toEqual([1, 129])
    expect(scalar.map(row => [row.tableId, row.incomingId])).toEqual([
      [8, 300],
      [9, 400]
    ])
    await expect(
      readSnapshotJournalCapturedIdentities(trx, binding, state, frameDigest, 0, undefined, {
        kind: 'transaction-points',
        ids: Array.from({ length: 129 }, (_, id) => id + 1)
      })
    ).rejects.toThrow()
    await expect(
      readSnapshotJournalCapturedIdentities(trx, binding, state, frameDigest, 0, undefined, {
        kind: 'transaction-points',
        ids: [0]
      })
    ).rejects.toThrow()
    await expect(
      readSnapshotJournalCapturedIdentities(
        trx,
        binding,
        state,
        frameDigest,
        0,
        { tableId: 0, incomingId: 1 },
        { kind: 'transaction-points', ids: [2] }
      )
    ).rejects.toThrow()
  })
})
test('journal notification projection uses sealed current associations and refuses changed identity, profile and window', async () => {
  const { frameDigest, scope } = await capturedRequestReferences(),
    limit = { maximumMappings: 8 }
  await db.raw(
    'CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,reference TEXT NOT NULL,txid TEXT)'
  )
  await db.raw('CREATE INDEX ?? ON transactions(userId,txid)', [brc38ImportTargetIndexName('transactions')])
  await db.raw('CREATE INDEX ?? ON transactions(userId,reference)', [
    brc38ImportTargetIndexName('transactionReference')
  ])
  await db('transactions').insert([
    { transactionId: 701, userId: 7, reference: 'transaction-1' },
    { transactionId: 702, userId: 7, reference: 'transaction-129' }
  ])
  for (const [incomingId, localId] of [
    [1, 701],
    [129, 702]
  ])
    await db.transaction(async trx => {
      const prepared = await prepareSnapshotJournalIdentityLedger(
        trx,
        binding,
        state,
        [
          {
            tableId: 0,
            incomingId,
            generation: snapshotJournalRevision('2'),
            naturalIdentity: 'a'.repeat(64),
            required: false
          }
        ],
        limit
      )
      await prepared.persist(new Map([['0:' + incomingId, localId]]))
    })
  const statements: string[] = [],
    observe = (query: { sql: string }) => {
      statements.push(query.sql)
    }
  db.on('query', observe)
  try {
    const read = async (ids: number[] = [129, 1, 900, 129, 0, -1, Number.MAX_SAFE_INTEGER + 1]) =>
      await db.transaction(
        async trx => await readSnapshotJournalNotificationMappings(trx, binding, state, frameDigest, 0, 1, ids, limit)
      )
    expect(await read()).toEqual([702, 701, undefined, 702, undefined, undefined, undefined])
    expect(statements.some(sql => sql.includes('snapshot_sync_ids'))).toBe(false)
    await expect(read([2])).rejects.toThrow('identity ledger')
    await db('transactions').where('transactionId', 701).update({ userId: 8 })
    await expect(read([1])).rejects.toThrow('association')
    await db('transactions').where('transactionId', 701).update({ userId: 7 })
    await db('snapshot_reconciliation_captured_identities')
      .where({ ...scope, changeIndex: 0, tableId: 0, incomingId: 1 })
      .update({ generation: '3' })
    await expect(read([1])).rejects.toThrow()
    await db('snapshot_reconciliation_captured_identities')
      .where({ ...scope, changeIndex: 0, tableId: 0, incomingId: 1 })
      .update({ generation: '2' })
    await db('snapshot_reconciliation_identity_frames').where(scope).update({ sealed: 0 })
    await expect(read([1])).rejects.toThrow('captured')
    await db('snapshot_reconciliation_identity_frames').where(scope).update({ sealed: 1 })
    expect(await read([1, 129])).toEqual([701, 702])
    await db('users').where('userId', 7).update({ activeStorage: 'another primary' })
    await expect(read([1])).rejects.toThrow('window')
  } finally {
    db.off('query', observe)
  }
})

test('ledger refuses a supplied cursor that differs from the actual promoting checkpoint', async () => {
  await expect(
    db.transaction(
      async trx =>
        await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
          trx,
          binding,
          { ...state, after: { revision: '2', id1: 10, id2: 0 } },
          [],
          { maximumMappings: 8 }
        ])
    )
  ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
})
test('explicit V2 ledger capacity above the original V1 ceiling persists only bounded association DATA', async () => {
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [], {
      maximumMappings: 5000,
      version: 2
    })
    await prepared.persist(new Map())
  })
  expect(await db('snapshot_reconciliation_identity_budgets').select('maximumMappings', 'mappings')).toEqual([
    { maximumMappings: 5000, mappings: 0 }
  ])
})

test('association validation cannot rewrite the owned source identity that will be durably persisted', async () => {
  await write(reference(), 701)
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(
      trx,
      binding,
      state,
      [reference()],
      { maximumMappings: 8 },
      async (_actual, requested, association) => {
        expect(requested).toEqual(reference())
        requested.naturalIdentity = 'b'.repeat(64)
        association.localId = 999
        return true
      }
    )
    expect(prepared.associations.get('4:10')?.localId).toBe(701)
    await prepared.persist(new Map([['4:10', 701]]))
  })
  expect(await db('snapshot_reconciliation_identity_maps').select('naturalIdentity', 'localId')).toEqual([
    { naturalIdentity: 'a'.repeat(64), localId: 701 }
  ])
})

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
  'invalid incoming identity %s refuses before creating ledger DATA',
  async incomingId => {
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            state,
            [{ ...reference(), incomingId }],
            { maximumMappings: 8 }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
    expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
  }
)
test.each([0, -1, 1.5, NaN, Infinity, 4097, '8', null])(
  'invalid V1 mapping capacity %s refuses before ledger writes',
  async maximumMappings => {
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            state,
            [],
            { maximumMappings }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
    expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
  }
)
test.each(['0', '1001'])(
  'reference generation %s cannot cross the current pinned source interval',
  async generation => {
    await expect(
      db.transaction(
        async trx =>
          await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference(10, generation)], {
            maximumMappings: 8
          })
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  }
)
test.each(['', 'a'.repeat(63), 'a'.repeat(65), 'x' + 'a'.repeat(64), 'a'.repeat(64) + 'x', 'A'.repeat(64), 1, null])(
  'noncanonical natural identity %s refuses before creating an association',
  async naturalIdentity => {
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            state,
            [{ ...reference(), naturalIdentity }],
            { maximumMappings: 8 }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  }
)
test.each([{ tableId: 7 }, { tableId: -1 }, { required: 'true' }])(
  'unsupported reference DATA %j cannot enter the ledger',
  async patch => {
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            state,
            [{ ...reference(), ...patch }],
            { maximumMappings: 8 }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  }
)
test.each([1, Number.MAX_SAFE_INTEGER])('exact safe identity boundary %s persists without rounding', async id => {
  await write(reference(id, '1000'), id)
  expect(await db('snapshot_reconciliation_identity_maps').select('incomingId', 'localId', 'generation')).toEqual([
    { incomingId: id, localId: id, generation: '1000' }
  ])
})
test.each([4096, 2147483647])(
  'exact versioned capacity %s and zero associations remain usable after reopen',
  async maximumMappings => {
    const limits = maximumMappings === 4096 ? { maximumMappings } : { maximumMappings, version: 2 as const }
    for (let attempt = 0; attempt < 2; attempt++)
      await db.transaction(async trx => {
        const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [], limits)
        await prepared.persist(new Map())
      })
    expect(await db('snapshot_reconciliation_identity_budgets').select('maximumMappings', 'mappings')).toEqual([
      { maximumMappings, mappings: 0 }
    ])
  }
)
test('exact256 references retain the original128-row lookup batches and reject257', async () => {
  const references = Array.from({ length: 256 }, (_, index) => reference(index + 1)),
    queries: string[] = [],
    observe = (query: { sql: string }) => {
      queries.push(query.sql)
    }
  db.on('query', observe)
  try {
    await db.transaction(async trx => {
      const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, references, {
        maximumMappings: 256
      })
      await prepared.persist(new Map(references.map(value => ['4:' + value.incomingId, 1000 + value.incomingId])))
    })
  } finally {
    db.off('query', observe)
  }
  expect(queries.filter(sql => sql.startsWith('select') && sql.includes('`incomingId` in ('))).toHaveLength(2)
  expect(await db('snapshot_reconciliation_identity_maps').count('* as count')).toEqual([{ count: 256 }])
  await expect(
    db.transaction(
      async trx =>
        await prepareSnapshotJournalIdentityLedger(trx, binding, state, [...references, reference(257)], {
          maximumMappings: 257
        })
    )
  ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
})
test.each(['version', 'sessionId', 'binding', 'sequence', 'phase', 'streamIndex', 'tableIndex', 'promotionSequence'])(
  'the actual window independently rejects a changed expected %s',
  async field => {
    const actual = Reflect.get(state, field),
      changed = typeof actual === 'number' ? actual + 1 : field === 'phase' ? 'acknowledged' : 'b'.repeat(64)
    await expect(
      db.transaction(
        async trx =>
          await Reflect.apply(prepareSnapshotJournalIdentityLedger, undefined, [
            trx,
            binding,
            { ...state, [field]: changed },
            [],
            { maximumMappings: 8 }
          ])
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
    expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
  }
)
test.each(['missing', 'intake'] as const)('an actual %s destination window grants no promoting ledger', async phase => {
  await db('snapshot_reconciliation_windows').delete()
  const expected = phase === 'intake' ? await begin() : state
  await expect(
    db.transaction(
      async trx => await prepareSnapshotJournalIdentityLedger(trx, binding, expected, [], { maximumMappings: 8 })
    )
  ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
})
test.each([
  ['maximumMappings', null],
  ['maximumMappings', 9],
  ['maximumMappings', 8.5],
  ['mappings', null],
  ['mappings', -1],
  ['mappings', 9],
  ['mappings', 1.5],
  ['mappings', '00']
])('actual budget SQL followed by malformed %s DATA %s refuses reuse', async (field, value) => {
  await write(reference(), 701)
  const original = db.client.config.postProcessResponse
  db.client.config.postProcessResponse = response =>
    Array.isArray(response)
      ? response.map(row =>
          row !== null && typeof row === 'object' && Object.hasOwn(row, 'maximumMappings')
            ? { ...row, [String(field)]: value }
            : row
        )
      : response
  try {
    await expect(
      db.transaction(
        async trx =>
          await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], { maximumMappings: 8 })
      )
    ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
  } finally {
    db.client.config.postProcessResponse = original
  }
  expect(await db('snapshot_reconciliation_identity_budgets').select('maximumMappings', 'mappings')).toEqual([
    { maximumMappings: 8, mappings: 1 }
  ])
})
test.each(['budget-duplicate', 'record-duplicate', 'unrequested', 'zero-generation', 'future-generation'] as const)(
  'actual ledger reads reject inconsistent returned DATA: %s',
  async kind => {
    await write(reference(), 701)
    const original = db.client.config.postProcessResponse
    db.client.config.postProcessResponse = response => {
      if (!Array.isArray(response) || response.length === 0) return response
      if (kind === 'budget-duplicate' && Object.hasOwn(response[0], 'maximumMappings'))
        return [...response, { ...response[0] }]
      if (!Object.hasOwn(response[0], 'localId')) return response
      if (kind === 'record-duplicate') return [response[0], { ...response[0] }]
      if (kind === 'unrequested') return response.map(row => ({ ...row, incomingId: 999 }))
      if (kind === 'zero-generation' || kind === 'future-generation')
        return response.map(row => ({ ...row, generation: kind === 'zero-generation' ? '0' : '3' }))
      return response
    }
    try {
      await expect(
        db.transaction(
          async trx =>
            await prepareSnapshotJournalIdentityLedger(
              trx,
              binding,
              state,
              kind === 'record-duplicate' ? [reference(), reference(11)] : [reference()],
              { maximumMappings: 8 }
            )
        )
      ).rejects.toThrow('Invalid, stale or exhausted journal identity ledger')
    } finally {
      db.client.config.postProcessResponse = original
    }
  }
)
test.each(['empty', 'extra', 'wrong-key', 'different-reuse', 'lookalike'] as const)(
  'invalid assignment map %s cannot rewrite the durable association',
  async kind => {
    await write(reference(), 701)
    const assignments: unknown =
      kind === 'empty'
        ? new Map()
        : kind === 'extra'
          ? new Map([
              ['4:10', 701],
              ['4:11', 702]
            ])
          : kind === 'wrong-key'
            ? new Map([['4:11', 701]])
            : kind === 'different-reuse'
              ? new Map([['4:10', 702]])
              : { size: 1, entries: () => [['4:10', 701]] }
    await expect(
      db.transaction(async trx => {
        const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], {
          maximumMappings: 8
        })
        await Reflect.apply(prepared.persist, undefined, [assignments])
      })
    ).rejects.toThrow()
    expect(await db('snapshot_reconciliation_identity_maps').select('localId')).toEqual([{ localId: 701 }])
  }
)
test.each(['window', 'budget'] as const)(
  'persistence rechecks actual %s SQL and rolls back both mapping and budget',
  async kind => {
    await expect(
      db.transaction(async trx => {
        const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], {
          maximumMappings: 8
        })
        if (kind === 'window') await trx('snapshot_reconciliation_windows').increment('sequence', 1)
        else await trx('snapshot_reconciliation_identity_budgets').update({ mappings: 1 })
        await prepared.persist(new Map([['4:10', 701]]))
      })
    ).rejects.toThrow()
    expect(await db('snapshot_reconciliation_identity_maps')).toEqual([])
    expect(await db('snapshot_reconciliation_identity_budgets')).toEqual([])
  }
)
test('a prepared persistence operation cannot be consumed twice', async () => {
  await db.transaction(async trx => {
    const prepared = await prepareSnapshotJournalIdentityLedger(trx, binding, state, [reference()], {
      maximumMappings: 8
    })
    await prepared.persist(new Map([['4:10', 701]]))
    await expect(prepared.persist(new Map([['4:10', 701]]))).rejects.toThrow(
      'Invalid, stale or exhausted journal identity ledger'
    )
  })
  expect(await db('snapshot_reconciliation_identity_budgets').select('mappings')).toEqual([{ mappings: 1 }])
})
