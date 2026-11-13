import { createHash } from 'node:crypto'
import { encodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import {
  snapshotJournalCapturedIdentitiesDdl,
  sealSnapshotJournalCapturedFrame
} from './SnapshotJournalCapturedIdentities'
import {
  snapshotJournalDestinationPromotionDdl,
  promoteSnapshotJournalDestinationFieldBatch,
  promoteSnapshotJournalDestinationBatch,
  readSnapshotJournalPromotionCursor
} from './SnapshotJournalDestinationPromotion'
import type { SnapshotJournalHashedFieldPage } from './SnapshotJournalFieldTypes'
import { decodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import {
  stageSnapshotJournalDestinationFieldPage,
  readSnapshotJournalDestinationFieldPromotionPage
} from './SnapshotJournalDestinationStage'
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
const limits = { maximumBytes: 1048576, maximumPages: 256 }
const tableNames: SnapshotJournalDeltaPage['table'][] = [
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

async function stage(state: SnapshotJournalDestinationCheckpoint, page = rawPage()) {
  return await db.transaction(async trx => await stageSnapshotJournalDestinationPage(trx, binding, state, page, limits))
}

async function intake(): Promise<SnapshotJournalDestinationCheckpoint> {
  let state = await begin()
  for (let index = 0; index < 15; index++) {
    const tableId = index < 13 ? index : index === 13 ? 8 : 9
    const page: SnapshotJournalDeltaPage = {
      table: tableNames[tableId],
      changes: [],
      examined: 0,
      payloadBytes: 0,
      complete: true
    }
    if (index === 8) {
      const metadata = {
        revision: snapshotJournalRevision('3'),
        id1: 7,
        id2: 0,
        exactText: '',
        present: true
      }
      page.changes = [
        {
          metadata,
          present: true,
          row: { provenTxId: 7, rawTx: Uint8Array.of(0, 128, 255), nullable: null }
        }
      ]
      page.examined = 1
      page.payloadBytes = 1024
      page.after = { revision: metadata.revision, id1: 7, id2: 0, exactText: '' }
    }
    state = (await stage(state, page)).checkpoint
  }
  expect(state.phase).toBe('promoting')
  return state
}
test('committed raw frame, exact charge and intake checkpoint share durable actual custody', async () => {
  const state = await begin(),
    data = rawPage()
  const result = await stage(state, data)
  expect(result.checkpoint).toMatchObject({ sequence: 1, streamIndex: 1, phase: 'intake' })
  const rows = await db('snapshot_reconciliation_stage_pages').select()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    userId: 7,
    sourceStorageIdentity: 'source',
    sessionId,
    binding: state.binding,
    sequence: 1,
    streamIndex: 0,
    tableId: 0,
    examined: 1,
    bytes: result.result.bytes,
    digest: result.result.digest
  })
  expect(decodeSnapshotJournalDeltaFrame(rows[0].payload, { stream: 'scope', tableId: 0 })).toEqual(data)
  expect(await db('snapshot_reconciliation_stage_budgets').select()).toEqual([
    {
      userId: 7,
      sourceStorageIdentity: 'source',
      sessionId,
      binding: state.binding,
      ...limits,
      bytes: rows[0].payload.byteLength,
      pages: 1
    }
  ])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
    result.checkpoint
  )
})

test('lost committed response recovers using a new database owner and duplicate intake cannot charge or write twice', async () => {
  const state = await begin()
  await expect(
    stage(state).then(() => {
      throw new Error('Synthetic lost committed staging response')
    })
  ).rejects.toThrow('lost committed')
  const replacement = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    const recovered = await replacement.transaction(
      async trx => await readSnapshotJournalDestinationWindow(trx, binding)
    )
    expect(recovered).toMatchObject({ sequence: 1, streamIndex: 1 })
    await expect(
      replacement.transaction(
        async trx => await stageSnapshotJournalDestinationPage(trx, binding, state, rawPage(), limits)
      )
    ).rejects.toThrow('Invalid or stale')
    expect(await replacement('snapshot_reconciliation_stage_pages').count({ n: '*' })).toEqual([{ n: 1 }])
    expect(await replacement('snapshot_reconciliation_stage_budgets').select('pages')).toEqual([{ pages: 1 }])
  } finally {
    await replacement.destroy()
  }
})

test('outer transaction rollback removes the frame and charge while retaining the earlier committed checkpoint', async () => {
  const state = await begin()
  await expect(
    db.transaction(async trx => {
      await stageSnapshotJournalDestinationPage(trx, binding, state, rawPage(), limits)
      throw new Error('Synthetic post-stage rollback')
    })
  ).rejects.toThrow('post-stage rollback')
  expect(await db('snapshot_reconciliation_stage_pages')).toEqual([])
  expect(await db('snapshot_reconciliation_stage_budgets')).toEqual([])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test('persisted byte/page ceilings and original policy cannot be exceeded or changed after intake', async () => {
  const state = await begin()
  await expect(
    db.transaction(
      async trx =>
        await stageSnapshotJournalDestinationPage(trx, binding, state, rawPage(), {
          ...limits,
          maximumBytes: 1
        })
    )
  ).rejects.toThrow('Invalid or exhausted')
  expect(await db('snapshot_reconciliation_stage_budgets')).toEqual([])
  const first = await db.transaction(
    async trx =>
      await stageSnapshotJournalDestinationPage(trx, binding, state, rawPage(), {
        ...limits,
        maximumPages: 1
      })
  )
  const nextPage: SnapshotJournalDeltaPage = {
    table: 'outputs',
    changes: [],
    examined: 0,
    payloadBytes: 0,
    complete: true
  }
  await expect(
    db.transaction(
      async trx =>
        await stageSnapshotJournalDestinationPage(trx, binding, first.checkpoint, nextPage, {
          ...limits,
          maximumPages: 1
        })
    )
  ).rejects.toThrow('Invalid or exhausted')
  await expect(stage(first.checkpoint, nextPage)).rejects.toThrow('Invalid or exhausted')
  expect(await db('snapshot_reconciliation_stage_pages').count({ n: '*' })).toEqual([{ n: 1 }])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(
    first.checkpoint
  )
})

test('page bytes, source receipt, checkpoint and limit inputs are owned before asynchronous writer reads', async () => {
  const state = await begin(),
    data = rawPage(),
    mutableBinding = structuredClone(binding),
    mutableState = structuredClone(state),
    mutableLimits = { ...limits }
  await db.transaction(async trx => {
    const pending = stageSnapshotJournalDestinationPage(trx, mutableBinding, mutableState, data, mutableLimits)
    mutableBinding.source.storageIdentity = 'caller replacement'
    mutableBinding.receipt.highWater = snapshotJournalRevision('99')
    mutableState.sessionId = '00'.repeat(32)
    mutableLimits.maximumBytes = 1
    if (!data.changes[0].present) throw new Error('Expected raw row')
    ;(data.changes[0].row.rawTx as Uint8Array).fill(42)
    data.changes[0].row.nullable = 'changed'
    data.examined = 0
    await pending
  })
  const rows = await db('snapshot_reconciliation_stage_pages').select('payload')
  const decoded = decodeSnapshotJournalDeltaFrame(rows[0].payload, { stream: 'scope', tableId: 0 })
  expect(decoded).toEqual(rawPage())
})

test('one promotion read uses actual dependency order, keeps raw nulls and includes physical pages without promoting syncStates', async () => {
  const state = await intake()
  const first = await db.transaction(
    async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
  )
  expect(first).toMatchObject({
    receipt: { sequence: 9, streamIndex: 8, tableId: 8, examined: 1 },
    page: { table: 'provenTxs' }
  })
  if (first === undefined || !first.page.changes[0].present) throw new Error('Expected raw proven transaction')
  expect(first.page.changes[0].row.nullable).toBeNull()
  const progressed = await db.transaction(
    async trx =>
      await advanceSnapshotJournalDestinationWindow(
        trx,
        binding,
        state,
        {
          phase: 'promoting',
          examined: 1,
          complete: false,
          promotionSequence: first.receipt.sequence
        },
        async () => undefined
      )
  )
  const physical = await db.transaction(
    async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, progressed.checkpoint)
  )
  expect(physical).toMatchObject({
    receipt: { sequence: 14, streamIndex: 13, tableId: 8 },
    page: { table: 'provenTxs', changes: [] }
  })
  expect(await db('snapshot_reconciliation_stage_pages').where({ tableId: 7 }).count({ n: '*' })).toEqual([{ n: 1 }])
})

test('stored frame digest corruption rejects before raw decoding or any entity promotion', async () => {
  const state = await intake()
  const rows = await db('snapshot_reconciliation_stage_pages').where({ sequence: 9 }).select('payload')
  const changed = Buffer.from(rows[0].payload)
  changed[changed.length - 1] ^= 1
  await db('snapshot_reconciliation_stage_pages').where({ sequence: 9 }).update({ payload: changed })
  await expect(
    db.transaction(async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, state))
  ).rejects.toThrow('Invalid or exhausted')
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test('oversized stored payload is rejected by metadata before the bounded payload query', async () => {
  const state = await intake()
  await db('snapshot_reconciliation_stage_pages')
    .where({ sequence: 9 })
    .update({ payload: Buffer.alloc(1048577) })
  const queries: string[] = []
  const capture = (query: { sql: string }) => {
    queries.push(query.sql)
  }
  db.on('query', capture)
  try {
    await expect(
      db.transaction(async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, state))
    ).rejects.toThrow('Invalid or exhausted')
  } finally {
    db.removeListener('query', capture)
  }
  expect(queries.some(sql => sql.includes('substr') && sql.includes('payload'))).toBe(false)
})

test('current ownership, exact interval and caller transaction are mandatory before staging', async () => {
  const state = await begin()
  const outside = rawPage()
  outside.changes[0].metadata.revision = snapshotJournalRevision('10')
  outside.after = { revision: outside.changes[0].metadata.revision, id1: 7, id2: 0, exactText: '' }
  await expect(stage(state, outside)).rejects.toThrow('Invalid or exhausted')
  await expect(stageSnapshotJournalDestinationPage(db, binding, state, rawPage(), limits)).rejects.toThrow(
    'Invalid or exhausted'
  )
  await db('users').where({ userId: 7 }).update({ activeStorage: 'other' })
  await db('users').where({ userId: 7 }).update({ activeStorage: 'destination' })
  await expect(stage(state)).rejects.toThrow('Invalid or stale')
  expect(await db('snapshot_reconciliation_stage_pages')).toEqual([])
})

test('stored numeric metadata is bounded by actual SQL before JavaScript receives it or fetches a frame', async () => {
  const state = await intake()
  for (const field of ['sequence', 'streamIndex', 'examined', 'bytes'] as const) {
    let returned: unknown
    const queries: string[] = []
    const capture = (response: unknown) => {
      if (
        Array.isArray(response) &&
        response.length === 1 &&
        response[0] !== null &&
        typeof response[0] === 'object' &&
        Object.hasOwn(response[0], 'actualBytes')
      )
        returned = response[0]
    }
    const query = (value: { sql: string }) => queries.push(value.sql)
    db.on('query-response', capture)
    db.on('query', query)
    try {
      await expect(
        db.transaction(async trx => {
          await trx('snapshot_reconciliation_stage_pages')
            .where({ sequence: 9 })
            .update({ [field]: field === 'sequence' ? 2.5 : 'é\u0000'.repeat(2048) })
          await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
        })
      ).rejects.toThrow('Invalid or exhausted')
    } finally {
      db.removeListener('query-response', capture)
      db.removeListener('query', query)
    }
    expect(returned).toMatchObject({ [field]: null })
    expect(queries.some(sql => sql.includes('substr') && sql.includes('payload'))).toBe(false)
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
    expect(
      await db.transaction(async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, state))
    ).toMatchObject({ receipt: { sequence: 9, streamIndex: 8, examined: 1 } })
  }
})

test('stored digest UTF8 bytes are bounded by actual SQL before JavaScript receives them or fetches a frame', async () => {
  const state = await intake()
  let returned: unknown
  const queries: string[] = []
  const capture = (response: unknown) => {
    if (
      Array.isArray(response) &&
      response.length === 1 &&
      response[0] !== null &&
      typeof response[0] === 'object' &&
      Object.hasOwn(response[0], 'actualBytes')
    )
      returned = response[0]
  }
  const query = (value: { sql: string }) => queries.push(value.sql)
  db.on('query-response', capture)
  db.on('query', query)
  try {
    await expect(
      db.transaction(async trx => {
        await trx('snapshot_reconciliation_stage_pages')
          .where({ sequence: 9 })
          .update({ digest: 'é\u0000'.repeat(2048) })
        await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
      })
    ).rejects.toThrow('Invalid or exhausted')
  } finally {
    db.removeListener('query-response', capture)
    db.removeListener('query', query)
  }
  expect(returned).toMatchObject({ digest: null })
  expect(queries.some(sql => sql.includes('substr') && sql.includes('payload'))).toBe(false)
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test('intake budget metadata is bounded by actual SQL and refusal rolls back both charge and checkpoint', async () => {
  const initial = await begin()
  const firstPage = rawPage()
  firstPage.complete = false
  const state = (await stage(initial, firstPage)).checkpoint
  const revision = snapshotJournalRevision('4')
  const nextPage: SnapshotJournalDeltaPage = {
    ...rawPage(),
    changes: rawPage().changes.map(change => ({
      ...change,
      metadata: { ...change.metadata, revision }
    })),
    after: { revision, id1: 7, id2: 0, exactText: '' }
  }
  for (const field of ['binding', 'maximumBytes', 'maximumPages', 'bytes', 'pages'] as const) {
    let returned: unknown
    const capture = (response: unknown) => {
      if (
        Array.isArray(response) &&
        response.length === 1 &&
        response[0] !== null &&
        typeof response[0] === 'object' &&
        Object.hasOwn(response[0], 'maximumPages')
      )
        returned = response[0]
    }
    db.on('query-response', capture)
    try {
      await expect(
        db.transaction(async trx => {
          await trx('snapshot_reconciliation_stage_budgets').update({
            [field]: 'é\u0000'.repeat(2048)
          })
          await stageSnapshotJournalDestinationPage(trx, binding, state, nextPage, limits)
        })
      ).rejects.toThrow('Invalid or exhausted')
    } finally {
      db.removeListener('query-response', capture)
    }
    expect(returned).toMatchObject({ [field]: null })
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
    expect(await db('snapshot_reconciliation_stage_pages').count({ n: '*' })).toEqual([{ n: 1 }])
    expect(
      await db('snapshot_reconciliation_stage_budgets').select('binding', 'maximumBytes', 'maximumPages', 'pages')
    ).toEqual([{ binding: state.binding, ...limits, pages: 1 }])
  }
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

test('per-table chain links, quota and checkpoint are atomic and a failed append restores its prior tail', async () => {
  const initial = await begin()
  const first = rawPage()
  first.complete = false
  const state = (await stage(initial, first)).checkpoint
  const beforeChain = await db('snapshot_reconciliation_stage_chains').select()
  expect(beforeChain).toHaveLength(1)
  expect(beforeChain[0]).toMatchObject({ tableId: 0, headSequence: 1, tailSequence: 1, pages: 1 })
  expect(await db('snapshot_reconciliation_stage_pages').select('sequence', 'ordinal', 'nextSequence')).toEqual([
    { sequence: 1, ordinal: 1, nextSequence: 0 }
  ])
  const next = rawPage()
  next.changes[0].metadata.revision = snapshotJournalRevision('4')
  next.after = { revision: next.changes[0].metadata.revision, id1: 7, id2: 0, exactText: '' }
  await expect(
    db.transaction(async trx => {
      await stageSnapshotJournalDestinationPage(trx, binding, state, next, limits)
      expect(
        await trx('snapshot_reconciliation_stage_pages')
          .orderBy('sequence')
          .select('sequence', 'ordinal', 'nextSequence')
      ).toEqual([
        { sequence: 1, ordinal: 1, nextSequence: 2 },
        { sequence: 2, ordinal: 2, nextSequence: 0 }
      ])
      throw new Error('Atomic chain append rollback')
    })
  ).rejects.toThrow('Atomic chain append rollback')
  expect(await db('snapshot_reconciliation_stage_chains').select()).toEqual(beforeChain)
  expect(await db('snapshot_reconciliation_stage_pages').select('sequence', 'ordinal', 'nextSequence')).toEqual([
    { sequence: 1, ordinal: 1, nextSequence: 0 }
  ])
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})

test('missing head, interior or physical tail refuses before payload instead of falsely exhausting a table', async () => {
  const initial = await intakeChain()
  const expectedSequences = [9, 10, 11, 16]
  for (let hole = 0; hole < expectedSequences.length; hole++) {
    await expect(
      db.transaction(async trx => {
        await trx('snapshot_reconciliation_stage_pages').where({ sequence: expectedSequences[hole] }).delete()
        let state = initial
        for (let index = 0; index < hole; index++) {
          const result = await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
          expect(result?.receipt.sequence).toBe(expectedSequences[index])
          if (!result) throw new Error('Expected staged prefix')
          state = await consumeChainPage(trx, state, result.receipt.sequence, result.page.examined)
        }
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
        throw new Error('Missing custody rollback')
      })
    ).rejects.toThrow('Missing custody rollback')
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(initial)
    expect(
      await db('snapshot_reconciliation_stage_pages').where({ tableId: 8 }).orderBy('sequence').select('sequence')
    ).toEqual(expectedSequences.map(sequence => ({ sequence })))
  }
})

test('only the actual complete last stream and recorded tail establish exhaustion, including empty physical work', async () => {
  const initial = await intakeChain()
  await expect(
    db.transaction(async trx => {
      let state = initial
      for (const sequence of [9, 10, 11, 16]) {
        const result = await readSnapshotJournalDestinationPromotionPage(trx, binding, state)
        expect(result?.receipt.sequence).toBe(sequence)
        if (!result) throw new Error('Expected staged work item')
        if (sequence === 16) expect(result.page).toMatchObject({ changes: [], examined: 0, complete: true })
        state = await consumeChainPage(trx, state, sequence, result.page.examined)
      }
      expect(await readSnapshotJournalDestinationPromotionPage(trx, binding, state)).toBeUndefined()
      await trx('snapshot_reconciliation_stage_chains').where({ tableId: 8 }).update({ pages: 5 })
      await expect(readSnapshotJournalDestinationPromotionPage(trx, binding, state)).rejects.toThrow(
        'Invalid or exhausted'
      )
      throw new Error('Tail proof rollback')
    })
  ).rejects.toThrow('Tail proof rollback')
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(initial)
})

// Metadata/staging unit contract only: a field descriptor and intake checkpoint
// never prove content custody, semantic promotion or a financial ACK.
test('field staging binds its distinct family, exact metadata bytes and nonce while the row path refuses it', async () => {
  binding = { ...binding, fieldEncoding: 'wallet-journal-fields/1' }
  const state = await begin(),
    metadata = { revision: snapshotJournalRevision('3'), id1: 7, id2: 0, exactText: '', present: true },
    data: SnapshotJournalHashedFieldPage = {
      table: 'transactions',
      examined: 1,
      metadataBytes: 1024,
      fieldBytes: 2097153,
      complete: true,
      after: { revision: metadata.revision, id1: 7, id2: 0, exactText: '' },
      changes: [
        {
          present: true,
          metadata,
          row: { transactionId: 7, userId: 3, nullable: null },
          fields: { rawTx: { kind: 'binary', bytes: 2097153, sha256: 'a'.repeat(64) } }
        }
      ]
    }
  await expect(stage(state)).rejects.toThrow()
  const result = await db.transaction(
      async trx => await stageSnapshotJournalDestinationFieldPage(trx, binding, state, data, limits)
    ),
    stored = await db('snapshot_reconciliation_stage_pages').first()
  expect(result.checkpoint).toMatchObject({ sequence: 1, streamIndex: 1, phase: 'intake' })
  expect(stored.bytes).toBe(stored.payload.length)
  expect(stored.bytes).toBeLessThan(4096)
  expect(decodeSnapshotJournalFieldFrame(stored.payload, { stream: 'scope', tableId: 0 })).toEqual(data)
  expect(() => decodeSnapshotJournalDeltaFrame(stored.payload, { stream: 'scope', tableId: 0 })).toThrow()
  const oldBinding = { ...binding }
  delete oldBinding.fieldEncoding
  await expect(
    db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, oldBinding))
  ).rejects.toThrow()
  await expect(
    db.transaction(async trx => await stageSnapshotJournalDestinationFieldPage(trx, binding, state, data, limits))
  ).rejects.toThrow()
  expect(await db('test_staged_rows')).toHaveLength(0)
  expect(await db('snapshot_reconciliation_stage_pages')).toHaveLength(1)
})

test('field metadata reopens in dependency order after all streams without granting the old row promoter or a financial ACK', async () => {
  binding = { ...binding, fieldEncoding: 'wallet-journal-fields/1' }
  let state = await begin()
  for (let index = 0; index < 15; index++) {
    const tableId = index < 13 ? index : index === 13 ? 8 : 9,
      metadata = {
        generation: snapshotJournalRevision('2'),
        revision: snapshotJournalRevision('3'),
        id1: 7,
        id2: 0,
        exactText: '',
        present: true
      },
      populated = index === 13,
      data: SnapshotJournalHashedFieldPage = {
        table: tableNames[tableId],
        changes: populated
          ? [
              {
                metadata,
                present: true,
                row: { provenTxId: 7, nullable: null },
                fields: { rawTx: { kind: 'binary', bytes: 2097153, sha256: 'b'.repeat(64) } }
              }
            ]
          : [],
        examined: populated ? 1 : 0,
        metadataBytes: populated ? 1024 : 0,
        fieldBytes: populated ? 2097153 : 0,
        complete: true,
        ...(populated ? { after: { revision: metadata.revision, id1: 7, id2: 0, exactText: '' } } : {})
      }
    state = (
      await db.transaction(
        async trx => await stageSnapshotJournalDestinationFieldPage(trx, binding, state, data, limits)
      )
    ).checkpoint
  }
  expect(state.phase).toBe('promoting')
  const reopened = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    await expect(
      reopened.transaction(async trx => await readSnapshotJournalDestinationPromotionPage(trx, binding, state))
    ).rejects.toThrow()
    const emptyScope = await reopened.transaction(
      async trx => await readSnapshotJournalDestinationFieldPromotionPage(trx, binding, state)
    )
    expect(emptyScope?.page.changes).toEqual([])
    if (emptyScope === undefined) throw new Error('Actual empty scope frame missing')
    state = (
      await reopened.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            {
              phase: 'promoting',
              examined: 0,
              complete: false,
              promotionSequence: emptyScope.receipt.sequence,
              emptyFrameDigest: emptyScope.receipt.digest
            },
            async actual => {
              expect(await actual('test_staged_rows')).toHaveLength(0)
            }
          )
      )
    ).checkpoint
    const actual = await reopened.transaction(
      async trx => await readSnapshotJournalDestinationFieldPromotionPage(trx, binding, state)
    )
    expect(actual?.page.table).toBe('provenTxs')
    expect(actual?.receipt.streamIndex).toBe(13)
    expect(actual?.page.fieldBytes).toBe(2097153)
    expect(actual?.page.changes[0]).toMatchObject({ present: true, fields: { rawTx: { bytes: 2097153 } } })
    expect(await db('test_staged_rows')).toHaveLength(0)
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
  } finally {
    await reopened.destroy()
  }
})

test('field partial promotion retains actual rollback, durable lost-reply recovery and family fences', async () => {
  for (const ddl of snapshotJournalCapturedIdentitiesDdl(db)) await db.raw(ddl)
  await db.raw(snapshotJournalDestinationPromotionDdl(db))
  binding = { ...binding, fieldEncoding: 'wallet-journal-fields/1' }
  let state = await begin()
  let physicalDigest: string | undefined
  for (let index = 0; index < 15; index++) {
    const tableId = index < 13 ? index : index === 13 ? 8 : 9,
      ids = index === 13 ? [7, 8] : [],
      data: SnapshotJournalHashedFieldPage = {
        table: tableNames[tableId],
        changes: ids.map(id1 => ({
          metadata: {
            generation: snapshotJournalRevision('2'),
            revision: snapshotJournalRevision('3'),
            id1,
            id2: 0,
            exactText: '',
            present: true
          },
          present: true,
          row: { provenTxId: id1 },
          fields: { rawTx: { kind: 'binary', bytes: 2097153, sha256: String(id1).repeat(64) } }
        })),
        examined: ids.length,
        metadataBytes: ids.length * 1024,
        fieldBytes: ids.length * 2097153,
        complete: true,
        ...(ids.length ? { after: { revision: snapshotJournalRevision('3'), id1: 8, id2: 0, exactText: '' } } : {})
      },
      digest = createHash('sha256')
        .update(encodeSnapshotJournalFieldFrame(data, { stream: index < 13 ? 'scope' : 'physical', tableId }))
        .digest('hex')
    if (index === 13) physicalDigest = digest
    state = (
      await db.transaction(async trx => {
        await sealSnapshotJournalCapturedFrame(trx, binding, state, digest, ids.length)
        return await stageSnapshotJournalDestinationFieldPage(trx, binding, state, data, limits)
      })
    ).checkpoint
  }
  const effect = jest.fn(
    async (trx: Knex, change: import('./SnapshotJournalFieldTypes').SnapshotJournalHashedFieldDelta) => {
      if (!change.present) throw new Error('Actual populated metadata required')
      expect(change.row).not.toHaveProperty('rawTx')
      expect(change.fields.rawTx.bytes).toBe(2097153)
      await trx('test_staged_rows').insert({ id: change.metadata.id1, value: change.fields.rawTx.sha256 })
    }
  )
  await expect(
    db.transaction(
      async trx =>
        await promoteSnapshotJournalDestinationBatch(trx, binding, state, undefined, 1, async () => {
          throw new Error('Wrong family must reject before effects')
        })
    )
  ).rejects.toThrow()
  // The first actual scope frame is empty; traversing it writes no entity.
  state = (
    await db.transaction(
      async trx => await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, undefined, 1, effect)
    )
  ).checkpoint
  expect(effect).not.toHaveBeenCalled()
  if (physicalDigest === undefined) throw new Error('Actual physical frame missing')
  const captured = await db('snapshot_reconciliation_identity_frames').where({ frameDigest: physicalDigest }).first()
  expect(captured).toBeDefined()
  await db('snapshot_reconciliation_identity_frames').where({ frameDigest: physicalDigest }).delete()
  await expect(
    db.transaction(
      async trx => await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, undefined, 1, effect)
    )
  ).rejects.toThrow('captured journal identity')
  expect(effect).not.toHaveBeenCalled()
  // Restore exactly the producer-completion row removed by the injected fault.
  await db('snapshot_reconciliation_identity_frames').insert(captured)
  const frame = await db('snapshot_reconciliation_stage_pages').where({ streamIndex: 13 }).first()
  const before = state
  const failed = new Error('injected after actual effect before outer commit')
  await expect(
    db.transaction(async trx => {
      await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, undefined, 1, effect)
      throw failed
    })
  ).rejects.toBe(failed)
  expect(await db('test_staged_rows')).toHaveLength(0)
  expect(
    await db.transaction(async trx => await readSnapshotJournalPromotionCursor(trx, binding, state))
  ).toBeUndefined()
  const committed = await db.transaction(
    async trx => await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, undefined, 1, effect)
  )
  expect(committed.checkpoint).toEqual(before)
  expect(committed.cursor?.nextChange).toBe(1)
  expect(await db('test_staged_rows')).toHaveLength(1)
  const recovered = await db.transaction(async trx => await readSnapshotJournalPromotionCursor(trx, binding, state))
  expect(recovered).toEqual(committed.cursor)
  await expect(
    db.transaction(
      async trx => await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, undefined, 1, effect)
    )
  ).rejects.toThrow()
  expect(await db('test_staged_rows')).toHaveLength(1)
  const completedFrame = await db.transaction(
    async trx => await promoteSnapshotJournalDestinationFieldBatch(trx, binding, state, recovered, 1, effect)
  )
  state = completedFrame.checkpoint
  expect(state.phase).toBe('promoting')
  expect(state.promotionSequence).toBe(frame.sequence)
  expect(completedFrame.cursor).toBeUndefined()
  expect(await db('test_staged_rows').orderBy('id').pluck('id')).toEqual([7, 8])
  expect(await db('snapshot_reconciliation_promotion_cursors')).toHaveLength(0)
  expect(await db('users').first('activeStorage')).toEqual({ activeStorage: 'destination' })
})
