import { describe, it, expect, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import {
  MemoryJournal,
  IndexedDBJournal,
  knowledgeMutation,
  appendJournalWithRecovery,
  journalPayload,
  parseJournalPayload,
  DEFAULT_JOURNAL_LIMITS,
  type JournalStorage,
  type JournalLimits
} from '../src/index.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { OutputProtocolError } from '@bsv/sdk'

const directories: string[] = []
const stores: JournalStorage[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'output-journal-'))
  directories.push(directory)
  return join(directory, 'journal.sqlite')
}
const mutation = (reason = 'test') =>
  knowledgeMutation({ kind: 'invalidate', generation: '0', assessmentIds: [], reason })

it('detects altered local replay material while preserving legacy body-only decoding', () => {
  const input = mutation()
  const frame = journalPayload(input, DEFAULT_JOURNAL_LIMITS, {
    profile: 'urn:example:verification',
    verified: true
  })
  expect(parseJournalPayload(frame.text).body).toEqual(input.body)
  const corrupt = JSON.parse(frame.text)
  corrupt.local.verified = false
  expect(() => parseJournalPayload(JSON.stringify(corrupt))).toThrow('integrity')
  expect(parseJournalPayload(JSON.stringify(input.body))).toEqual({ body: input.body })
})

type Factory = (limits?: Partial<JournalLimits>) => Promise<JournalStorage>
const adapters: { name: string; create: Factory }[] = [
  { name: 'memory', create: async limits => new MemoryJournal('partition', limits) },
  {
    name: 'SQLite WAL',
    create: async limits => new SQLiteJournal(databasePath(), 'partition', limits)
  },
  {
    name: 'IndexedDB',
    create: async limits =>
      await IndexedDBJournal.open('test', 'partition', {
        factory: new IDBFactory(),
        keyRange: IDBKeyRange,
        limits
      })
  }
]

describe.each(adapters)('$name journal contract', ({ create }) => {
  async function open(limits?: Partial<JournalLimits>): Promise<JournalStorage> {
    const store = await create(limits)
    stores.push(store)
    return store
  }
  it('atomically retains bounded local replay material without changing the mutation key or legacy body', async () => {
    const store = await open(),
      input = mutation(),
      local = {
        profile: 'urn:example:local-verification',
        version: 1,
        receipts: ['receipt-a'],
        context: 'view-a'
      }
    expect((await store.append('0', input, local)).status).toBe('committed')
    local.receipts.push('caller-mutation')
    const entry = (await store.read('0', 1))[0]
    expect(entry.body).toEqual(input.body)
    expect(entry.local).toEqual({
      profile: 'urn:example:local-verification',
      version: 1,
      receipts: ['receipt-a'],
      context: 'view-a'
    })
    expect(entry.localDigest).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.append('999', input, { profile: 'different-retry-metadata' })).status).toBe(
      'replayed'
    )
    const saved = await store.getMutation(input.key)
    expect(saved.status === 'committed' && saved.entry.local).toEqual(entry.local)
    expect((await store.head()).entries).toBe(1)
  })
  it('commits revisions, freezes caller data and replays before checking revision', async () => {
    const store = await open()
    const first = mutation()
    expect(await store.append('0', first)).toEqual({
      status: 'committed',
      revision: { received: '1', accepted: '1' }
    })
    expect(await store.append('999', first)).toEqual({
      status: 'replayed',
      revision: { received: '1', accepted: '1' }
    })
    const result = await store.getMutation(first.key)
    expect(result.status).toBe('committed')
    if (result.status === 'committed') result.entry.revision.received = '100'
    expect((await store.head()).received).toBe('1')
    expect(await store.read('0', 10)).toEqual([
      { ...first, revision: { received: '1', accepted: '1' } }
    ])
    expect(await store.getMutation('00'.repeat(32))).toEqual({ status: 'absent' })
    expect(await store.read('18446744073709551615', 10)).toEqual([])
  })

  it('does not advance accepted revision for durably pending receipts', async () => {
    const store = await open()
    const chain = { network: 'test', genesisHash: '00'.repeat(32) }
    const partition = { application: 'test', account: 'alice', access: 'private' }
    const scope = {
      chain,
      provider: 'configured',
      service: 'test',
      queryDigest: '00'.repeat(32),
      rulesDigest: '00'.repeat(32),
      access: 'private',
      epoch: 'one'
    }
    const receipt = knowledgeMutation({
      kind: 'receive',
      batch: {
        provenance: {
          partition,
          generation: '0',
          adapter: 'direct',
          scope,
          authentication: 'configured-transport',
          peer: 'alice',
          receivedAt: '1'
        },
        groups: [],
        coverage: { scope, phase: 'finite', status: 'complete' }
      }
    })
    expect(await store.append('0', receipt)).toEqual({
      status: 'committed',
      revision: { received: '1', accepted: '0' }
    })
    expect(await store.append('1', mutation())).toEqual({
      status: 'committed',
      revision: { received: '2', accepted: '1' }
    })
    expect((await store.read('0', 1))[0].body.kind).toBe('receive')
    expect((await store.read('1', 1))[0].body.kind).toBe('invalidate')
  })

  it('serializes concurrent compare-and-swap attempts and preserves equivocation evidence', async () => {
    const store = await open()
    const a = mutation('a'),
      b = mutation('b')
    const outcomes = await Promise.all([store.append('0', a), store.append('0', b)])
    expect(outcomes.map(result => result.status).sort()).toEqual(['committed', 'conflict'])
    const winner = outcomes[0].status === 'committed' ? a : b
    const changed = { key: winner.key, body: mutation('changed').body }
    expect(await store.append('1', changed)).toMatchObject({
      status: 'equivocation',
      reason: expect.stringMatching(/\S/)
    })
    expect((await store.head()).entries).toBe(1)
    expect((await store.read('0', 10))[0].body).toEqual(winner.body)
  })

  it('charges exact UTF-8 retention bytes and refuses overflow without forgetting replay identities', async () => {
    const first = mutation('retained \u03bb record'),
      second = mutation('another \u754c record'),
      firstBytes = new TextEncoder().encode(JSON.stringify(first.body)).length,
      secondBytes = new TextEncoder().encode(JSON.stringify(second.body)).length,
      store = await open({ bytes: firstBytes + secondBytes - 1, entries: 10 })
    expect((await store.append('0', first)).status).toBe('committed')
    expect((await store.head()).bytes).toBe(firstBytes)
    expect((await store.append('1', second)).status).toBe('limited')
    expect((await store.head()).bytes).toBe(firstBytes)
    expect((await store.append('999', first)).status).toBe('replayed')
    expect((await store.head()).entries).toBe(1)
  })

  it('resolves commit-before-reply uncertainty by the same key without writing again', async () => {
    const store = await open()
    let writes = 0
    const uncertain: JournalStorage = {
      durability: store.durability,
      namespace: store.namespace,
      head: () => store.head(),
      getMutation: key => store.getMutation(key),
      read: (after, count) => store.read(after, count),
      close: () => store.close(),
      append: async (expected, value) => {
        writes++
        await store.append(expected, value)
        throw new OutputProtocolError('unavailable', 'lost response', true)
      }
    }
    expect(await appendJournalWithRecovery(uncertain, '0', mutation())).toEqual({
      status: 'replayed',
      revision: { received: '1', accepted: '1' }
    })
    expect(writes).toBe(1)
    expect((await store.head()).entries).toBe(1)
  })

  it('enforces retention without partial writes and validates digests and read bounds', async () => {
    const store = await open({ entries: 1 })
    await expect(store.append('0', { ...mutation(), key: '00'.repeat(32) })).rejects.toThrow(
      'digest'
    )
    await store.append('0', mutation('a'))
    expect((await store.append('1', mutation('b'))).status).toBe('limited')
    expect((await store.head()).entries).toBe(1)
    for (const maximum of [0, -1, 4097, Infinity, 0.5])
      await expect(store.read('0', maximum)).rejects.toThrow('bound')
    await expect(store.read('01', 1)).rejects.toThrow('U64')
    await store.close()
    await expect(store.head()).rejects.toThrow('closed')
  })
})

describe('durable storage qualification', () => {
  it('reopens SQLite and isolates independent namespaces and connections', async () => {
    const path = databasePath(),
      a = new SQLiteJournal(path, 'alice'),
      b = new SQLiteJournal(path, 'bob')
    stores.push(a, b)
    await a.append('0', mutation())
    expect((await b.head()).received).toBe('0')
    await a.close()
    const recovered = new SQLiteJournal(path, 'alice')
    stores.push(recovered)
    expect((await recovered.read('0', 1))[0].key).toBe(mutation().key)
    const otherConnection = new SQLiteJournal(path, 'alice')
    stores.push(otherConnection)
    await recovered.append('1', mutation('second'))
    expect((await otherConnection.append('1', mutation('third'))).status).toBe('conflict')
    expect((await otherConnection.head()).received).toBe('2')
  })

  it('recovers a real process exit after a FULL WAL commit before acknowledging receipt', async () => {
    const path = databasePath()
    const sqliteModule = new URL('../dist/storage/SQLiteJournal.js', import.meta.url).href
    const script = `import { SQLiteJournal } from ${JSON.stringify(sqliteModule)}; const s = new SQLiteJournal(process.argv[1], 'crash'); await s.append('0', JSON.parse(process.argv[2])); process.exit(73);`
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, path, JSON.stringify(mutation())],
      { encoding: 'utf8', cwd: resolve('.') }
    )
    expect({
      status: child.status,
      error: child.error?.message,
      stderr: child.stderr.replace(
        /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use .*?\n/g,
        ''
      )
    }).toEqual({ status: 73, error: undefined, stderr: '' })
    const recovered = new SQLiteJournal(path, 'crash')
    stores.push(recovered)
    expect((await recovered.getMutation(mutation().key)).status).toBe('committed')
    expect((await recovered.append('0', mutation())).status).toBe('replayed')
    expect((await recovered.head()).entries).toBe(1)
  })

  it('reopens IndexedDB without losing pending receipt or mutation identity', async () => {
    const factory = new IDBFactory(),
      options = { factory, keyRange: IDBKeyRange }
    const a = await IndexedDBJournal.open('restart', 'alice', options)
    stores.push(a)
    await a.append('0', mutation())
    await a.close()
    const b = await IndexedDBJournal.open('restart', 'alice', options)
    stores.push(b)
    expect((await b.append('0', mutation())).status).toBe('replayed')
    expect((await b.read('0', 2))[0].revision).toEqual({ received: '1', accepted: '1' })
    const other = await IndexedDBJournal.open('restart', 'bob', options)
    stores.push(other)
    expect((await other.head()).entries).toBe(0)
  })
})
