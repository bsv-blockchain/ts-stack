import { afterEach, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  signOutputPacket,
  OUTPUT_LOOKUP_PROFILE,
  type OutputCapabilities,
  type OutputSignedPacket,
  type OutputLookupOpen
} from '@bsv/sdk'
import { SQLiteProposalChannelStore } from '../src/proposals/SQLiteProposalChannelStore.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import {
  ProposalPolicyRegistry,
  proposalChannelKey
} from '../src/proposals/ProposalPolicyRegistry.js'
import { AuthorDocumentPolicy } from '../src/proposals/AuthorDocumentPolicy.js'
import type { ProposalPolicy } from '../src/proposals/ProposalPolicy.js'
import { ProposalChannelHeadsQuery } from '../src/proposals/ProposalChannelHeadsQuery.js'
import { SQLiteTransactionDomain } from '../src/storage/SQLiteTransactionDomain.js'
import { ProposalFeedPrivacy } from '../src/proposals/ProposalFeedPrivacy.js'
import type { SQLiteLookupDisclosure } from '../src/lookup/SQLiteLookupDisclosure.js'
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import {
  SQLiteLookupIndexStore,
  sqliteLookupComposition
} from '../src/lookup/SQLiteLookupIndexStore.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import { LookupProviderContracts } from '../src/lookup/LookupProviderContracts.js'
import { LookupProviderService } from '../src/lookup/LookupProviderService.js'
import { lookupServingEpochExtension } from '../src/lookup/LookupServingEpoch.js'
import {
  author,
  authorKey,
  recipient,
  outsider,
  signed,
  scope,
  createRegistry,
  bytes
} from './proposal-client-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  jest.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function movablePolicy(): ProposalPolicy {
  const base = new AuthorDocumentPolicy()
  return {
    id: 'https://example.test/movable-private-document/1',
    parameters: base.parameters.bind(base),
    validate: base.validate.bind(base),
    permits: base.permits.bind(base),
    readVisibility: base.readVisibility.bind(base),
    successor: () => {},
    finalization: base.finalization.bind(base)
  }
}
async function setup(movable = false, advertisedBytes = 4194304) {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-channel-store-')),
    path = join(folder, 'state.db')
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const policies = movable
    ? new ProposalPolicyRegistry([{ policy: movablePolicy(), parameters: { maxTextBytes: 32 } }])
    : createRegistry()
  const { id, digest } = policies.describe()[0],
    policy = { id, digest },
    parameters = { policy }
  const lifecycle = new ProposalTransitions(policies, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  let now = '10',
    manifest: OutputSignedPacket<OutputCapabilities>
  const queries = new LookupQueryRegistry([
    { policy: new ProposalChannelHeadsQuery(policies), parameters }
  ])
  const contracts = new LookupProviderContracts(
    {
      baseURL: 'https://provider.example.test/api',
      identity: author,
      chain: scope.chain,
      service: scope.service,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '2'
    },
    queries,
    () => manifest
  )
  const options = {
    path,
    namespace: 'private',
    identity: author,
    lifecycle,
    policies,
    sessionCodec: new LookupSessionCodec(contracts.recoveryTrust()),
    now: () => now
  }
  const store = SQLiteProposalChannelStore.create(options)
  cleanup.push(() => store.close())
  const epoch = await store.sessions.createEpoch()
  await store.sessions.initializeGuard('serving')
  manifest = signOutputPacket(
    'capabilities',
    {
      version: 1,
      identity: author,
      baseURL: 'https://provider.example.test/api',
      chain: scope.chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: scope.service,
          kind: 'lookup',
          ...queries.describe()[0],
          profiles: [
            {
              id: OUTPUT_LOOKUP_PROFILE,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: advertisedBytes,
              parameters: {
                sessionSeconds: '300',
                replaySeconds: '600',
                maxObservations: 1024,
                maxWaitMs: 25000
              }
            }
          ]
        }
      ],
      extensions: lookupServingEpochExtension([{ service: scope.service, epoch }])
    },
    authorKey
  )
  const makeProvider = (source: SQLiteProposalChannelStore, maximumExpirations = 128) =>
    new LookupProviderService({
      budgets: { maximumExpirations },
      index: source.feed,
      sessions: source.sessions,
      contracts,
      now: () => now,
      authorize: async input => {
        const auth = await source.authorizeLookup(policy, {
          principal: input.principal,
          access: input.principal!,
          guards: [
            {
              id: 'serving',
              revision: await source.sessions.guard('serving'),
              failure: 'unauthorized'
            }
          ]
        })
        return { access: auth.access, guards: auth.guards }
      }
    })
  const first = lifecycle.put(undefined, signed({ policy }), author, '10'),
    provider = makeProvider(store)
  const caller = (principal = recipient) => ({
    principal,
    capabilityDigest: outputPacketDigest('capabilities', manifest.body)
  })
  const request = (digit = 'aa'): OutputLookupOpen => ({
    version: 1,
    requestId: digit.repeat(32),
    service: scope.service,
    query: {},
    limits: { maxBytes: 1048576, maxObservations: 10, waitMs: 0 }
  })
  const open = async (principal = recipient, digit = 'aa') =>
    JSON.parse((await provider.open(request(digit), caller(principal))).body)
  const reopen = () => {
    const next = SQLiteProposalChannelStore.open(options)
    cleanup.push(() => next.close())
    return next
  }
  return {
    path,
    options,
    store,
    policy,
    lifecycle,
    first,
    provider,
    makeProvider,
    caller,
    request,
    open,
    reopen,
    now: (value: string) => {
      now = value
    }
  }
}

it('publishes through its backwards-compatible journal facet and exposes no generic index writer', async () => {
  const f = await setup()
  expect(await f.store.journal.commit(f.first)).toEqual({ status: 'committed', revision: '1' })
  for (const key of ['commit', 'compact', 'close', 'retainSnapshot', 'database'])
    expect(f.store.feed).not.toHaveProperty(key)
  const first = await f.open()
  expect(first.phase).toBe('snapshot')
  expect(first.groups).toHaveLength(1)
  expect(first.groups[0].observations.map((item: { kind: string }) => item.kind)).toEqual([
    'proposal',
    'proposal-state'
  ])
  const entry = await f.store.journal.getChannelEntry!(
    proposalChannelKey(f.first.next.proposal.body)
  )
  expect(entry?.transition.next).toEqual(f.first.next)
  await f.store.close()
  const reopened = f.reopen()
  expect((await reopened.journal.head()).revision).toBe('1')
  expect(await reopened.sessions.session(first.session, recipient)).toMatchObject({
    session: first.session,
    watermark: '1'
  })
  const auth = await reopened.authorizeLookup(f.policy, {
    principal: recipient,
    access: recipient,
    guards: [{ id: 'serving', revision: '0', failure: 'unauthorized' }]
  })
  expect(await reopened.sessions.serialize(first.session, auth, first)).toBe(
    canonicalOutputJSON(first)
  )
})

it('keeps live sessions current across ordinary edits without invalidating visibility', async () => {
  const f = await setup()
  await f.store.journal.commit(f.first)
  const first = await f.open()
  f.now('11')
  const next = f.lifecycle.put(
    f.first.next,
    signed({
      policy: f.policy,
      revision: '1',
      previous: f.first.next.proposalId,
      issuedAt: '11',
      payload: bytes(canonicalOutputJSON({ text: 'new content' }))
    }),
    author,
    '11'
  )
  await f.store.journal.commit(next)
  const batch = JSON.parse(
    (
      await f.provider.read(
        { version: 1, session: first.session, cursor: first.cursor, limits: first.limits },
        f.caller()
      )
    ).body
  )
  expect(batch.phase).toBe('live')
  expect(batch.groups).toHaveLength(1)
  expect(batch.groups[0].observations.map((item: { kind: string }) => item.kind)).toEqual([
    'proposal-remove',
    'proposal',
    'proposal-state'
  ])
  expect(await f.store.sessions.guard('proposal-read-visibility/1/' + f.policy.digest)).toBe('0')
})

it('atomically invalidates both formerly visible and formerly invisible retained sessions when readership changes', async () => {
  const f = await setup(true)
  await f.store.journal.commit(f.first)
  const visible = await f.open(),
    invisible = await f.open(outsider, 'bb')
  expect(invisible.groups).toHaveLength(0)
  f.now('11')
  const next = f.lifecycle.put(
    f.first.next,
    signed({
      policy: f.policy,
      revision: '1',
      previous: f.first.next.proposalId,
      issuedAt: '11',
      recipients: [author, outsider].sort()
    }),
    author,
    '11'
  )
  await f.store.journal.commit(next)
  expect(await f.store.sessions.guard('proposal-read-visibility/1/' + f.policy.digest)).toBe('1')
  for (const [batch, principal] of [
    [visible, recipient],
    [invisible, outsider]
  ] as const) {
    await expect(
      f.provider.read(
        { version: 1, session: batch.session, cursor: batch.cursor, limits: batch.limits },
        f.caller(principal)
      )
    ).rejects.toMatchObject({ code: 'reset-required' })
    const old = await f.store.sessions.session(batch.session, principal).catch(error => error)
    // Reading private retained state is not send authority: the actual signed enqueue must reject.
    const auth = {
      principal,
      access: principal,
      guards: [
        { id: 'serving', revision: '0', failure: 'unauthorized' as const },
        {
          id: 'proposal-read-visibility/1/' + f.policy.digest,
          revision: '0',
          failure: 'reset-required' as const
        }
      ]
    }
    await expect(f.store.sessions.serialize(batch.session, auth, batch)).rejects.toMatchObject({
      code: 'reset-required'
    })
    let sent = false
    await expect(
      f.store.sessions.enqueueResponse(
        {
          reference: { kind: 'session', session: batch.session, principal },
          bytes: new TextEncoder().encode(canonicalOutputJSON(batch))
        },
        () => true,
        () => {
          sent = true
        }
      )
    ).rejects.toThrow()
    expect(sent).toBe(false)
    expect(old).toBeDefined()
  }
  const fresh = await f.open(outsider, 'cc')
  expect(fresh.groups).toHaveLength(1)
})

it('rolls back the visibility fence together with rejected content and journal changes', async () => {
  const f = await setup(true)
  await f.store.journal.commit(f.first)
  const first = await f.open()
  const db = new DatabaseSync(f.path)
  cleanup.push(() => db.close())
  db.exec(
    "CREATE TRIGGER reject_feed BEFORE INSERT ON output_lookup_groups BEGIN SELECT RAISE(ABORT,'injected write failure'); END;"
  )
  f.now('11')
  const next = f.lifecycle.put(
    f.first.next,
    signed({
      policy: f.policy,
      revision: '1',
      previous: f.first.next.proposalId,
      issuedAt: '11',
      recipients: [author, outsider].sort()
    }),
    author,
    '11'
  )
  await expect(f.store.journal.commit(next)).rejects.toThrow(/injected/)
  expect(await f.store.sessions.guard('proposal-read-visibility/1/' + f.policy.digest)).toBe('0')
  expect((await f.store.journal.head()).revision).toBe('1')
  expect((await f.store.feed.head()).sequence).toBe('1')
  expect(
    JSON.parse(
      (
        await f.provider.read(
          { version: 1, session: first.session, cursor: first.cursor, limits: first.limits },
          f.caller()
        )
      ).body
    ).groups
  ).toHaveLength(0)
})

it('shares one monotonic clock across failed session work, proposal commits, restart and native journal sends', async () => {
  const f = await setup()
  f.now('20')
  await expect(f.store.sessions.guard('missing')).rejects.toThrow()
  f.now('19')
  await expect(f.store.journal.commit(f.first)).rejects.toMatchObject({ code: 'context-changed' })
  await f.store.close()
  const next = f.reopen()
  f.now('20')
  await next.journal.commit(f.first)
  f.now('25')
  let sent = false
  await next.journal.enqueueResponse(
    {
      reference: { kind: 'channel', channelKey: proposalChannelKey(f.first.next.proposal.body) },
      bytes: new Uint8Array([1])
    },
    () => true,
    () => {
      sent = true
    }
  )
  expect(sent).toBe(true)
  f.now('24')
  await expect(next.sessions.guard('serving')).rejects.toMatchObject({ code: 'context-changed' })
})

it('does not allow an ordinary lookup or journal writer to open the compound sealed namespace', async () => {
  const f = await setup()
  expect(() =>
    SQLiteProposalJournal.open(f.path, 'private', author, f.lifecycle, { entryBytes: 262144 })
  ).toThrow()
  expect(() => SQLiteLookupIndex.open(f.path, 'private', { ...scope, provider: author })).toThrow()
  expect(() =>
    SQLiteProposalChannelStore.open({ ...f.options, journal: { entryBytes: 131072 } })
  ).toThrow()
  const absent = join(f.path + '-missing', 'state.db')
  expect(() => SQLiteProposalChannelStore.open({ ...f.options, path: absent })).toThrow()
  expect(existsSync(absent)).toBe(false)
})

it('requires the mandatory visibility guard on direct session commits', async () => {
  const f = await setup()
  await f.store.journal.commit(f.first)
  const batch = await f.open()
  const opening = await f.store.sessions.session(batch.session, recipient)
  opening.guards = opening.guards.filter(guard => guard.id === 'serving')
  await expect(f.store.sessions.commit(opening)).rejects.toThrow(/visibility guard/)
})

it('does not retain a new snapshot promise while bounded proposal expiry work remains', async () => {
  const f = await setup()
  const plans = ['01', '02', '03'].map(channel =>
    f.lifecycle.put(
      undefined,
      signed({ policy: f.policy, channel: channel.repeat(32), expiresAt: '20' }),
      author,
      '10'
    )
  )
  await f.store.commit(plans.map(transition => ({ transition })))
  f.now('20')
  expect(await f.store.feed.advanceTime('20', 1)).toMatchObject({
    expired: 1,
    complete: false,
    head: { processedThrough: '0' }
  })
  const bounded = f.makeProvider(f.store, 1)
  await expect(bounded.open(f.request(), f.caller())).rejects.toMatchObject({ code: 'limited' })
  const complete = JSON.parse((await bounded.open(f.request(), f.caller())).body)
  expect(complete.groups).toHaveLength(3)
  expect(
    complete.groups.map(
      (group: { observations: { payload: { state?: { status: string } } }[] }) =>
        group.observations[1].payload.state?.status
    )
  ).toEqual(['expired', 'expired', 'expired'])
  expect((await f.store.feed.head()).processedThrough).toBe('20')
})

it('rolls back every component when guard capacity prevents coherent installation', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'proposal-channel-bootstrap-')),
    path = join(folder, 'state.db')
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const policies = new ProposalPolicyRegistry([
    { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 32 } },
    { policy: movablePolicy(), parameters: { maxTextBytes: 32 } }
  ])
  const lifecycle = new ProposalTransitions(policies, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const options = {
    path,
    namespace: 'private',
    identity: author,
    lifecycle,
    policies,
    sessionCodec: new LookupSessionCodec(liveFixture().selection),
    now: () => '10',
    sessions: { guards: 1 }
  }
  expect(() => SQLiteProposalChannelStore.create(options)).toThrow(/guard capacity/)
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
  } finally {
    db.close()
  }
  const coherent = SQLiteProposalChannelStore.create({ ...options, sessions: { guards: 2 } })
  cleanup.push(() => coherent.close())
  expect((await coherent.journal.head()).entries).toBe(0)
})

it('preserves clock observations outside rejected session savepoints for all compound writers', async () => {
  const f = await setup()
  await f.store.journal.commit(f.first)
  const first = await f.open(),
    opening = await f.store.sessions.session(first.session, recipient)
  f.now('30')
  opening.guards = []
  await expect(f.store.sessions.commit(opening)).rejects.toThrow()
  // Invalid preflight need not sample time; force a failure inside the native session gate.
  await expect(f.store.sessions.advanceGuard('serving', '99')).rejects.toThrow()
  f.now('29')
  await expect(f.store.commit([{ transition: f.first }])).rejects.toMatchObject({
    code: 'context-changed'
  })
  f.now('30')
  expect((await f.store.commit([{ transition: f.first }])).entries[0].status).toBe('replayed')
})

it('keeps legacy read policy behavior while allowing an explicit stable visibility descriptor', () => {
  const original = signed(),
    changed = signed({ payload: bytes(canonicalOutputJSON({ text: 'changed' })) })
  const registry = createRegistry()
  expect(registry.readVisibility(original)).toBe(registry.readVisibility(changed))
  const descriptor = new AuthorDocumentPolicy().readVisibility(original.body)
  ;(descriptor.recipients as string[]).pop()
  expect(original.body.recipients).toHaveLength(2)
  const base = movablePolicy(),
    { readVisibility: _descriptor, ...legacy } = base
  const fallback = new ProposalPolicyRegistry([
    { policy: legacy, parameters: { maxTextBytes: 32 } }
  ])
  const { id, digest } = fallback.describe()[0],
    policy = { id, digest }
  expect(fallback.readVisibility(signed({ policy }))).not.toBe(
    fallback.readVisibility(signed({ policy, payload: changed.body.payload }))
  )
})

it('rejects an unstreamable whole group before any journal, row or visibility effect', async () => {
  const f = await setup()
  const plans = Array.from({ length: 22 }, (_, index) =>
    f.lifecycle.put(
      undefined,
      signed({ policy: f.policy, channel: index.toString(16).padStart(64, '0') }),
      author,
      '10'
    )
  )
  await expect(f.store.commit(plans.map(transition => ({ transition })))).rejects.toThrow(
    /wire reservation/
  )
  expect((await f.store.journal.head()).entries).toBe(0)
  expect((await f.store.feed.head()).sequence).toBe('0')
  expect(await f.store.sessions.guard('proposal-read-visibility/1/' + f.policy.digest)).toBe('0')
  const accepted = await f.store.commit(plans.slice(0, 20).map(transition => ({ transition })))
  expect(accepted.group?.changes).toHaveLength(20)
})

it('does not retain promises under a smaller advertised maximum than the sealed producer contract', async () => {
  const f = await setup(false, 1048576)
  await f.store.journal.commit(f.first)
  await expect(f.open()).rejects.toMatchObject({ code: 'unsupported' })
  const db = new DatabaseSync(f.path)
  try {
    expect(db.prepare('SELECT count(*) AS n FROM output_lookup_sessions').get()?.n).toBe(0)
  } finally {
    db.close()
  }
})

it.each(['reject', 'validate-throw', 'enqueue-throw'] as const)(
  'retains sampled time after failed native proposal delivery (%s)',
  async mode => {
    const f = await setup()
    await f.store.journal.commit(f.first)
    f.now('25')
    let sent = false
    await expect(
      f.store.journal.enqueueResponse(
        {
          reference: {
            kind: 'channel',
            channelKey: proposalChannelKey(f.first.next.proposal.body)
          },
          bytes: new Uint8Array([1])
        },
        () => {
          if (mode === 'validate-throw') throw new Error('Private policy unavailable')
          return mode !== 'reject'
        },
        () => {
          sent = true
          throw new Error('Physical enqueue failed')
        }
      )
    ).rejects.toThrow()
    expect(sent).toBe(mode === 'enqueue-throw')
    await f.store.close()
    const next = f.reopen()
    f.now('24')
    await expect(next.sessions.guard('serving')).rejects.toMatchObject({ code: 'context-changed' })
    f.now('25')
    expect((await next.feed.head()).recordedAt).toBe('25')
  }
)

it('requires file-backed storage, a synchronous clock and matching installed policies', async () => {
  const f = await setup()
  for (const path of [':memory:', 'file:private.db', 3])
    expect(() => SQLiteProposalChannelStore.create({ ...f.options, path: path as string })).toThrow(
      /file and synchronous clock/
    )
  for (const now of [undefined, async () => '10'])
    expect(() =>
      SQLiteProposalChannelStore.create({ ...f.options, now: now as unknown as () => string })
    ).toThrow(/file and synchronous clock/)
  const policies = new ProposalPolicyRegistry([
    { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 64 } }
  ])
  expect(() => SQLiteProposalChannelStore.create({ ...f.options, policies })).toThrow(
    /policies differ/
  )
  expect(() =>
    SQLiteProposalChannelStore.create({ ...f.options, path: f.path + '/unavailable.db' })
  ).toThrow()
  expect(f.store.feed.configuration.binding).toMatchObject({ ...scope, provider: author })
})

it('rejects blocked or duplicated visibility fences and preserves compatible journal conflict results', async () => {
  const f = await setup()
  const auth = await f.store.authorizeLookup(f.policy, {
    principal: recipient,
    access: recipient,
    guards: []
  })
  await expect(f.store.authorizeLookup(f.policy, auth)).rejects.toThrow(/duplicates/)
  const guard = auth.guards[0]
  await f.store.sessions.blockGuard(guard.id, guard.revision, 'ab'.repeat(32))
  await expect(
    f.store.authorizeLookup(f.policy, { principal: recipient, access: recipient, guards: [] })
  ).rejects.toMatchObject({ code: 'unauthorized' })
  const wrong = structuredClone(f.first)
  wrong.expectedToken = 'ff'.repeat(32)
  expect(await f.store.journal.commit(wrong)).toMatchObject({ status: 'conflict' })
  expect((await f.store.journal.head()).entries).toBe(0)
})

it('refuses startup when the journal reader cannot provide promised history', async () => {
  const f = await setup()
  await f.store.journal.commit(f.first)
  await f.store.close()
  jest.spyOn(ProposalJournalState.prototype, 'read').mockReturnValue([])
  expect(() => f.reopen()).toThrow(/history is incomplete/)
})

it.each(['count', 'absent', 'different'] as const)(
  'refuses inconsistent index participant state during startup (%s)',
  async fault => {
    const f = await setup()
    await f.store.journal.commit(f.first)
    await f.store.close()
    const original = Object.getOwnPropertyDescriptor(
      SQLiteLookupIndexStore.prototype,
      sqliteLookupComposition
    )!.get!
    jest
      .spyOn(SQLiteLookupIndexStore.prototype, sqliteLookupComposition, 'get')
      .mockImplementation(function (this: SQLiteLookupIndexStore) {
        const bridge = original.call(this) as SQLiteLookupIndexStore[typeof sqliteLookupComposition]
        return {
          ...bridge,
          head: () => {
            const head = bridge.head()
            return fault === 'count'
              ? { ...head, retained: { ...head.retained, keys: head.retained.keys + 1 } }
              : head
          },
          row: key => {
            const row = bridge.row(key)
            if (fault === 'absent') return null
            return row && fault === 'different'
              ? { ...row, value: { ...row.value, data: { unavailable: true } } }
              : row
          }
        }
      })
    expect(() => f.reopen()).toThrow(fault === 'count' ? /unrelated keys/ : /row differs/)
  }
)

it('validates the private feed profile independently of generic session validation', async () => {
  const f = await setup()
  await f.store.journal.commit(f.first)
  const batch = await f.open()
  const opening = await f.store.sessions.session(batch.session, recipient)
  const domain = new SQLiteTransactionDomain(new DatabaseSync(':memory:'))
  cleanup.push(() => domain.close())
  // These validation-only calls never use the separate durable disclosure port.
  const privacy = new ProposalFeedPrivacy(
    domain,
    f.options.policies,
    {} as SQLiteLookupDisclosure,
    { ...scope, provider: author },
    { maxBytes: 4194304, maxObservations: 1024 }
  )
  expect(() => privacy.opening(opening)).toThrow(/write transaction/)
  expect(() => domain.transaction(() => privacy.opening(opening))).not.toThrow()
  for (const change of [
    (value: typeof opening) => {
      value.principal = null
    },
    (value: typeof opening) => {
      value.first.scope.provider = outsider
    },
    (value: typeof opening) => {
      value.first.scope.service = 'other'
    },
    (value: typeof opening) => {
      value.first.scope.chain = { ...scope.chain, genesisHash: 'ff'.repeat(32) }
    },
    (value: typeof opening) => {
      value.first.scope.rulesDigest = 'ff'.repeat(32)
    }
  ]) {
    const value = structuredClone(opening)
    change(value)
    expect(() => domain.transaction(() => privacy.opening(value))).toThrow(
      /exact authenticated query/
    )
  }
  for (const change of [
    (value: typeof opening) => {
      value.contract.manifest.body.services = []
    },
    (value: typeof opening) => {
      value.contract.manifest.body.services[0].profiles = []
    },
    (value: typeof opening) => {
      value.contract.manifest.body.services[0].profiles[0].maxResponseBytes = 1048576
    },
    (value: typeof opening) => {
      value.contract.manifest.body.services[0].profiles[0].parameters.maxObservations = 1
    }
  ]) {
    const value = structuredClone(opening)
    change(value)
    expect(() => domain.transaction(() => privacy.opening(value))).toThrow(/complete groups/)
  }
  const wrongGuard = structuredClone(opening)
  wrongGuard.guards.find(guard => guard.failure === 'reset-required')!.failure = 'unauthorized'
  expect(() => domain.transaction(() => privacy.opening(wrongGuard))).toThrow(/visibility guard/)
  const unknown = structuredClone(f.first.next)
  unknown.proposal.body.policy.digest = 'ff'.repeat(32)
  expect(() => domain.transaction(() => privacy.publish(undefined, unknown))).toThrow(
    /not installed/
  )
})

it('retains local proposal recovery context without projecting it into the private lookup feed', async () => {
  const f = await setup()
  const local = { retainedContract: 'synthetic-private-recovery-context' }
  expect(await f.store.journal.commit(f.first, local)).toMatchObject({ status: 'committed' })
  local.retainedContract = 'changed-by-caller'
  const first = await f.open()
  expect(canonicalOutputJSON(first)).not.toContain('synthetic-private-recovery-context')
  await f.store.close()
  const reopened = f.reopen()
  expect((await reopened.journal.getProposalEntry!(f.first.next.proposalId))?.local).toEqual({
    retainedContract: 'synthetic-private-recovery-context'
  })
  expect((await reopened.feed.group('1')).changes[0].after?.value.data).not.toHaveProperty('local')
})
