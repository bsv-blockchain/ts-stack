import { afterEach, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Utils } from '@bsv/sdk'
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
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { SQLiteProposalFeedInventory } from '../src/proposals/SQLiteProposalFeedInventory.js'
import { SQLiteProposalFeedWriter } from '../src/proposals/SQLiteProposalFeedWriter.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { proposalFeedValue } from '../src/proposals/ProposalChannelFeedRecords.js'
import { author, signed, scope, createRegistry, finalize } from './proposal-client-fixture.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  jest.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) close()
})
function fixture(
  options: {
    entries?: number
    groups?: number
    bytes?: number
    versions?: number
    changes?: number
  } = {}
) {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-feed-')),
    path = join(folder, 'state.db')
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  let now = '10'
  const lifecycle = new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const limits = {
    entryBytes: 8192,
    bytes: 1048576,
    entries: options.entries ?? 100,
    channels: 10,
    channelsPerAuthor: 10
  }
  const composition = { format: 'proposal-feed/1', journal: 'private', index: 'current' }
  const open = (create: boolean) => {
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    const domain = new SQLiteTransactionDomain(db)
    cleanups.push(() => domain.close())
    const journal = new SQLiteProposalJournalStore(
      domain,
      'private',
      author,
      new ProposalJournalState(lifecycle, author, limits),
      composition
    )
    const index = new SQLiteLookupIndexStore(
      domain,
      lookupIndexDefinition(
        'current',
        { purpose: 'proposal-current' },
        {
          records: { rowBytes: 8704, groupBytes: 17920, changes: options.changes ?? 8 },
          capacity: {
            keys: 10,
            versions: options.versions ?? 100,
            groups: options.groups ?? 100,
            bytes: options.bytes ?? 1048576
          }
        },
        composition
      )
    )
    const inventory = new SQLiteProposalFeedInventory(domain, 'current', composition, 10)
    const writer = new SQLiteProposalFeedWriter(
      domain,
      journal,
      index,
      inventory,
      lifecycle,
      limits,
      () => now
    )
    domain.transaction(() => {
      journal[sqliteProposalBridge].initialize(create ? 'create' : 'open')
      index[sqliteLookupComposition].initialize(create)
      inventory.initialize(create)
      const entries = journal[sqliteProposalBridge].read('0', 256),
        records = new Map()
      for (const entry of entries)
        records.set(proposalChannelKey(entry.transition.next.proposal.body), entry.transition.next)
      inventory.verify([...records.values()])
    })
    return { db, domain, journal, index, inventory, writer }
  }
  const first = lifecycle.put(undefined, signed(), author, '10')
  return {
    ...open(true),
    open,
    lifecycle,
    first,
    path,
    now: (value: string) => {
      now = value
    }
  }
}
const commit = (f: ReturnType<typeof fixture>, transition = f.first) =>
  f.writer.commit([{ transition }])

it('publishes two journal entries as one indivisible lookup group and replays without a duplicate group', async () => {
  const f = fixture(),
    second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  const result = await f.writer.commit([{ transition: f.first }, { transition: second }])
  expect(result.entries).toEqual([
    { status: 'committed', revision: '1' },
    { status: 'committed', revision: '2' }
  ])
  expect(result.group?.changes).toHaveLength(2)
  expect((await f.index.head()).sequence).toBe('1')
  expect((await f.journal.head()).reserved).toEqual({ entries: 0, bytes: 0 })
  expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
    active: 2,
    finalizing: 0
  })
  const replay = await f.writer.commit([{ transition: f.first }, { transition: second }])
  expect(replay.group).toBeUndefined()
  expect(replay.entries.every(entry => entry.status === 'replayed')).toBe(true)
  expect((await f.index.head()).sequence).toBe('1')
})

it('makes mixed replay/new semantics explicit and does not regroup the previous event', async () => {
  const f = fixture()
  await commit(f)
  const second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  const result = await f.writer.commit([{ transition: f.first }, { transition: second }])
  expect(result.entries).toEqual([
    { status: 'replayed', revision: '1' },
    { status: 'committed', revision: '2' }
  ])
  expect(result.group?.sequence).toBe('2')
  expect(result.group?.changes).toHaveLength(1)
  expect(result.group?.changes[0].after?.value).toEqual(proposalFeedValue(second.next))
  expect((await f.index.group('1')).changes).toHaveLength(1)
})

it('rejects a repeated channel before committing any entry', async () => {
  const f = fixture()
  await expect(
    f.writer.commit([{ transition: f.first }, { transition: f.first }])
  ).rejects.toMatchObject({ code: 'invalid' })
  expect((await f.journal.head()).revision).toBe('0')
  expect((await f.index.head()).sequence).toBe('0')
})

it.each([{ entries: 1 }, { groups: 1 }, { versions: 1 }, { bytes: 28000 }])(
  'reserves future journal and lookup capacity before accepting a new head: %j',
  async options => {
    const f = fixture(options)
    await expect(commit(f)).rejects.toMatchObject({ code: 'limited' })
    expect((await f.journal.head()).revision).toBe('0')
    expect((await f.index.head()).sequence).toBe('0')
    expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
      active: 0,
      finalizing: 0
    })
  }
)

it('uses the held final entry/group capacity to expire a head at the exact bound', async () => {
  const f = fixture({ entries: 2, groups: 2, versions: 2 })
  await commit(f)
  f.now('100')
  const result = await f.writer.advanceTime('100', 1)
  expect(result).toMatchObject({
    expired: 1,
    complete: true,
    head: { sequence: '2', processedThrough: '100' }
  })
  expect((await f.journal.head()).entries).toBe(2)
  expect(
    (await f.journal.getChannel(proposalChannelKey(f.first.next.proposal.body)))?.state.status
  ).toBe('expired')
  expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
    active: 0,
    finalizing: 0
  })
})

it('does not claim full timer coverage after a bounded partial drain, including after reopening', async () => {
  const f = fixture(),
    second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  await f.writer.commit([{ transition: f.first }, { transition: second }])
  expect(await f.writer.advanceTime('10', 1)).toMatchObject({
    expired: 0,
    complete: true,
    head: { processedThrough: '10' }
  })
  f.now('100')
  const partial = await f.writer.advanceTime('100', 1)
  expect(partial).toMatchObject({
    expired: 1,
    complete: false,
    head: { sequence: '2', processedThrough: '10' }
  })
  expect((await f.index.head()).processedThrough).toBe('100')
  f.domain.close()
  const reopened = f.open(false)
  expect(await reopened.writer.head()).toMatchObject({ processedThrough: '10', sequence: '2' })
  expect(await reopened.writer.advanceTime('100', 1)).toMatchObject({
    expired: 1,
    complete: true,
    head: { sequence: '3', processedThrough: '100' }
  })
  expect((await reopened.index.group('3')).changes[0].after?.value.data.state).toEqual({
    status: 'expired',
    recordedAt: '100'
  })
})

it('retains local recovery context during expiry and never confuses intent expiry with row eviction', async () => {
  const f = fixture(),
    local = { retainedContract: 'private-local-context' }
  await f.writer.commit([{ transition: f.first, local }])
  f.now('100')
  await f.writer.advanceTime('100', 2)
  expect(
    (await f.journal.getChannelEntry(proposalChannelKey(f.first.next.proposal.body)))?.local
  ).toEqual(local)
  const group = await f.index.group('2')
  expect(group.changes[0].after?.value.expiresAt).toBeNull()
  expect(group.changes[0].after?.value.data).not.toHaveProperty('local')
  expect(group.changes[0].after?.value.data.state).toEqual({ status: 'expired', recordedAt: '100' })
})

it('rechecks exclusive intent expiry at the write gate, while exact retries remain recoverable', async () => {
  const f = fixture()
  f.now('100')
  await expect(commit(f)).rejects.toMatchObject({ code: 'expired' })
  expect((await f.journal.head()).revision).toBe('0')
  f.now('10')
  await expect(commit(f)).rejects.toMatchObject({ code: 'context-changed' })
  const g = fixture()
  await commit(g)
  g.now('100')
  expect((await commit(g)).entries).toEqual([{ status: 'replayed', revision: '1' }])
  const replacement = g.lifecycle.put(
    g.first.next,
    signed({ revision: '1', previous: g.first.next.proposalId, issuedAt: '11', expiresAt: '110' }),
    author,
    '11'
  )
  await expect(commit(g, replacement)).rejects.toMatchObject({ code: 'expired' })
  expect((await g.journal.head()).revision).toBe('1')
})

it('does not expire a reserved job and retains its terminal outcome after intent expiry', async () => {
  const f = fixture({ entries: 3, groups: 3, versions: 3 })
  await commit(f)
  const tx = finalize(f.first.next.proposal),
    reserve = f.lifecycle.reserve(
      f.first.next,
      author,
      {
        version: 1,
        service: scope.service,
        proposalId: f.first.next.proposalId,
        operationId: 'aa'.repeat(32),
        txid: tx.id('hex'),
        beef: 'AA=='
      },
      Utils.toBase64(tx.toBinary()),
      '11'
    )
  f.now('11')
  await commit(f, reserve)
  expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
    active: 0,
    finalizing: 1
  })
  f.now('101')
  expect(await f.writer.advanceTime('101', 10)).toMatchObject({ expired: 0, complete: true })
  const done = f.lifecycle.complete(
    reserve.next,
    {
      status: 'admitted',
      operationId: 'aa'.repeat(32),
      txid: tx.id('hex'),
      steak: {},
      assessmentContextId: 'topic-view'
    },
    '101'
  )
  await commit(f, done)
  expect((await f.journal.head()).reserved).toEqual({ entries: 0, bytes: 0 })
  expect((await f.index.group('3')).changes[0].after?.value.data.state).toEqual(done.next.state)
})

it('rolls back an entire group and its staged caches if a later entry conflicts', async () => {
  const f = fixture(),
    second = f.lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
  second.expectedToken = 'aa'.repeat(32)
  await expect(
    f.writer.commit([{ transition: f.first }, { transition: second }])
  ).rejects.toMatchObject({ code: 'conflict' })
  expect((await f.journal.head()).revision).toBe('0')
  expect((await f.index.head()).sequence).toBe('0')
  expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
    active: 0,
    finalizing: 0
  })
  expect((await commit(f)).entries[0]).toEqual({ status: 'committed', revision: '1' })
})

it('rolls back all participants after a physical lookup append failure and then retries coherently', async () => {
  const f = fixture()
  f.db.exec(
    "CREATE TRIGGER reject_feed BEFORE INSERT ON output_lookup_groups BEGIN SELECT RAISE(ABORT,'injected index write failure'); END;"
  )
  await expect(commit(f)).rejects.toThrow(/injected/)
  expect((await f.journal.head()).revision).toBe('0')
  expect(f.domain.transaction(() => f.inventory.obligations())).toEqual({
    active: 0,
    finalizing: 0
  })
  f.db.exec('DROP TRIGGER reject_feed')
  expect((await commit(f)).group?.sequence).toBe('1')
})

it('rejects broken participant boundaries and timer requests ahead of actual time', async () => {
  const f = fixture()
  await expect(f.writer.advanceTime('11', 1)).rejects.toMatchObject({ code: 'invalid' })
  for (const n of [0, -1, 1025, 1.5])
    await expect(f.writer.advanceTime('10', n)).rejects.toMatchObject({ code: 'invalid' })
  await expect(f.writer.commit([])).rejects.toMatchObject({ code: 'invalid' })
  f.db.prepare('UPDATE proposal_feed_meta SET index_sequence=?').run('0000000000000001')
  await expect(commit(f)).rejects.toThrow(/atomic commit boundary/)
})

it('uses actual independent SQLite writers to resolve competing successors without splitting participants', async () => {
  const f = fixture()
  await commit(f)
  const other = f.open(false)
  const winner = f.lifecycle.put(
    f.first.next,
    signed({ revision: '1', previous: f.first.next.proposalId, issuedAt: '11' }),
    author,
    '11'
  )
  const loser = f.lifecycle.put(
    f.first.next,
    signed({ revision: '1', previous: f.first.next.proposalId, issuedAt: '12' }),
    author,
    '12'
  )
  f.now('12')
  await f.writer.commit([{ transition: winner }])
  await expect(other.writer.commit([{ transition: loser }])).rejects.toMatchObject({
    code: 'conflict'
  })
  expect((await other.journal.head()).revision).toBe('2')
  expect((await other.index.head()).sequence).toBe('2')
  expect((await other.index.group('2')).changes[0].after?.value.data.proposal).toEqual(
    winner.next.proposal
  )
  expect((await other.writer.commit([{ transition: winner }])).entries[0].status).toBe('replayed')
})

it('fails closed on missing or inconsistent durable inventory during restart', async () => {
  const f = fixture()
  await commit(f)
  f.db.prepare('DELETE FROM proposal_feed_channels').run()
  f.domain.close()
  expect(() => f.open(false)).toThrow(/incomplete/)
  const g = fixture()
  await commit(g)
  g.db.prepare("UPDATE proposal_feed_channels SET expires_at='0000000000000000'").run()
  g.domain.close()
  expect(() => g.open(false)).toThrow(/differs/)
})

it('does not let a future timestamp or a retained backward clock escape a failed commit', async () => {
  const f = fixture(),
    future = f.lifecycle.put(undefined, signed({ issuedAt: '11' }), author, '11')
  await expect(commit(f, future)).rejects.toMatchObject({ code: 'context-changed' })
  expect((await f.journal.head()).revision).toBe('0')
  expect((await f.index.head()).sequence).toBe('0')
  f.now('9')
  await expect(commit(f)).rejects.toMatchObject({ code: 'context-changed' })
  f.now('10')
  await commit(f)
})

it('rejects invalid inventory bounds and duplicate initialization without replacing retained metadata', () => {
  const f = fixture()
  for (const limit of [0, -1, 1025, 1.5, Number.NaN])
    expect(() => new SQLiteProposalFeedInventory(f.domain, 'other', {}, limit)).toThrow(
      /inventory bound/
    )
  const original = f.domain.transaction(() => f.inventory.head())
  expect(() => f.domain.transaction(() => f.inventory.initialize(true))).toThrow(/already exists/)
  expect(f.domain.transaction(() => f.inventory.head())).toEqual(original)
})

it.each([
  ["UPDATE proposal_feed_meta SET configuration='{}'", /configuration/],
  ["UPDATE proposal_feed_meta SET processed_at='0000000000000001'", /timer floor/]
])('refuses inconsistent persisted inventory metadata: %s', (sql, message) => {
  const f = fixture()
  f.db.exec(sql as string)
  expect(() => f.domain.transaction(() => f.inventory.head())).toThrow(message as RegExp)
})

it('keeps inventory commit positions and processed time monotonic within their bounds', () => {
  const f = fixture()
  f.domain.transaction(() => {
    f.inventory.observe('10', '0')
    f.inventory.seal('4', '5')
  })
  for (const [journal, index] of [
    ['3', '5'],
    ['4', '4']
  ])
    expect(() => f.domain.transaction(() => f.inventory.seal(journal, index))).toThrow(/backwards/)
  expect(() => f.domain.transaction(() => f.inventory.processed('11'))).toThrow(/observed clock/)
  for (const count of [0, -1, 1025, 1.5, Number.NaN])
    expect(() => f.domain.transaction(() => f.inventory.due('10', count))).toThrow(/work bound/)
  expect(f.domain.transaction(() => f.inventory.processed('10'))).toBe(true)
  expect(f.domain.transaction(() => f.inventory.processed('9'))).toBe(true)
  expect(f.domain.transaction(() => f.inventory.head())).toEqual({
    journal: '4',
    index: '5',
    clock: '10',
    processedThrough: '10'
  })
})

it('bounds actual persisted inventory and rejects unknown lifecycle states', async () => {
  const f = fixture()
  await commit(f)
  f.db.exec("UPDATE proposal_feed_channels SET status='unknown'")
  expect(() => f.domain.transaction(() => f.inventory.obligations())).toThrow(/status\/count/)
  f.db.exec("UPDATE proposal_feed_channels SET status='active'")
  const insert = f.db.prepare('INSERT INTO proposal_feed_channels VALUES (?,?,?,?,?,?)')
  for (let i = 0; i < 10; i++)
    insert.run('current', 'extra-' + i, 'extra-' + i, '00'.repeat(32), 'withdrawn', null)
  expect(() => f.domain.transaction(() => f.inventory.obligations())).toThrow(/inventory is full/)
})

it('rejects oversized, duplicate and unexpected startup channel inventories', async () => {
  const f = fixture()
  await commit(f)
  expect(() =>
    f.domain.transaction(() => f.inventory.verify(Array(11).fill(f.first.next)))
  ).toThrow(/exceeds capacity/)
  expect(() =>
    f.domain.transaction(() => f.inventory.verify([f.first.next, f.first.next]))
  ).toThrow(/incomplete/)
  expect(() =>
    f.domain.transaction(() =>
      f.inventory.check(proposalChannelKey(f.first.next.proposal.body), undefined)
    )
  ).toThrow(/differs/)
})

it('rejects a participant that no longer returns its committed row before appending a replacement', async () => {
  const original = Object.getOwnPropertyDescriptor(
    SQLiteLookupIndexStore.prototype,
    sqliteLookupComposition
  )!.get!
  let unavailable = false
  jest
    .spyOn(SQLiteLookupIndexStore.prototype, sqliteLookupComposition, 'get')
    .mockImplementation(function (this: SQLiteLookupIndexStore) {
      const bridge = original.call(this) as SQLiteLookupIndexStore[typeof sqliteLookupComposition]
      return { ...bridge, row: key => (unavailable ? null : bridge.row(key)) }
    })
  const f = fixture()
  await commit(f)
  const replacement = f.lifecycle.put(
    f.first.next,
    signed({ revision: '1', previous: f.first.next.proposalId }),
    author,
    '10'
  )
  unavailable = true
  await expect(commit(f, replacement)).rejects.toThrow(/row differs/)
  unavailable = false
  expect((await f.journal.head()).revision).toBe('1')
  expect((await f.index.head()).sequence).toBe('1')
})

it('does not advance the expiry floor when the journal participant cannot supply its due head', async () => {
  const original = Object.getOwnPropertyDescriptor(
    SQLiteProposalJournalStore.prototype,
    sqliteProposalBridge
  )!.get!
  let unavailable = false
  jest
    .spyOn(SQLiteProposalJournalStore.prototype, sqliteProposalBridge, 'get')
    .mockImplementation(function (this: SQLiteProposalJournalStore) {
      const bridge = original.call(this) as SQLiteProposalJournalStore[typeof sqliteProposalBridge]
      return {
        ...bridge,
        channelEntry: key => (unavailable ? undefined : bridge.channelEntry(key))
      }
    })
  const f = fixture()
  await commit(f)
  f.now('100')
  unavailable = true
  await expect(f.writer.advanceTime('100', 1)).rejects.toThrow(/lost its journal head/)
  unavailable = false
  expect(await f.writer.head()).toMatchObject({ sequence: '1', processedThrough: '0' })
  expect(await f.writer.advanceTime('100', 1)).toMatchObject({ expired: 1, complete: true })
})
