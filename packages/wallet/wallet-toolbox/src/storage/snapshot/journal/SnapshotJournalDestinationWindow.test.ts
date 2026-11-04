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
  readSnapshotJournalStoredWindow,
  retireSnapshotJournalDestinationWindow,
  replaceSnapshotJournalDestinationWindow,
  withSnapshotJournalWindowCustodyFence,
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

describe('full-scan receiver replacement after interrupted custody', () => {
  function replacement(): SnapshotJournalDestinationBinding {
    return {
      ...binding,
      bootstrap: true,
      low: snapshotJournalRevision('0'),
      receipt: {
        ...binding.receipt,
        requestId: '77'.repeat(32),
        floor: snapshotJournalRevision('5'),
        highWater: snapshotJournalRevision('12')
      }
    }
  }
  test('fresh full scan permits a retained floor gap while incremental history still refuses it', async () => {
    const next = replacement()
    const state = await db.transaction(async trx => await beginSnapshotJournalDestinationWindow(trx, next, sessionId))
    expect(state.phase).toBe('intake')
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, next))).toEqual(state)
    await expect(
      db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, { ...next, bootstrap: undefined }))
    ).rejects.toThrow('Invalid or stale')
  })
  test('retirement rejects an old writer before its application callback can run', async () => {
    const state = await begin(),
      apply = jest.fn(async () => undefined)
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
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
    ).rejects.toThrow('Invalid or stale')
    expect(apply).not.toHaveBeenCalled()
    expect(await db.transaction(async trx => await readSnapshotJournalStoredWindow(trx, replacement()))).toMatchObject({
      checkpoint: state,
      retired: true
    })
  })
  test('unfinished active custody cannot be collected before durable retirement', async () => {
    const state = await begin(),
      collect = jest.fn(async () => undefined)
    await expect(
      db.transaction(async trx => await withSnapshotJournalWindowCustodyFence(trx, binding, state, collect))
    ).rejects.toThrow('Invalid or stale')
    expect(collect).not.toHaveBeenCalled()
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
  })
  test('replacement and lost-reply observation use durable custody rather than a remembered nonce', async () => {
    const state = await begin(),
      next = replacement()
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    await expect(
      db
        .transaction(
          async trx =>
            await replaceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              next,
              '88'.repeat(32),
              async () => undefined
            )
        )
        .then(() => {
          throw new Error('lost committed replacement reply')
        })
    ).rejects.toThrow('lost committed replacement reply')
    const actual = await db.transaction(async trx => await readSnapshotJournalStoredWindow(trx, next))
    expect(actual?.binding).toEqual(next)
    expect(actual?.checkpoint).toMatchObject({ sessionId: '88'.repeat(32), phase: 'intake', sequence: 0 })
    expect(actual?.retired).toBe(false)
    expect(await db('snapshot_reconciliation_windows')).toHaveLength(1)
  })
  test('failed cleanup rolls replacement back and a changed source generation cannot be adopted', async () => {
    const state = await begin(),
      next = replacement()
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    await expect(
      db.transaction(
        async trx =>
          await replaceSnapshotJournalDestinationWindow(trx, binding, state, next, '88'.repeat(32), async () => {
            throw new Error('cleanup remains')
          })
      )
    ).rejects.toThrow('cleanup remains')
    const source = { ...next.source, epoch: '22222222-2222-4333-8444-555555555555' }
    await expect(
      db.transaction(
        async trx =>
          await replaceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            { ...next, source, receipt: { ...next.receipt, binding: snapshotJournalReceiptBinding(source) } },
            '88'.repeat(32),
            async () => undefined
          )
      )
    ).rejects.toThrow('Invalid or stale')
    expect(await db.transaction(async trx => await readSnapshotJournalStoredWindow(trx, next))).toMatchObject({
      checkpoint: state,
      retired: true
    })
  })
  test('V2 full replacement accepts a fresh source epoch with reset counters while keeping profile custody', async () => {
    binding = { ...binding, lineageVersion: 2 }
    const state = await begin()
    const source = { ...binding.source, epoch: '22222222-2222-4333-8444-555555555555', backend: 'aa'.repeat(32) }
    const next: SnapshotJournalDestinationBinding = {
      ...binding,
      bootstrap: true,
      source,
      low: snapshotJournalRevision('0'),
      receipt: {
        ...binding.receipt,
        requestId: '77'.repeat(32),
        binding: snapshotJournalReceiptBinding(source),
        floor: snapshotJournalRevision('0'),
        highWater: snapshotJournalRevision('2')
      }
    }
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    const replaced = await db.transaction(
      async trx =>
        await replaceSnapshotJournalDestinationWindow(trx, binding, state, next, '88'.repeat(32), async () => undefined)
    )
    expect(replaced).toMatchObject({ sequence: 0, phase: 'intake' })
    expect((await db.transaction(async trx => await readSnapshotJournalStoredWindow(trx, next)))?.binding).toEqual(next)
  })
  test('V2 full replacement binds the actual new destination primary and never writes a selection', async () => {
    binding = { ...binding, lineageVersion: 2 }
    const state = await begin()
    await db('users').where({ userId: binding.destinationUserId }).update({ activeStorage: 'new-primary' })
    const next: SnapshotJournalDestinationBinding = {
      ...replacement(),
      lineageVersion: 2,
      activeStorage: 'new-primary',
      primaryEpoch: snapshotJournalRevision('1')
    }
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    await db.transaction(
      async trx =>
        await replaceSnapshotJournalDestinationWindow(trx, binding, state, next, '88'.repeat(32), async () => undefined)
    )
    expect((await db('users').first()).activeStorage).toBe('new-primary')
    expect((await db('snapshot_sync_primary_epochs').first()).epoch).toBe(1)
  })
  test('V2 full replacement refuses another source identity or network before cleanup', async () => {
    binding = { ...binding, lineageVersion: 2 }
    const state = await begin(),
      clean = jest.fn(async () => undefined)
    await db.transaction(async trx => await retireSnapshotJournalDestinationWindow(trx, binding, state))
    for (const change of [{ identityKey: '03' + '77'.repeat(32) }, { chain: 'test' }]) {
      const source = { ...binding.source, ...change }
      const next: SnapshotJournalDestinationBinding = {
        ...replacement(),
        lineageVersion: 2,
        source,
        receipt: { ...replacement().receipt, binding: snapshotJournalReceiptBinding(source) }
      }
      await expect(
        db.transaction(
          async trx => await replaceSnapshotJournalDestinationWindow(trx, binding, state, next, '88'.repeat(32), clean)
        )
      ).rejects.toThrow('Invalid or stale')
    }
    expect(clean).not.toHaveBeenCalled()
  })
})

describe('internal destination-owned journal window', () => {
  test('begins and resumes only the identical durable window and nonce', async () => {
    const state = await begin()
    expect(state).toMatchObject({
      sequence: 0,
      phase: 'intake',
      streamIndex: 0,
      tableIndex: 0
    })
    expect(await begin()).toEqual(state)
    await expect(
      db.transaction(async trx => await beginSnapshotJournalDestinationWindow(trx, binding, '92'.repeat(32)))
    ).rejects.toThrow('Invalid or stale')
    expect(await db('snapshot_reconciliation_windows')).toHaveLength(1)
  })

  test('recovers a committed staging write and checkpoint after a deliberately lost response using a new owner', async () => {
    const state = await begin()
    await expect(
      db
        .transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              { phase: 'intake', examined: 0, complete: true },
              async k =>
                await k('test_staged_rows').insert({
                  id: 1,
                  value: 'retained'
                })
            )
        )
        .then(() => {
          throw new Error('Synthetic lost committed acknowledgement')
        })
    ).rejects.toThrow('lost committed acknowledgement')
    const replacement = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    try {
      await replacement.raw('PRAGMA busy_timeout = 0')
      const recovered = await replacement.transaction(
        async trx => await readSnapshotJournalDestinationWindow(trx, binding)
      )
      expect(recovered).toMatchObject({
        sequence: 1,
        streamIndex: 1,
        phase: 'intake'
      })
      expect(await replacement('test_staged_rows').select()).toEqual([{ id: 1, value: 'retained' }])
      const duplicateApply = jest.fn(async () => undefined)
      await expect(
        replacement.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              { phase: 'intake', examined: 0, complete: true },
              duplicateApply
            )
        )
      ).rejects.toThrow('Invalid or stale')
      expect(duplicateApply).not.toHaveBeenCalled()
    } finally {
      await replacement.destroy()
    }
  })

  test('rolls back both staged rows and checkpoint when the same transaction fails', async () => {
    const state = await begin()
    await expect(
      db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            { phase: 'intake', examined: 0, complete: true },
            async k => {
              await k('test_staged_rows').insert({
                id: 1,
                value: 'uncommitted'
              })
              throw new Error('Synthetic transaction failure')
            }
          )
      )
    ).rejects.toThrow('transaction failure')
    expect(await db('test_staged_rows')).toEqual([])
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
  })

  test('requires all thirteen scope streams and both physical streams before twelve dependency promotions', async () => {
    let state = await begin()
    const phases: string[] = []
    for (let stream = 0; stream < 15; stream++) {
      expect(state.phase).toBe('intake')
      expect(state.streamIndex).toBe(stream)
      state = (
        await db.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              { phase: 'intake', examined: 0, complete: true },
              async () => {
                phases.push('intake:' + stream)
              }
            )
        )
      ).checkpoint
    }
    const expected = [
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
    for (const [index, name] of expected.entries()) {
      expect(state.phase).toBe('promoting')
      expect(state.tableIndex).toBe(index)
      state = (
        await db.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              {
                phase: 'promoting',
                examined: 0,
                complete: true,
                promotionSequence: 0
              },
              async () => {
                phases.push('promoting:' + name)
              }
            )
        )
      ).checkpoint
    }
    expect(state).toMatchObject({
      phase: 'acknowledged',
      sequence: 27,
      tableIndex: 12,
      streamIndex: 15
    })
    expect(phases.slice(15)).toEqual(expected.map(name => 'promoting:' + name))
    expect(phases).not.toContain('promoting:syncStates')
    await expect(
      db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            {
              phase: 'promoting',
              examined: 0,
              complete: true,
              promotionSequence: 0
            },
            async () => undefined
          )
      )
    ).rejects.toThrow('Invalid or stale')
  })

  test('retains a bounded intake prefix and refuses a repeated or regressed cursor before writes', async () => {
    const original = await begin()
    const after = {
      revision: snapshotJournalRevision('2'),
      id1: 10,
      id2: 0,
      exactText: ''
    }
    const next = (
      await db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            original,
            { phase: 'intake', examined: 1, complete: false, after },
            async () => undefined
          )
      )
    ).checkpoint
    expect(next.after).toEqual(after)
    for (const cursor of [after, { ...after, id1: 9 }]) {
      const apply = jest.fn(async () => undefined)
      await expect(
        db.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              next,
              { phase: 'intake', examined: 1, complete: false, after: cursor },
              apply
            )
        )
      ).rejects.toThrow('Invalid or stale')
      expect(apply).not.toHaveBeenCalled()
    }
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(next)
  })

  test('fences a primary that changes away and back even though its selected identity matches again', async () => {
    const state = await begin()
    await db('users').where('userId', 7).update('activeStorage', 'another')
    await db('users').where('userId', 7).update('activeStorage', 'destination')
    expect((await db('snapshot_sync_primary_epochs').first()).epoch).toBe(2)
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
    const apply = jest.fn(async () => undefined)
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
    ).rejects.toThrow('Invalid or stale')
    expect(apply).not.toHaveBeenCalled()
  })

  test('rolls back if apply changes primary ownership during its transaction', async () => {
    const state = await begin()
    await expect(
      db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            { phase: 'intake', examined: 0, complete: true },
            async k => {
              await k('users').where('userId', 7).update('activeStorage', 'another')
              await k('test_staged_rows').insert({
                id: 1,
                value: 'must rollback'
              })
            }
          )
      )
    ).rejects.toThrow('Invalid or stale')
    expect((await db('users').first()).activeStorage).toBe('destination')
    expect(await db('snapshot_sync_primary_epochs')).toEqual([])
    expect(await db('test_staged_rows')).toEqual([])
  })

  test('detaches caller binding values before the first asynchronous query', async () => {
    const input = {
      ...binding,
      source: { ...binding.source },
      receipt: { ...binding.receipt }
    }
    const promise = db.transaction(async trx => {
      const query = beginSnapshotJournalDestinationWindow(trx, input, sessionId)
      input.source.identityKey = '03' + '77'.repeat(32)
      input.receipt.highWater = snapshotJournalRevision('999')
      return await query
    })
    const state = await promise
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
  })

  test('refuses wrong actual network or profile independently of a matching proposed digest', async () => {
    await begin()
    await db('settings').update('chain', 'test')
    await expect(db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).rejects.toThrow(
      'Invalid or stale'
    )
    await db('settings').update('chain', 'mock')
    await db('users')
      .where('userId', 7)
      .update('identityKey', '03' + '88'.repeat(32))
    await expect(db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).rejects.toThrow(
      'Invalid or stale'
    )
  })

  test('refuses changed receipt or source epoch instead of replacing an existing in-flight window', async () => {
    await begin()
    for (const input of [
      {
        ...binding,
        receipt: { ...binding.receipt, requestId: '56'.repeat(32) }
      },
      {
        ...binding,
        source: {
          ...binding.source,
          epoch: '11111111-2222-4333-8444-555555555556'
        }
      }
    ])
      await expect(
        db.transaction(async trx => await beginSnapshotJournalDestinationWindow(trx, input, sessionId))
      ).rejects.toThrow('Invalid or stale')
    expect(await db('snapshot_reconciliation_windows')).toHaveLength(1)
  })

  test('refuses expired receipts, incoherent continuity, oversized counts and nontransaction access', async () => {
    await expect(beginSnapshotJournalDestinationWindow(db, binding, sessionId)).rejects.toThrow('Invalid or stale')
    await expect(
      db.transaction(
        async trx =>
          await beginSnapshotJournalDestinationWindow(
            trx,
            {
              ...binding,
              receipt: { ...binding.receipt, expiresAt: Date.now() - 1 }
            },
            sessionId
          )
      )
    ).rejects.toThrow('Invalid or stale')
    await expect(
      db.transaction(
        async trx =>
          await beginSnapshotJournalDestinationWindow(
            trx,
            { ...binding, low: snapshotJournalRevision('10') },
            sessionId
          )
      )
    ).rejects.toThrow('Invalid or stale')
    const state = await begin(),
      apply = jest.fn(async () => undefined)
    await expect(
      db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            binding,
            state,
            { phase: 'intake', examined: 257, complete: true },
            apply
          )
      )
    ).rejects.toThrow('Invalid or stale')
    expect(apply).not.toHaveBeenCalled()
  })

  test('observes the durable outcome after database-clock expiry while refusing further writes', async () => {
    binding.receipt.expiresAt = Date.now() + 1000
    const state = await begin()
    await new Promise<void>(resolve => setTimeout(resolve, 1100))
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
    const apply = jest.fn(async () => undefined)
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
    ).rejects.toThrow('Invalid or stale')
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('acknowledged destination window succession', () => {
  const nextSessionId = '93'.repeat(32)
  async function completed(): Promise<SnapshotJournalDestinationCheckpoint> {
    let state = await begin()
    for (let stream = 0; stream < 15; stream++)
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
    for (let table = 0; table < 12; table++)
      state = (
        await db.transaction(
          async trx =>
            await advanceSnapshotJournalDestinationWindow(
              trx,
              binding,
              state,
              {
                phase: 'promoting',
                examined: 0,
                complete: true,
                promotionSequence: 0
              },
              async () => undefined
            )
        )
      ).checkpoint
    return state
  }
  function successor(): SnapshotJournalDestinationBinding {
    return {
      ...binding,
      source: { ...binding.source },
      low: binding.receipt.highWater,
      receipt: {
        ...binding.receipt,
        requestId: '57'.repeat(32),
        highWater: snapshotJournalRevision('12'),
        expiresAt: Date.now() + 60000
      }
    }
  }
  async function succeed(
    state: SnapshotJournalDestinationCheckpoint,
    next: SnapshotJournalDestinationBinding,
    cleanup: (k: Knex) => Promise<void>
  ): Promise<SnapshotJournalDestinationCheckpoint> {
    return await db.transaction(
      async trx => await succeedSnapshotJournalDestinationWindow(trx, binding, state, next, nextSessionId, cleanup)
    )
  }
  test('replaces a completed window and retires its staging in one committed transaction', async () => {
    const prior = await completed(),
      next = successor()
    await db('test_staged_rows').insert({ id: 1, value: 'old-window' })
    const state = await succeed(prior, next, async k => {
      await k('test_staged_rows').del()
    })
    expect(state).toMatchObject({
      sessionId: nextSessionId,
      sequence: 0,
      phase: 'intake',
      streamIndex: 0
    })
    expect(await db('test_staged_rows')).toEqual([])
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, next))).toEqual(state)
    expect(await db('snapshot_reconciliation_windows')).toHaveLength(1)
  })
  test('recovers a lost committed successor reply without repeating cleanup or resetting later progress', async () => {
    const prior = await completed(),
      next = successor(),
      cleanup = jest.fn(async () => undefined)
    await expect(
      succeed(prior, next, cleanup).then(() => {
        throw new Error('Lost successor reply')
      })
    ).rejects.toThrow('Lost successor reply')
    const first = await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, next))
    if (first === undefined) throw new Error('Committed successor is missing')
    const progress = (
      await db.transaction(
        async trx =>
          await advanceSnapshotJournalDestinationWindow(
            trx,
            next,
            first,
            { phase: 'intake', examined: 0, complete: true },
            async () => undefined
          )
      )
    ).checkpoint
    const replacement = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    try {
      const recovered = await replacement.transaction(
        async trx => await succeedSnapshotJournalDestinationWindow(trx, binding, prior, next, nextSessionId, cleanup)
      )
      expect(recovered).toEqual(progress)
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      await replacement.destroy()
    }
  })
  test('never replaces an unfinished window or calls cleanup for stale expected custody', async () => {
    const intake = await begin(),
      next = successor(),
      cleanup = jest.fn(async () => undefined)
    await expect(succeed(intake, next, cleanup)).rejects.toThrow('Invalid or stale')
    const prior = await completed()
    await expect(succeed({ ...prior, sequence: prior.sequence + 1 }, next, cleanup)).rejects.toThrow('Invalid or stale')
    await expect(succeed({ ...prior, sessionId: '94'.repeat(32) }, next, cleanup)).rejects.toThrow('Invalid or stale')
    expect(cleanup).not.toHaveBeenCalled()
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(prior)
  })
  test('rejects discontinuity and changed source generation or destination ownership before cleanup', async () => {
    const prior = await completed(),
      next = successor(),
      cleanup = jest.fn(async () => undefined)
    const changedEpoch = {
      ...next.source,
      epoch: '11111111-2222-4333-8444-555555555556'
    }
    const changedSchema = { ...next.source, schema: '45'.repeat(32) }
    for (const input of [
      { ...next, low: snapshotJournalRevision('8') },
      {
        ...next,
        source: changedEpoch,
        receipt: {
          ...next.receipt,
          binding: snapshotJournalReceiptBinding(changedEpoch)
        }
      },
      {
        ...next,
        source: changedSchema,
        receipt: {
          ...next.receipt,
          binding: snapshotJournalReceiptBinding(changedSchema)
        }
      },
      { ...next, destinationUserId: 8 },
      { ...next, destinationBackend: '67'.repeat(32) },
      { ...next, primaryEpoch: snapshotJournalRevision('1') },
      { ...next, activeStorage: 'another' },
      {
        ...next,
        receipt: { ...next.receipt, requestId: binding.receipt.requestId }
      }
    ])
      await expect(succeed(prior, input, cleanup)).rejects.toThrow('Invalid or stale')
    await expect(
      db.transaction(
        async trx => await succeedSnapshotJournalDestinationWindow(trx, binding, prior, next, prior.sessionId, cleanup)
      )
    ).rejects.toThrow('Invalid or stale')
    expect(cleanup).not.toHaveBeenCalled()
  })
  test('rolls back retired staging and preserves the completed window if cleanup fails', async () => {
    const prior = await completed(),
      next = successor()
    await db('test_staged_rows').insert({ id: 1, value: 'retained' })
    await expect(
      succeed(prior, next, async k => {
        await k('test_staged_rows').del()
        throw new Error('Interrupted cleanup')
      })
    ).rejects.toThrow('Interrupted cleanup')
    expect(await db('test_staged_rows')).toEqual([{ id: 1, value: 'retained' }])
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(prior)
  })
  test('rolls back succession if cleanup changes the actual primary epoch or window row', async () => {
    const prior = await completed(),
      next = successor()
    for (const cleanup of [
      async (k: Knex) => {
        await k('users').where('userId', 7).update('activeStorage', 'another')
        await k('users').where('userId', 7).update('activeStorage', 'destination')
      },
      async (k: Knex) => {
        await k('snapshot_reconciliation_windows').update('sequence', prior.sequence + 1)
      }
    ])
      await expect(succeed(prior, next, cleanup)).rejects.toThrow('Invalid or stale')
    expect((await db('users').first()).activeStorage).toBe('destination')
    expect(await db('snapshot_sync_primary_epochs')).toEqual([])
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(prior)
  })
  test('detaches both bindings and expected state before the first awaited query', async () => {
    const prior = await completed(),
      next = successor(),
      originalNext = structuredClone(next)
    const previous = structuredClone(binding),
      expected = structuredClone(prior)
    const state = await db.transaction(async trx => {
      const pending = succeedSnapshotJournalDestinationWindow(
        trx,
        previous,
        expected,
        next,
        nextSessionId,
        async () => undefined
      )
      previous.source.schema = '99'.repeat(32)
      expected.sequence++
      next.receipt.highWater = snapshotJournalRevision('999')
      return await pending
    })
    expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, originalNext))).toEqual(
      state
    )
  })
  test('allows an expired completed receipt to be replaced only by a fresh same-generation successor', async () => {
    binding.receipt.expiresAt = Date.now() + 1000
    const prior = await completed(),
      next = successor()
    await new Promise<void>(resolve => setTimeout(resolve, 1100))
    const cleanup = jest.fn(async () => undefined)
    await expect(
      succeed(prior, { ...next, receipt: { ...next.receipt, expiresAt: Date.now() - 1 } }, cleanup)
    ).rejects.toThrow('Invalid or stale')
    expect(cleanup).not.toHaveBeenCalled()
    const state = await succeed(prior, next, cleanup)
    expect(state.sessionId).toBe(nextSessionId)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

test('regtest destination windows keep their network binding and reject another chain', async () => {
  await db('settings').update({ chain: 'regtest' })
  binding = { ...binding, source: { ...binding.source, chain: 'regtest' } }
  binding.receipt = { ...binding.receipt, binding: snapshotJournalReceiptBinding(binding.source) }
  const opened = await db.transaction(t => beginSnapshotJournalDestinationWindow(t, binding, sessionId))
  expect(opened).toBeDefined()
  const wrong = { ...binding, source: { ...binding.source, chain: 'test' } }
  wrong.receipt = { ...wrong.receipt, binding: snapshotJournalReceiptBinding(wrong.source) }
  await expect(db.transaction(t => beginSnapshotJournalDestinationWindow(t, wrong, sessionId))).rejects.toThrow()
})

test('field-window encoding is part of the actual stored binding and unknown families cannot create custody', async () => {
  const bad = { ...binding, fieldEncoding: 'unrecognized' as 'wallet-journal-fields/1' }
  await expect(
    db.transaction(async trx => await beginSnapshotJournalDestinationWindow(trx, bad, sessionId))
  ).rejects.toThrow()
  expect(await db('snapshot_reconciliation_windows')).toHaveLength(0)
  binding = { ...binding, fieldEncoding: 'wallet-journal-fields/1' }
  const state = await begin(),
    stored = await db('snapshot_reconciliation_windows').first()
  expect(JSON.parse(stored.bindingJson).fieldEncoding).toBe('wallet-journal-fields/1')
  const rowBinding = { ...binding }
  delete rowBinding.fieldEncoding
  await expect(
    db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, rowBinding))
  ).rejects.toThrow()
  expect(await db.transaction(async trx => await readSnapshotJournalDestinationWindow(trx, binding))).toEqual(state)
})
