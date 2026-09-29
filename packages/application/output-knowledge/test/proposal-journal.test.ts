import { afterEach, describe, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  OutputProtocolError,
  Utils,
  type OutputSignedProposal
} from '@bsv/sdk'
import {
  appendProposalWithRecovery,
  MemoryProposalJournal,
  proposalChannelKey,
  proposalCommitKey,
  ProposalTransitions,
  ProposalPolicyRegistry,
  AuthorDocumentPolicy,
  type ProposalJournalLimits,
  type ProposalJournalStorage,
  type ProposalTransition
} from '../src/proposals/index.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import { author, recipient, scope, registry, signed, finalize } from './proposal-fixture.js'

const clock = { maxLifetimeSeconds: '100', futureSkewSeconds: '2' }
const lifecycle = new ProposalTransitions(registry, scope, clock)
const stores: ProposalJournalStorage[] = []
const directories: string[] = []
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-journal-'))
  directories.push(directory)
  return join(directory, 'journal.sqlite')
}
function publication(proposal: OutputSignedProposal = signed()): ProposalTransition {
  return lifecycle.put(undefined, proposal, author, '10')
}
function reservation(
  plan: ProposalTransition,
  operationId = 'original-operation-id'
): ProposalTransition {
  const tx = finalize(plan.next.proposal)
  return lifecycle.reserve(
    plan.next,
    author,
    {
      version: 1,
      operationId,
      service: scope.service,
      proposalId: plan.next.proposalId,
      txid: tx.id('hex'),
      beef: 'AA=='
    },
    Utils.toBase64(tx.toBinary()),
    '99'
  )
}
function completed(plan: ProposalTransition): ProposalTransition {
  const job = plan.next.admission!
  return lifecycle.complete(
    plan.next,
    {
      status: 'admitted',
      operationId: job.operationId,
      txid: job.txid,
      steak: {},
      assessmentContextId: 'topic-view'
    },
    '101'
  )
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.each(['memory', 'sqlite'] as const)('%s proposal journal contract', kind => {
  function open(limits: Partial<ProposalJournalLimits> = {}): ProposalJournalStorage {
    const store =
      kind === 'memory'
        ? new MemoryProposalJournal('proposal-test', author, lifecycle, limits)
        : new SQLiteProposalJournal(path(), 'proposal-test', author, lifecycle, limits)
    stores.push(store)
    return store
  }

  it('commits record and events together, preserves historical retries and returns owned reads', async () => {
    const store = open(),
      first = publication(),
      key = proposalChannelKey(first.next.proposal.body)
    expect(store.durability).toBe(kind === 'memory' ? 'volatile' : 'durable')
    expect(await store.getChannel(key)).toBeUndefined()
    expect(await store.getProposal(first.next.proposalId)).toBeUndefined()
    expect(await store.getCommit(proposalCommitKey(first))).toBeUndefined()
    expect(await store.commit(first)).toEqual({ status: 'committed', revision: '1' })
    expect((await store.read('0', 1))[0].transition.events).toEqual(first.events)
    const next = lifecycle.put(
      first.next,
      signed({ revision: '1', previous: first.next.proposalId }),
      author,
      '11'
    )
    expect(await store.commit(next)).toEqual({ status: 'committed', revision: '2' })
    expect(await store.commit(first)).toEqual({ status: 'replayed', revision: '1' })
    expect(await store.getProposal(first.next.proposalId)).toEqual({
      record: first.next,
      current: false
    })
    expect(await store.getProposal(next.next.proposalId)).toEqual({
      record: next.next,
      current: true
    })
    const current = await store.getChannel(key)
    expect(current).toEqual(next.next)
    current!.state.recordedAt = '999'
    expect((await store.getChannel(key))?.state.recordedAt).toBe('11')
    const journal = await store.read('0', 256)
    journal[0].transition.events.length = 0
    expect((await store.getCommit(proposalCommitKey(first)))?.transition.events).toHaveLength(2)
    expect((await store.head()).entries).toBe(2)
    expect((await store.read('1', 1)).map(entry => entry.revision)).toEqual(['2'])
    expect(await store.read('18446744073709551615', 1)).toEqual([])
    expect(await store.commit(lifecycle.put(next.next, next.next.proposal, author, '500'))).toEqual(
      { status: 'replayed', revision: '2' }
    )
  })

  it.each([true, false])(
    'lets exactly one expiry/reservation win a shared token (reserve first: %s)',
    async reserveFirst => {
      const store = open(),
        first = publication(),
        reserved = reservation(first),
        expired = lifecycle.expire(first.next, '100')
      await store.commit(first)
      const [winner, loser] = reserveFirst ? [reserved, expired] : [expired, reserved]
      expect(await Promise.all([store.commit(winner), store.commit(loser)])).toEqual([
        { status: 'committed', revision: '2' },
        { status: 'conflict', reason: 'Proposal head changed' }
      ])
      expect(await store.getChannel(proposalChannelKey(first.next.proposal.body))).toEqual(
        winner.next
      )
      expect(await store.read('1', 256)).toHaveLength(1)
      expect((await store.head()).entries).toBe(2)
    }
  )

  it('binds operation identity across channels and follows its exact terminal record', async () => {
    const store = open(),
      first = publication(),
      second = publication(signed({ channel: 'ff'.repeat(32) }))
    await store.commit(first)
    await store.commit(second)
    const reserved = reservation(first)
    await store.commit(reserved)
    expect(await store.getOperation(author, scope.service, 'original-operation-id')).toEqual(
      reserved.next
    )
    const before = await store.head()
    expect((await store.commit(reservation(second))).status).toBe('conflict')
    expect(await store.head()).toEqual(before)
    expect(
      (await store.getChannel(proposalChannelKey(second.next.proposal.body)))?.state.status
    ).toBe('active')
    const done = completed(reserved)
    await store.commit(done)
    expect(await store.getOperation(author, scope.service, 'original-operation-id')).toEqual(
      done.next
    )
    expect(
      await store.getOperation(recipient, scope.service, 'original-operation-id')
    ).toBeUndefined()
    expect(await store.getOperation(author, 'other', 'original-operation-id')).toBeUndefined()
    await expect(store.getOperation(author, scope.service, 'invalid:operation')).rejects.toThrow(
      'identifier'
    )
  })

  it('revalidates complete transition plans and retains terminal channel fences', async () => {
    const store = open(),
      first = publication()
    await store.commit(first)
    const plan = reservation(first)
    for (const invalid of [
      { ...plan, changed: 'yes' },
      { ...plan, events: [] },
      { ...plan, events: null },
      { ...plan, extra: true },
      { ...plan, next: { ...plan.next, admission: { ...plan.next.admission, requestedAt: '98' } } }
    ])
      await expect(store.commit(invalid as ProposalTransition)).rejects.toThrow()
    expect(
      (await store.commit({ ...completed(plan), expectedToken: plan.expectedToken })).status
    ).toBe('conflict')
    expect((await store.head()).entries).toBe(1)
    await store.commit(plan)
    const done = completed(plan)
    await store.commit(done)
    const rewritten = { ...done, expectedToken: proposalCommitKey(first), next: first.next }
    expect((await store.commit(rewritten)).status).toBe('conflict')
    expect(await store.getChannel(proposalChannelKey(first.next.proposal.body))).toEqual(done.next)
    expect((await store.head()).entries).toBe(3)
  })

  it('enforces exact byte, entry and principal capacity without deleting retry or terminal identities', async () => {
    const first = publication()
    const size = new TextEncoder().encode(canonicalOutputJSON(first)).length
    const exact = open({ bytes: size, entryBytes: size })
    expect((await exact.commit(first)).status).toBe('committed')
    expect((await exact.head()).bytes).toBe(size)
    expect((await exact.commit(lifecycle.expire(first.next, '100'))).status).toBe('limited')
    expect((await exact.commit(first)).status).toBe('replayed')
    const entries = open({ entries: 1 })
    await entries.commit(first)
    expect((await entries.commit(lifecycle.expire(first.next, '100'))).status).toBe('limited')
    const principals = open({ channelsPerAuthor: 1 })
    await principals.commit(first)
    await principals.commit(lifecycle.expire(first.next, '100'))
    expect(
      (await principals.commit(publication(signed({ channel: 'ff'.repeat(32) })))).status
    ).toBe('limited')
    expect((await principals.head()).channels).toBe(1)
    const channels = open({ channels: 1, channelsPerAuthor: 1 })
    await channels.commit(first)
    expect((await channels.commit(publication(signed({ channel: 'ee'.repeat(32) })))).status).toBe(
      'limited'
    )
    const small = open({ entryBytes: size - 1 })
    await expect(small.commit(first)).rejects.toThrow('limit')
    expect((await small.head()).entries).toBe(0)
  })

  it('persists definitive rejection and refuses a later contradictory admission result', async () => {
    const store = open(),
      first = publication(),
      plan = reservation(first)
    await store.commit(first)
    await store.commit(plan)
    const job = plan.next.admission!
    const failed = lifecycle.complete(
      plan.next,
      {
        status: 'rejected',
        operationId: job.operationId,
        txid: job.txid,
        reason: 'Configured topic declined'
      },
      '101'
    )
    expect((await store.commit(failed)).status).toBe('committed')
    expect((await store.getOperation(author, scope.service, job.operationId))?.state).toEqual(
      failed.next.state
    )
    expect((await store.commit(completed(plan))).status).toBe('conflict')
    expect((await store.head()).entries).toBe(3)
  })

  it('holds an entry for completion before admitting work and prevents unrelated writes from consuming it', async () => {
    const first = publication(),
      reserved = reservation(first),
      done = completed(reserved),
      other = publication(signed({ channel: 'ff'.repeat(32) }))
    const tooSmall = open({ entries: 2 })
    await tooSmall.commit(first)
    expect((await tooSmall.commit(reserved)).status).toBe('limited')
    expect(
      await tooSmall.getOperation(author, scope.service, 'original-operation-id')
    ).toBeUndefined()
    const store = open({ entries: 3 })
    expect(store.completionReservation).toBe('proposal-journal-completion/1')
    await store.commit(first)
    await store.commit(reserved)
    expect((await store.head()).reserved).toEqual({ bytes: 4194304, entries: 1 })
    expect((await store.commit(other)).status).toBe('limited')
    expect((await store.commit(reserved)).status).toBe('replayed')
    expect((await store.commit(done)).status).toBe('committed')
    expect((await store.head()).reserved).toEqual({ bytes: 0, entries: 0 })
    expect((await store.head()).entries).toBe(3)
  })

  it('charges atomic context against the exact byte reservation boundary and releases unused capacity', async () => {
    const first = publication(),
      reserved = reservation(first),
      done = completed(reserved),
      other = publication(signed({ channel: 'ff'.repeat(32) }))
    const local = { retainedContract: 'signed-provider-contract' }
    const probe = open()
    await probe.commit(first)
    await probe.commit(reserved, local)
    const used = (await probe.head()).bytes
    const entryBytes = 32768
    const small = open({ bytes: used + entryBytes - 1, entryBytes })
    await small.commit(first)
    expect((await small.commit(reserved, local)).status).toBe('limited')
    const exact = open({ bytes: used + entryBytes, entryBytes })
    await exact.commit(first)
    expect((await exact.commit(reserved, local)).status).toBe('committed')
    expect(await exact.head()).toMatchObject({
      bytes: used,
      reserved: { bytes: entryBytes, entries: 1 }
    })
    expect((await exact.commit(other)).status).toBe('limited')
    expect((await exact.commit(done, local)).status).toBe('committed')
    expect((await exact.commit(other)).status).toBe('committed')
    expect((await exact.head()).reserved).toEqual({ bytes: 0, entries: 0 })
  })

  it('returns complete entries within the read byte budget without advancing past an omitted entry', async () => {
    const first = publication(),
      reserved = reservation(first),
      done = completed(reserved)
    const entryBytes = Math.max(
      ...[first, reserved, done].map(
        plan => new TextEncoder().encode(canonicalOutputJSON(plan)).length
      )
    )
    const store = open({ entryBytes })
    await store.commit(first)
    await store.commit(reserved)
    await store.commit(done)
    expect((await store.read('0', 256)).map(entry => entry.revision)).toEqual(['1'])
    expect((await store.read('1', 256)).map(entry => entry.revision)).toEqual(['2'])
    expect((await store.read('2', 256)).map(entry => entry.revision)).toEqual(['3'])
  })

  it('atomically retains bounded local context while preserving body-only history and replay identity', async () => {
    const store = open(),
      first = publication(),
      reserved = reservation(first)
    await store.commit(first)
    const local = {
      profile: 'urn:test:retained-contract:1',
      version: 1,
      contract: { digest: '01'.repeat(32), selectedAt: '99' }
    }
    const saved = structuredClone(local)
    expect(await appendProposalWithRecovery(store, reserved, local)).toEqual({
      status: 'committed',
      revision: '2'
    })
    local.contract.digest = 'ff'.repeat(32)
    const record = await store.getCommit(proposalCommitKey(reserved))
    expect(record?.local).toEqual(saved)
    expect(record?.localDigest).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.read('0', 10))[0].local).toBeUndefined()
    expect((await store.read('0', 10))[1].local).toEqual(saved)
    expect((await store.head()).bytes).toBeGreaterThan(
      new TextEncoder().encode(canonicalOutputJSON(first) + canonicalOutputJSON(reserved)).length
    )
    expect(await store.commit(reserved, saved)).toEqual({ status: 'replayed', revision: '2' })
    expect(await store.commit(reserved)).toEqual({ status: 'replayed', revision: '2' })
    await expect(store.commit(reserved, local)).rejects.toThrow('different local context')
    await expect(store.commit(first, saved)).rejects.toThrow('different local context')
    const contextual = open()
    await contextual.commit(first, saved)
    const noChange = lifecycle.put(first.next, first.next.proposal, author, '500')
    expect(noChange.changed).toBe(false)
    expect(await contextual.commit(noChange, saved)).toEqual({ status: 'replayed', revision: '1' })
    await expect(contextual.commit(noChange, local)).rejects.toThrow('different local context')
    expect(
      await appendProposalWithRecovery(
        {
          contextRetention: 'proposal-journal-context/1',
          async commit(plan, context) {
            await store.commit(plan, context)
            throw new Error('reply lost')
          },
          getCommit: key => store.getCommit(key)
        },
        reserved,
        saved
      )
    ).toEqual({ status: 'replayed', revision: '2' })
    await expect(
      appendProposalWithRecovery(
        {
          async commit() {
            throw new Error('must not be called')
          },
          getCommit: key => store.getCommit(key)
        },
        reserved,
        saved
      )
    ).rejects.toThrow('cannot retain')
    expect((await store.head()).entries).toBe(2)
  })

  it('recovers a commit-before-response fault using its original plan and never creates another job', async () => {
    const store = open(),
      first = publication()
    let writes = 0
    const result = await appendProposalWithRecovery(
      {
        async commit(plan) {
          writes++
          await store.commit(plan)
          throw new Error('reply lost')
        },
        getCommit: key => store.getCommit(key)
      },
      first
    )
    expect(result).toEqual({ status: 'replayed', revision: '1' })
    expect(writes).toBe(1)
    expect((await store.head()).entries).toBe(1)
    expect(await appendProposalWithRecovery(store, first)).toEqual({
      status: 'replayed',
      revision: '1'
    })
    let lookups = 0
    await expect(
      appendProposalWithRecovery(
        {
          async commit() {
            throw new OutputProtocolError('invalid', 'bad local plan')
          },
          async getCommit() {
            lookups++
            return undefined
          }
        },
        first
      )
    ).rejects.toThrow('bad local plan')
    expect(lookups).toBe(0)
    await expect(
      appendProposalWithRecovery(
        {
          async commit() {
            throw new Error('uncertain write')
          },
          async getCommit() {
            return undefined
          }
        },
        first
      )
    ).rejects.toThrow('uncertain write')
    await expect(
      appendProposalWithRecovery(
        {
          async commit() {
            throw new Error('uncertain write')
          },
          async getCommit() {
            return {
              revision: '1',
              key: proposalCommitKey(first),
              transition: { ...first, events: [] }
            }
          }
        },
        first
      )
    ).rejects.toThrow('uncertain write')
  })

  it('bounds reads, rejects invalid configuration and closes idempotently', async () => {
    for (const limits of [
      { entries: 0 },
      { bytes: -1 },
      { channels: 1025 },
      { entryBytes: Infinity },
      { channels: 1 },
      { bytes: 1 }
    ])
      expect(() => open(limits)).toThrow('limit')
    const store = open()
    for (const maximum of [0, 257, 0.5])
      await expect(store.read('0', maximum)).rejects.toThrow('bound')
    await expect(store.read('01', 1)).rejects.toThrow('U64')
    await store.close()
    await store.close()
    await expect(store.head()).rejects.toThrow('closed')
    await expect(store.commit(publication())).rejects.toThrow('closed')
  })
})

describe('SQLite proposal recovery and identity seal', () => {
  it('reopens a pending job offline and serializes independently opened writer connections', async () => {
    const file = path(),
      first = new SQLiteProposalJournal(file, 'server', author, lifecycle)
    const second = new SQLiteProposalJournal(file, 'server', author, lifecycle)
    const other = new SQLiteProposalJournal(file, 'other', recipient, lifecycle)
    stores.push(first, second, other)
    const initial = publication(),
      reserved = reservation(initial)
    await first.commit(initial)
    await second.commit(reserved)
    expect((await first.commit(lifecycle.expire(initial.next, '100'))).status).toBe('conflict')
    expect((await other.head()).revision).toBe('0')
    await first.close()
    await second.close()
    // The earlier body-only format has no capacity table. Upgrade adds its seal
    // without changing the retained transition bytes or commit identities.
    const legacy = new DatabaseSync(file)
    legacy.exec('DROP TABLE proposal_journal_capacity')
    legacy.close()
    const recovered = new SQLiteProposalJournal(file, 'server', author, lifecycle)
    stores.push(recovered)
    expect((await recovered.head()).reserved).toEqual({ bytes: 4194304, entries: 1 })
    expect(await recovered.getOperation(author, scope.service, 'original-operation-id')).toEqual(
      reserved.next
    )
    await recovered.commit(completed(reserved))
    expect(
      (await recovered.getChannel(proposalChannelKey(initial.next.proposal.body)))?.state.status
    ).toBe('finalized')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => new SQLiteProposalJournal(file, 'server', recipient, lifecycle)).toThrow(
      'configuration changed'
    )
    expect(() => new SQLiteProposalJournal(file, 'new-name', author, lifecycle)).toThrow(
      'configuration changed'
    )
    const changed = new ProposalTransitions(
      new ProposalPolicyRegistry([
        { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 16 } }
      ]),
      scope,
      clock
    )
    expect(() => new SQLiteProposalJournal(file, 'server', author, changed)).toThrow(
      'configuration changed'
    )
    expect(
      () => new SQLiteProposalJournal(file, 'server', author, lifecycle, { entries: 100 })
    ).toThrow('capacity limits changed')
    expect(() => new SQLiteProposalJournal(':memory:', 'server', author, lifecycle)).toThrow(
      'ordinary file'
    )
  })

  it('recovers actual process exit after commit before response or database close', async () => {
    const file = path(),
      initial = publication(),
      reserved = reservation(initial)
    const root = new URL('../dist/proposals/', import.meta.url).href
    const script = `import { AuthorDocumentPolicy, ProposalPolicyRegistry, ProposalTransitions } from ${JSON.stringify(root + 'index.js')}; import { SQLiteProposalJournal } from ${JSON.stringify(root + 'SQLiteProposalJournal.js')}; const data = JSON.parse(process.argv[2]); const policies = new ProposalPolicyRegistry([{policy:new AuthorDocumentPolicy(),parameters:{maxTextBytes:32}}]); const lifecycle = new ProposalTransitions(policies,data.scope,data.clock); const journal = new SQLiteProposalJournal(process.argv[1],'crash',data.identity,lifecycle); await journal.commit(data.initial); await journal.commit(data.reserved); process.exit(73);`
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        file,
        JSON.stringify({ scope, clock, identity: author, initial, reserved })
      ],
      { encoding: 'utf8' }
    )
    expect({ status: child.status, error: child.error?.message }).toEqual({
      status: 73,
      error: undefined
    })
    const recovered = new SQLiteProposalJournal(file, 'crash', author, lifecycle)
    stores.push(recovered)
    expect(await recovered.getOperation(author, scope.service, 'original-operation-id')).toEqual(
      reserved.next
    )
    expect((await recovered.read('0', 256)).map(entry => entry.revision)).toEqual(['1', '2'])
    expect(await recovered.commit(reserved)).toEqual({ status: 'replayed', revision: '2' })
  })

  it('reopens mixed legacy and context-bearing rows and refuses altered local replay material', async () => {
    const file = path(),
      store = new SQLiteProposalJournal(file, 'context', author, lifecycle)
    stores.push(store)
    const first = publication(),
      reserved = reservation(first)
    const local = { profile: 'urn:test:retained-contract:1', version: 1, selectedAt: '99' }
    await store.commit(first)
    await store.commit(reserved, local)
    await store.close()
    const reopened = new SQLiteProposalJournal(file, 'context', author, lifecycle)
    stores.push(reopened)
    const entries = await reopened.read('0', 256)
    expect(entries.map(entry => entry.local)).toEqual([undefined, local])
    expect(await reopened.getOperation(author, scope.service, 'original-operation-id')).toEqual(
      reserved.next
    )
    await reopened.close()
    const database = new DatabaseSync(file)
    const row = database
      .prepare('SELECT transition FROM proposal_journal_entries WHERE namespace=? AND revision=?')
      .get('context', '0000000000000002')!
    const frame = JSON.parse(row.transition as string)
    frame.local.selectedAt = '98'
    database
      .prepare('UPDATE proposal_journal_entries SET transition=? WHERE namespace=? AND revision=?')
      .run(canonicalOutputJSON(frame), 'context', '0000000000000002')
    database.close()
    expect(() => new SQLiteProposalJournal(file, 'context', author, lifecycle)).toThrow(
      'integrity mismatch'
    )
  })

  it('rejects incomplete or changed committed prefixes without silently resetting the service', async () => {
    const file = path(),
      store = new SQLiteProposalJournal(file, 'corrupt', author, lifecycle)
    stores.push(store)
    await store.commit(publication())
    await store.close()
    const database = new DatabaseSync(file)
    database
      .prepare('UPDATE proposal_journal_meta SET revision=? WHERE namespace=?')
      .run('0000000000000002', 'corrupt')
    database.close()
    expect(() => new SQLiteProposalJournal(file, 'corrupt', author, lifecycle)).toThrow(
      'Incomplete'
    )
  })

  it.each([
    ["UPDATE proposal_journal_meta SET revision='bad'", 'revision'],
    ['UPDATE proposal_journal_meta SET retained_bytes=-1', 'metadata'],
    ['UPDATE proposal_journal_meta SET entries=-1', 'metadata'],
    ['UPDATE proposal_journal_meta SET entries=4097', 'metadata'],
    ['UPDATE proposal_journal_meta SET retained_bytes=67108865', 'metadata'],
    ['UPDATE proposal_journal_entries SET entry_bytes=1', 'length'],
    ["UPDATE proposal_journal_entries SET commit_key='wrong'", 'integrity'],
    ['DELETE FROM proposal_journal_capacity', 'capacity limits changed']
  ])(
    'refuses changed durable state while an existing connection is open: %s',
    async (sql, error) => {
      const file = path(),
        store = new SQLiteProposalJournal(file, 'guarded', author, lifecycle)
      stores.push(store)
      await store.commit(publication())
      const database = new DatabaseSync(file)
      database.exec(sql)
      database.close()
      // New entry corruption is checked on cold replay; metadata is checked on
      // every read. The immutable committed prefix is not rehashed on warm reads.
      if (sql.includes('proposal_journal_entries')) {
        await store.close()
        expect(() => new SQLiteProposalJournal(file, 'guarded', author, lifecycle)).toThrow(error)
      } else {
        await expect(store.head()).rejects.toThrow(error)
        await expect(
          store.commit(publication(signed({ channel: 'aa'.repeat(32) })))
        ).rejects.toThrow(error)
      }
    }
  )

  it('rejects backwards revisions and noncanonical stored encodings without resetting the namespace', async () => {
    const file = path(),
      store = new SQLiteProposalJournal(file, 'encoding', author, lifecycle)
    stores.push(store)
    const first = publication()
    await store.commit(first)
    const database = new DatabaseSync(file)
    database.exec("UPDATE proposal_journal_meta SET revision='0000000000000000'")
    await expect(store.head()).rejects.toThrow('backwards')
    database.exec("UPDATE proposal_journal_meta SET revision='0000000000000001'")
    await store.close()
    const text = ' ' + canonicalOutputJSON(first)
    const size = new TextEncoder().encode(text).length
    database
      .prepare('UPDATE proposal_journal_entries SET transition=?, entry_bytes=?')
      .run(text, size)
    database.prepare('UPDATE proposal_journal_meta SET retained_bytes=?').run(size)
    database.close()
    expect(() => new SQLiteProposalJournal(file, 'encoding', author, lifecycle)).toThrow(
      'Noncanonical'
    )
  })
})

it('replays legacy pending jobs without retroactively requiring completion capacity', () => {
  const first = publication(),
    reserved = reservation(first)
  const state = new ProposalJournalState(lifecycle, author, { entries: 2 })
  for (const [index, transition] of [first, reserved].entries())
    state.replay({ revision: String(index + 1), key: proposalCommitKey(transition), transition })
  expect(state.head()).toMatchObject({ entries: 2, reserved: { entries: 1 } })
  expect(state.operation(author, scope.service, 'original-operation-id')).toEqual(reserved.next)
  expect(state.plan(state.prepare(completed(reserved))).status).toBe('limited')
  expect(state.plan(state.prepare(reserved)).status).toBe('replayed')
})

it('does not partially apply an invalid local revision or replace a retained commit', () => {
  const state = new ProposalJournalState(lifecycle, author)
  const prepared = state.prepare(publication())
  expect(() => state.apply(prepared, '2')).toThrow('Invalid proposal journal history')
  expect(state.head().revision).toBe('0')
  state.apply(prepared, '1')
  expect(() => state.apply(prepared, '2')).toThrow('Invalid proposal journal history')
  expect(state.head().revision).toBe('1')
})
