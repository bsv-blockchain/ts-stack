import { afterEach, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteTransactionDomain } from '../src/storage/SQLiteTransactionDomain.js'
import {
  SQLiteProposalJournalStore,
  sqliteProposalBridge
} from '../src/proposals/SQLiteProposalJournalStore.js'
import {
  lookupIndexDefinition,
  SQLiteLookupIndexStore,
  sqliteLookupComposition
} from '../src/lookup/SQLiteLookupIndexStore.js'
import { sqliteLookupBridge } from '../src/lookup/SQLiteLookupBridge.js'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { liveFixture } from './live-lookup-fixture.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { author, recipient, signed, scope, createRegistry } from './proposal-client-fixture.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
function setup(maximumGroups = 65536) {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-composition-')),
    path = join(folder, 'state.db')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
  const domain = new SQLiteTransactionDomain(db)
  cleanups.push(() => {
    domain.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const lifecycle = new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const state = new ProposalJournalState(lifecycle, author)
  const composition = { index: 'query-test', rulesDigest: '55'.repeat(32) }
  const store = new SQLiteProposalJournalStore(domain, 'private', author, state, composition)
  const bridge = store[sqliteProposalBridge]
  const binding = { purpose: 'private-current-channel' }
  const index = new SQLiteLookupIndexStore(
    domain,
    lookupIndexDefinition('current', binding, { capacity: { groups: maximumGroups } }, composition)
  )
  const indexed = index[sqliteLookupComposition]
  domain.transaction(() => {
    bridge.initialize('create')
    indexed.initialize(true)
  })
  const first = lifecycle.put(undefined, signed(), author, '10')
  const rows = () =>
    db
      .prepare('SELECT row_key FROM output_lookup_keys WHERE namespace=? ORDER BY row_key')
      .all('current')
  const append = (transition = first) => {
    const record = transition.next
    const key = record.proposal.body.policy.digest + record.proposal.body.channel
    const previous = indexed.row(key)
    const result = bridge.append(transition)
    if (result.status === 'committed')
      indexed.append({
        base: indexed.head().sequence,
        evaluatedAt: record.state.recordedAt,
        edits: [
          {
            key,
            previous: previous?.revision ?? null,
            next: {
              data: { version: 1, proposal: record.proposal, state: record.state },
              expiresAt: null
            }
          }
        ],
        event: { type: 'proposal-transition/1', revision: result.revision }
      })
    return result
  }
  return {
    domain,
    db,
    store,
    bridge,
    lifecycle,
    first,
    rows,
    append,
    path,
    composition,
    index,
    indexed,
    binding
  }
}

it('commits multiple journal changes and companion rows in one physical transaction', async () => {
  const f = setup()
  const second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  f.domain.transaction(() => {
    expect(f.append()).toEqual({ status: 'committed', revision: '1' })
    expect(f.append(second)).toEqual({ status: 'committed', revision: '2' })
    expect(f.bridge.channel(proposalChannelKey(second.next.proposal.body))).toEqual(second.next)
    const independent = new DatabaseSync(f.path)
    try {
      expect(
        independent
          .prepare('SELECT keys AS n FROM output_lookup_meta WHERE namespace=?')
          .get('current')?.n
      ).toBe(0)
      expect(independent.prepare('SELECT entries FROM proposal_journal_meta').get()?.entries).toBe(
        0
      )
    } finally {
      independent.close()
    }
  })
  expect((await f.store.head()).revision).toBe('2')
  expect(f.rows()).toHaveLength(2)
  expect((await f.store.read('0', 256)).map(entry => entry.transition.next.proposalId)).toEqual([
    f.first.next.proposalId,
    second.next.proposalId
  ])
})

it('rolls back journal, companion rows and staged cache when a later participant fails', async () => {
  const f = setup(),
    failure = new Error('companion capacity exhausted')
  expect(() =>
    f.domain.transaction(() => {
      f.append()
      throw failure
    })
  ).toThrow(failure)
  expect(f.rows()).toEqual([])
  expect((await f.store.head()).revision).toBe('0')
  expect(await f.store.getChannel(proposalChannelKey(f.first.next.proposal.body))).toBeUndefined()
  f.domain.transaction(() => f.append())
  expect(f.rows()).toHaveLength(1)
  expect((await f.store.head()).revision).toBe('1')
})

it('recovers actual committed state after a lost commit acknowledgement without a second logical append', async () => {
  const f = setup(),
    exec = f.db.exec.bind(f.db),
    lost = new Error('lost commit acknowledgement')
  f.db.exec = sql => {
    exec(sql)
    if (sql === 'COMMIT') throw lost
  }
  expect(() => f.domain.transaction(() => f.append())).toThrow(lost)
  f.db.exec = exec
  expect((await f.store.head()).revision).toBe('1')
  expect(f.rows()).toHaveLength(1)
  expect(f.domain.transaction(() => f.append())).toEqual({ status: 'replayed', revision: '1' })
  expect(f.rows()).toHaveLength(1)
})

it('seals the integrated format against standalone writers and duplicate cache owners', async () => {
  const f = setup()
  f.domain.transaction(() => f.append())
  expect(() => SQLiteProposalJournal.open(f.path, 'private', author, f.lifecycle)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(() => SQLiteLookupIndex.open(f.path, 'current', f.binding)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(
    () =>
      new SQLiteProposalJournalStore(
        f.domain,
        'private',
        author,
        new ProposalJournalState(f.lifecycle, author),
        f.composition
      )
  ).toThrow('already owns')
  expect((await f.store.head()).revision).toBe('1')
  expect(f.rows()).toHaveLength(1)
})

it('rejects a real index capacity failure before publishing the corresponding journal transition', async () => {
  const f = setup(1)
  f.domain.transaction(() => f.append())
  const second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  expect(() => f.domain.transaction(() => f.append(second))).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect((await f.store.head()).revision).toBe('1')
  expect((await f.index.head()).sequence).toBe('1')
  expect(await f.store.getChannel(proposalChannelKey(second.next.proposal.body))).toBeUndefined()
  expect(f.rows()).toHaveLength(1)
  const group = await f.index.group('1')
  expect(group.changes[0].after?.value.data.proposal).toEqual(f.first.next.proposal)
})

it('preserves read-only WAL opening while an independent writer holds the connection lock', async () => {
  const f = setup(),
    legacy = SQLiteLookupIndex.create(f.path, 'legacy-read', f.binding)
  let reader: SQLiteLookupIndex | undefined
  try {
    f.domain.transaction(() => {
      reader = SQLiteLookupIndex.open(f.path, 'legacy-read', f.binding)
    })
    expect((await reader!.head()).sequence).toBe('0')
  } finally {
    await reader?.close()
    await legacy.close()
  }
})

it('preserves malformed journal-input rejection before attempting a contended write lock', async () => {
  const f = setup(),
    legacy = SQLiteProposalJournal.create(f.path, 'legacy-write', recipient, f.lifecycle)
  let pending: ReturnType<typeof legacy.commit> | undefined
  try {
    f.domain.transaction(() => {
      pending = legacy.commit({ bad: true } as unknown as Parameters<typeof legacy.commit>[0])
    })
    await expect(pending).rejects.toMatchObject({ code: 'invalid' })
    expect((await legacy.head()).revision).toBe('0')
  } finally {
    await legacy.close()
  }
})

it('rolls back composed journal memory with rejected session work while retaining the observed clock', async () => {
  const f = setup(),
    clock = { now: '10' }
  const sessions = SQLiteLookupSessions.create(
    f.index,
    new LookupSessionCodec(liveFixture().selection),
    () => clock.now
  )
  let enqueued = false
  await expect(
    sessions.enqueueResponse(
      { reference: { kind: 'control' }, bytes: new Uint8Array() },
      () => {
        f.append()
        return false
      },
      () => {
        enqueued = true
        return undefined
      }
    )
  ).rejects.toMatchObject({ code: 'unauthorized' })
  expect(enqueued).toBe(false)
  expect((await f.store.head()).revision).toBe('0')
  expect((await f.index.head()).sequence).toBe('0')
  expect(f.rows()).toEqual([])
  const observed = f.db
    .prepare('SELECT clock FROM output_lookup_session_meta WHERE namespace=?')
    .get('current')?.clock
  expect(observed).toBe('000000000000000a')
  clock.now = '9'
  await expect(sessions.createEpoch()).rejects.toMatchObject({ code: 'context-changed' })
  clock.now = '11'
  await sessions.enqueueResponse(
    { reference: { kind: 'control' }, bytes: new Uint8Array() },
    () => {
      f.append()
      return true
    },
    () => {
      enqueued = true
      return undefined
    }
  )
  expect(enqueued).toBe(true)
  expect((await f.store.head()).revision).toBe('1')
  expect((await f.index.head()).sequence).toBe('1')
})

it.each([false, true])(
  'preserves legacy session rollback semantics when rollback fails: %s',
  async failRollback => {
    const f = setup()
    const bridge = f.index[sqliteLookupBridge]()
    Object.defineProperty(f.index, sqliteLookupBridge, {
      value: () => ({ ...bridge, savepoint: undefined })
    })
    const sessions = SQLiteLookupSessions.create(
      f.index,
      new LookupSessionCodec(liveFixture().selection),
      () => '10'
    )
    f.db.exec('CREATE TABLE legacy_work (value INTEGER) STRICT')
    const originalExec = f.db.exec.bind(f.db),
      failure = new Error('legacy savepoint rollback failed')
    f.db.exec = sql => {
      if (failRollback && sql === 'ROLLBACK TO lookup_session_work; RELEASE lookup_session_work')
        throw failure
      originalExec(sql)
    }
    let enqueued = false
    try {
      const pending = sessions.enqueueResponse(
        { reference: { kind: 'control' }, bytes: new Uint8Array() },
        () => {
          f.db.exec('INSERT INTO legacy_work VALUES (1)')
          return false
        },
        () => {
          enqueued = true
          return undefined
        }
      )
      if (failRollback) await expect(pending).rejects.toThrow(failure)
      else await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
      expect(enqueued).toBe(false)
      expect(f.db.prepare('SELECT count(*) AS n FROM legacy_work').get()?.n).toBe(0)
      expect(
        f.db
          .prepare('SELECT clock FROM output_lookup_session_meta WHERE namespace=?')
          .get('current')?.clock
      ).toBe(failRollback ? '0000000000000000' : '000000000000000a')
    } finally {
      f.db.exec = originalExec
    }
  }
)

it('refuses compound writers outside an owned write transaction', async () => {
  const f = setup()
  expect(() => f.append()).toThrow('requires a write transaction')
  expect(() => f.domain.transaction(() => f.append(), { write: false })).toThrow(
    'requires a write transaction'
  )
  expect((await f.store.head()).revision).toBe('0')
  expect((await f.index.head()).sequence).toBe('0')
  expect(f.rows()).toEqual([])
})

it('forks an already-staged journal across rollback and successful nested publication', async () => {
  const f = setup(),
    failure = new Error('discard successor')
  const successor = f.lifecycle.put(
    f.first.next,
    signed({ revision: '1', previous: f.first.next.proposalId }),
    author,
    '11'
  )
  const key = proposalChannelKey(f.first.next.proposal.body)
  f.domain.transaction(() => {
    f.append()
    expect(() =>
      f.domain.savepoint(() => {
        f.append(successor)
        expect(f.bridge.channel(key)).toEqual(successor.next)
        throw failure
      })
    ).toThrow(failure)
    expect(f.bridge.channel(key)).toEqual(f.first.next)
    f.domain.savepoint(() => f.append(successor))
    expect(f.bridge.channel(key)).toEqual(successor.next)
  })
  expect((await f.store.head()).revision).toBe('2')
  expect((await f.index.head()).sequence).toBe('2')
  expect(await f.store.getChannel(key)).toEqual(successor.next)
  expect(f.rows()).toHaveLength(1)
})
