import { describe, expect, it } from '@jest/globals'
import { outputPacketDigest, type OutputJSONObject, type OutputLookupOpen } from '@bsv/sdk'
import {
  ProposalChannelHeadsQuery,
  proposalChannelIndexKey
} from '../src/proposals/ProposalChannelHeadsQuery.js'
import { AuthorDocumentPolicy } from '../src/proposals/AuthorDocumentPolicy.js'
import { ProposalPolicyRegistry } from '../src/proposals/ProposalPolicyRegistry.js'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import type { LookupIndexRow, LookupIndexGroup } from '../src/lookup/LookupIndexCodec.js'
import {
  author,
  recipient,
  outsider,
  createRegistry,
  reference,
  signed,
  chain,
  scope
} from './proposal-client-fixture.js'

function fixture(reader: string | null = recipient, query: OutputJSONObject = {}) {
  const policy = new ProposalChannelHeadsQuery(createRegistry())
  const parameters = { policy: reference }
  const registry = new LookupQueryRegistry([{ policy, parameters }])
  const open: OutputLookupOpen = {
    version: 1,
    service: scope.service,
    requestId: '01'.repeat(32),
    query,
    limits: { maxBytes: 65536, maxObservations: 16, waitMs: 0 }
  }
  const selected = {
    chain,
    provider: author,
    service: scope.service,
    rulesDigest: registry.describe()[0].rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: scope.service, query }),
    epoch: 'one',
    access: 'private'
  }
  const context = { scope: selected, parameters, principal: reader, query }
  const row = (
    proposal = signed(),
    state: OutputJSONObject = { status: 'active', recordedAt: '10' },
    revision = '1'
  ): LookupIndexRow => ({
    key: proposalChannelIndexKey(proposal),
    revision,
    value: { data: { version: 1, proposal, state }, expiresAt: null }
  })
  const group = (
    before: LookupIndexRow | null,
    after: LookupIndexRow | null
  ): LookupIndexGroup => ({
    sequence: '2',
    recordedAt: '11',
    changes: [{ key: (after ?? before)!.key, before, after }],
    event: { type: 'proposal-transition' }
  })
  return { policy, registry, context, row, group, view: registry.prepare(open, selected, reader) }
}

describe('registered proposal current-channel query mapping', () => {
  it('captures one signed head and its attributable state as a single actual wire group', () => {
    const { row, view } = fixture()
    const group = view.snapshot(row(), '01'.repeat(32), '1', '10')!
    expect(group.observations.map(item => item.kind)).toEqual(['proposal', 'proposal-state'])
    expect(group.observations[1].payload).toMatchObject({
      service: scope.service,
      policy: reference,
      channel: signed().body.channel,
      proposalId: outputPacketDigest('proposal', signed().body),
      state: { status: 'active', recordedAt: '10' }
    })
  })

  it('keeps replacement removal, signed successor and new state in one indivisible group', () => {
    const { row, group, view } = fixture()
    const before = row()
    const next = signed({ revision: '1', previous: outputPacketDigest('proposal', signed().body) })
    const live = view.live(group(before, row(next, { status: 'active', recordedAt: '11' }, '2')))!
    expect(live.observations.map(item => item.kind)).toEqual([
      'proposal-remove',
      'proposal',
      'proposal-state'
    ])
    expect(live.observations[0].payload).toMatchObject({
      proposalId: outputPacketDigest('proposal', signed().body)
    })
    expect(live.observations[2].payload).toMatchObject({
      proposalId: outputPacketDigest('proposal', next.body)
    })
  })

  it('reports a terminal lifecycle without pretending it removed source membership or spent an output', () => {
    const { row, group, view } = fixture()
    const value = group(row(), row(signed(), { status: 'expired', recordedAt: '100' }, '2'))
    value.recordedAt = '100'
    expect(view.live(value)!.observations.map(item => item.kind)).toEqual([
      'proposal',
      'proposal-state'
    ])
    expect(view.live(group(row(), null))!.observations.map(item => item.kind)).toEqual([
      'proposal-remove'
    ])
  })

  it('ignores no-op state writes and includes a new visible channel without fabricating old membership', () => {
    const { row, group, view } = fixture()
    const before = row()
    const unchanged = structuredClone(before)
    unchanged.revision = '2'
    expect(view.live(group(before, unchanged))).toBeNull()
    expect(view.live(group(null, row(signed(), undefined, '2')))!.observations).toHaveLength(2)
  })

  it('orders every affected channel canonically without splitting or mutating its domain group', () => {
    const { row, view } = fixture()
    const later = row(signed({ channel: '22'.repeat(32) }), undefined, '2')
    const earlier = row(signed({ channel: '11'.repeat(32) }), undefined, '2')
    const group: LookupIndexGroup = {
      sequence: '2',
      recordedAt: '11',
      event: { type: 'two-channels' },
      changes: [later, earlier].map(after => ({ key: after.key, before: null, after }))
    }
    const original = structuredClone(group)
    const result = view.live(group)!
    expect(result.observations.map(item => item.kind)).toEqual([
      'proposal',
      'proposal-state',
      'proposal',
      'proposal-state'
    ])
    const channels = result.observations.flatMap(item =>
      item.kind === 'proposal' ? [item.payload.proposal.body.channel] : []
    )
    expect(channels).toEqual(['11'.repeat(32), '22'.repeat(32)])
    expect(result.sequence).toBe('2')
    expect(group).toEqual(original)
  })

  it('preserves optional signed extensions and rejects unsupported critical semantics', () => {
    const { row, view } = fixture()
    const extension = 'urn:example:proposal-display'
    const proposal = signed({ extensions: { [extension]: { label: 'kept' } } })
    const group = view.snapshot(row(proposal), '01'.repeat(32), '1', '10')!
    expect(group.observations[0].payload).toEqual({ proposal })
    const critical = signed({
      extensions: { [extension]: { label: 'required' } },
      critical: [extension]
    })
    expect(() => view.snapshot(row(critical), '01'.repeat(32), '1', '10')).toThrow(
      expect.objectContaining({ code: 'unsupported' })
    )
  })

  it('keeps invalid signatures and a foreign service or chain distinct from invisible rows', () => {
    const { row, view } = fixture()
    const altered = signed()
    altered.signature = 'AQ=='
    expect(() => view.snapshot(row(altered), '01'.repeat(32), '1', '10')).toThrow()
    expect(() =>
      view.snapshot(row(signed({ service: 'other' })), '01'.repeat(32), '1', '10')
    ).toThrow('service or chain')
    expect(() =>
      view.snapshot(
        row(signed({ chain: { ...chain, genesisHash: 'ff'.repeat(32) } })),
        '01'.repeat(32),
        '1',
        '10'
      )
    ).toThrow('service or chain')
  })

  it('filters the explicit channel set and installed read permission while requiring authentication', () => {
    const chosen = fixture(recipient, { channels: ['ff'.repeat(32)] })
    expect(chosen.view.snapshot(chosen.row(), '01'.repeat(32), '1', '10')).toBeNull()
    const unauthorized = fixture(outsider)
    expect(unauthorized.view.snapshot(unauthorized.row(), '01'.repeat(32), '1', '10')).toBeNull()
    const anonymous = fixture(null)
    expect(() => anonymous.view.snapshot(anonymous.row(), '01'.repeat(32), '1', '10')).toThrow(
      expect.objectContaining({ code: 'unauthorized' })
    )
  })

  it('resets an existing channel whose visibility changes instead of replaying private history under changed permissions', () => {
    const { row, group, view } = fixture()
    const hidden = signed({ recipients: [author, outsider].sort() })
    expect(() => view.live(group(row(), row(hidden, undefined, '2')))).toThrow(
      expect.objectContaining({ code: 'reset-required' })
    )
  })

  it('rejects a changed row identity and malformed lifecycle association', () => {
    const { policy, row, context } = fixture()
    expect(() => policy.snapshot({ ...row(), key: 'ff'.repeat(32) }, context)).toThrow(
      'channel key'
    )
    expect(() =>
      policy.snapshot(row(signed(), { status: 'withdrawn', recordedAt: '10' }), context)
    ).toThrow('signed head')
    expect(() =>
      policy.snapshot(row(signed(), { status: 'active', recordedAt: '100' }), context)
    ).toThrow('signed head')
    expect(() =>
      policy.snapshot(row(signed(), { status: 'expired', recordedAt: '99' }), context)
    ).toThrow('signed head')
    const malformed = row()
    malformed.value.data.version = 2
    expect(() => policy.snapshot(malformed, context)).toThrow('row format')
  })

  it.each(
    [
      [],
      ['01'.repeat(32), '01'.repeat(32)],
      ['ff'.repeat(32), '01'.repeat(32)],
      ['no'],
      Array.from({ length: 257 }, (_, n) => n.toString(16).padStart(64, '0'))
    ].map(channels => ({ channels }))
  )('rejects a malformed or over-capacity query channel selection', ({ channels }) => {
    expect(() => fixture(recipient, { channels })).toThrow()
  })

  it('accepts exactly256 selected channels and rejects unknown parameters or uninstalled policy bindings', () => {
    const { policy } = fixture()
    const channels = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(64, '0'))
    expect(policy.query({ channels }, { policy: reference })).toEqual({ channels })
    expect(() => policy.parameters({ policy: reference, other: true })).toThrow('Unknown')
    expect(() => policy.parameters({ policy: { ...reference, id: 'urn:missing' } })).toThrow(
      'not installed'
    )
  })
})

it('selects one exact policy among multiple installations and rejects either changed identity field', () => {
  const first = new AuthorDocumentPolicy()
  const second = {
    id: 'urn:example:second-document-policy',
    parameters: first.parameters.bind(first),
    validate: first.validate.bind(first),
    permits: first.permits.bind(first),
    successor: first.successor.bind(first),
    finalization: first.finalization.bind(first)
  }
  const registry = new ProposalPolicyRegistry([
    { policy: first, parameters: { maxTextBytes: 32 } },
    { policy: second, parameters: { maxTextBytes: 64 } }
  ])
  const query = new ProposalChannelHeadsQuery(registry)
  for (const { id, digest } of registry.describe()) {
    expect(query.parameters({ policy: { id, digest } })).toEqual({ policy: { id, digest } })
    for (const changed of [
      { id: 'urn:missing', digest },
      { id, digest: 'ff'.repeat(32) }
    ])
      expect(() => query.parameters({ policy: changed })).toThrow(
        expect.objectContaining({
          code: 'unsupported',
          message: 'Proposal query policy is not installed'
        })
      )
  }
})

it('keeps hidden transitions empty while reporting a terminal visible withdrawal', () => {
  const hidden = fixture(outsider),
    before = hidden.row(),
    after = hidden.row(signed(), undefined, '2')
  expect(hidden.policy.transition(hidden.group(before, after), hidden.context)).toEqual([])
  expect(hidden.policy.transition(hidden.group(null, after), hidden.context)).toEqual([])
  expect(hidden.policy.transition(hidden.group(before, null), hidden.context)).toEqual([])
  const visible = fixture()
  const withdrawal = signed({
    operation: 'withdraw',
    revision: '1',
    previous: outputPacketDigest('proposal', signed().body)
  })
  const row = visible.row(withdrawal, { status: 'withdrawn', recordedAt: '11' }, '2')
  expect(visible.policy.snapshot(row, visible.context).map(item => item.kind)).toEqual([
    'proposal',
    'proposal-state'
  ])
  expect(() =>
    visible.policy.snapshot(
      visible.row(withdrawal, { status: 'active', recordedAt: '11' }, '2'),
      visible.context
    )
  ).toThrow('Proposal query state differs from its signed head')
})
