import { afterEach, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { author, scope, registry, signed } from './proposal-fixture.js'

const lifecycle = new ProposalTransitions(registry, scope, {
  maxLifetimeSeconds: '100',
  futureSkewSeconds: '2'
})
const stores: SQLiteProposalJournal[] = [],
  directories: string[] = []
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-open-'))
  directories.push(directory)
  return join(directory, 'journal.sqlite')
}
function track(store: SQLiteProposalJournal): SQLiteProposalJournal {
  stores.push(store)
  return store
}
function rows(path: string, sql: string): unknown[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('never creates a missing database while recovering an existing namespace', () => {
  const path = file()
  expect(() => SQLiteProposalJournal.open(path, 'existing', author, lifecycle)).toThrow(
    expect.objectContaining({ code: 'ENOENT' })
  )
  expect(existsSync(path)).toBe(false)
})

it('never initializes tables in an empty existing file', () => {
  const path = file()
  writeFileSync(path, '')
  expect(() => SQLiteProposalJournal.open(path, 'existing', author, lifecycle)).toThrow()
  expect(rows(path, "SELECT name FROM sqlite_schema WHERE type='table'")).toEqual([])
})

it('creates a namespace deliberately, rejects recreation, and recovers exact committed state', async () => {
  const path = file(),
    store = track(SQLiteProposalJournal.create(path, 'original', author, lifecycle))
  const first = lifecycle.put(undefined, signed(), author, '10')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(await store.commit(first)).toEqual({ status: 'committed', revision: '1' })
  expect(() => SQLiteProposalJournal.create(path, 'original', author, lifecycle)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
  expect(await store.getChannel(proposalChannelKey(first.next.proposal.body))).toEqual(first.next)
  await store.close()
  const reopened = track(SQLiteProposalJournal.open(path, 'original', author, lifecycle))
  expect(await reopened.head()).toMatchObject({ revision: '1', entries: 1, channels: 1 })
  expect((await reopened.read('0', 1))[0].transition).toEqual(first)
  expect(await reopened.commit(first)).toEqual({ status: 'replayed', revision: '1' })
})

it('rejects an absent namespace without adding metadata', async () => {
  const path = file(),
    store = track(SQLiteProposalJournal.create(path, 'original', author, lifecycle))
  const before = rows(path, 'SELECT * FROM proposal_journal_meta')
  expect(() => SQLiteProposalJournal.open(path, 'missing', author, lifecycle)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(rows(path, 'SELECT * FROM proposal_journal_meta')).toEqual(before)
  expect(await store.head()).toMatchObject({ revision: '0' })
})

it('cannot silently duplicate the service identity in another namespace', () => {
  const path = file()
  track(SQLiteProposalJournal.create(path, 'original', author, lifecycle))
  expect(() => SQLiteProposalJournal.create(path, 'other', author, lifecycle)).toThrow()
  expect(rows(path, 'SELECT namespace FROM proposal_journal_meta')).toEqual([
    { namespace: 'original' }
  ])
})

it('does not repair a missing capacity seal during recovery and preserves legacy explicit upgrade behavior', async () => {
  const path = file(),
    store = track(SQLiteProposalJournal.create(path, 'original', author, lifecycle))
  await store.close()
  const db = new DatabaseSync(path)
  db.exec('DELETE FROM proposal_journal_capacity')
  db.close()
  expect(() => SQLiteProposalJournal.open(path, 'original', author, lifecycle)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(rows(path, 'SELECT * FROM proposal_journal_capacity')).toEqual([])
  const legacy = track(new SQLiteProposalJournal(path, 'original', author, lifecycle))
  expect(await legacy.head()).toMatchObject({ revision: '0' })
  expect(rows(path, 'SELECT * FROM proposal_journal_capacity')).toHaveLength(1)
})

it('requires the same sealed limits and installed interpretation on reopen', async () => {
  const path = file(),
    store = track(SQLiteProposalJournal.create(path, 'original', author, lifecycle))
  await store.close()
  expect(() =>
    SQLiteProposalJournal.open(path, 'original', author, lifecycle, { entries: 100 })
  ).toThrow(expect.objectContaining({ code: 'context-changed' }))
  const changed = new ProposalTransitions(registry, scope, {
    maxLifetimeSeconds: '101',
    futureSkewSeconds: '2'
  })
  expect(() => SQLiteProposalJournal.open(path, 'original', author, changed)).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  expect(
    await track(SQLiteProposalJournal.open(path, 'original', author, lifecycle)).head()
  ).toMatchObject({ revision: '0' })
})

it('keeps the legacy constructor create-or-open contract', async () => {
  const path = file(),
    first = track(new SQLiteProposalJournal(path, 'legacy', author, lifecycle))
  const second = track(new SQLiteProposalJournal(path, 'legacy', author, lifecycle))
  const transition = lifecycle.put(undefined, signed(), author, '10')
  expect(await first.commit(transition)).toMatchObject({ status: 'committed' })
  expect(await second.getChannel(proposalChannelKey(transition.next.proposal.body))).toEqual(
    transition.next
  )
})

it('validates open modes before file creation', () => {
  const path = file()
  expect(
    () => new SQLiteProposalJournal(path, 'original', author, lifecycle, {}, 'other' as never)
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  expect(existsSync(path)).toBe(false)
})

it.each([':memory:', 'file:temporary'])('rejects a non-durable path %s for every mode', path => {
  for (const mode of ['create', 'open', 'create-or-open'] as const)
    expect(() => new SQLiteProposalJournal(path, 'original', author, lifecycle, {}, mode)).toThrow(
      'ordinary file path'
    )
})
