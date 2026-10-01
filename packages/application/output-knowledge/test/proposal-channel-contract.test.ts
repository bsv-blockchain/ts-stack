import { expect, it } from '@jest/globals'
import {
  outputPacketDigest,
  type OutputJSON,
  type OutputObservation,
  type OutputSourceGroup,
  type OutputSignedProposal
} from '@bsv/sdk'
import { ProposalChannelHeadsContract } from '../src/proposals/ProposalChannelHeadsContract.js'
import {
  author,
  chain,
  createRegistry,
  reference,
  signed,
  scope
} from './proposal-client-fixture.js'

function fixture(channels?: string[]) {
  const parameters = { policy: reference },
    query: OutputJSON = channels === undefined ? {} : { channels }
  const source = {
    ...scope,
    chain,
    provider: author,
    epoch: 'one',
    access: 'reader',
    rulesDigest: outputPacketDigest('service-rules', {
      id: 'https://bsv.brc.dev/overlays/0194#proposal-channel-heads-v1',
      parameters
    }),
    queryDigest: outputPacketDigest('lookup-query', { service: scope.service, query })
  }
  const contract = new ProposalChannelHeadsContract(createRegistry(), source, parameters, query)
  const head = (proposal: OutputSignedProposal): OutputObservation => ({
    id: 'head',
    scope: source,
    kind: 'proposal',
    payload: { proposal }
  })
  const state = (proposal: OutputSignedProposal): OutputObservation => ({
    id: 'state',
    scope: source,
    kind: 'proposal-state',
    payload: {
      service: scope.service,
      policy: reference,
      channel: proposal.body.channel,
      proposalId: outputPacketDigest('proposal', proposal.body),
      state: { status: 'active', recordedAt: '10' }
    }
  })
  const remove = (proposal: OutputSignedProposal): OutputObservation => ({
    id: 'remove',
    scope: source,
    kind: 'proposal-remove',
    payload: {
      service: scope.service,
      policy: reference,
      channel: proposal.body.channel,
      proposalId: outputPacketDigest('proposal', proposal.body),
      reason: 'replaced'
    }
  })
  const group = (...observations: OutputObservation[]): OutputSourceGroup => ({
    id: 'group',
    sequence: '1',
    observations: observations.map((item, index) => ({ ...item, id: String(index) }))
  })
  return { contract, source, parameters, query, head, state, remove, group }
}

it('accepts an initial or historical snapshot pair without inventing predecessor history', () => {
  const f = fixture()
  for (const proposal of [signed(), signed({ revision: '4', previous: 'aa'.repeat(32) })]) {
    const group = f.group(f.head(proposal), f.state(proposal)),
      original = structuredClone(group)
    const changes = f.contract.check(group, 'snapshot')
    expect(changes).toEqual([
      {
        channel: proposal.body.channel,
        head: { proposal, state: { status: 'active', recordedAt: '10' } }
      }
    ])
    changes[0].head!.proposal.body.payload = ''
    expect(group).toEqual(original)
  }
})

it('keeps a replacement and a second channel in their complete ordered domain group', () => {
  const f = fixture(),
    old = signed({ channel: '11'.repeat(32) })
  const next = signed({
    channel: old.body.channel,
    revision: '1',
    previous: outputPacketDigest('proposal', old.body)
  })
  const other = signed({ channel: '22'.repeat(32) })
  const result = f.contract.check(
    f.group(f.remove(old), f.head(next), f.state(next), f.head(other), f.state(other)),
    'live'
  )
  expect(result.map(item => item.channel)).toEqual([old.body.channel, other.body.channel])
  expect(result[0].removed?.proposalId).toBe(outputPacketDigest('proposal', old.body))
  expect(result[0].head?.proposal).toEqual(next)
  expect(result[1].removed).toBeUndefined()
  expect(f.contract.check(f.group(f.remove(old)), 'live')).toEqual([
    { channel: old.body.channel, removed: f.remove(old).payload }
  ])
})

it.each(['rulesDigest', 'queryDigest'] as const)(
  'rejects a different retained %s selection',
  field => {
    const f = fixture()
    expect(
      () =>
        new ProposalChannelHeadsContract(
          createRegistry(),
          { ...f.source, [field]: 'ff'.repeat(32) },
          f.parameters,
          f.query
        )
    ).toThrow(expect.objectContaining({ code: 'context-changed' }))
  }
)

it('refuses partial pairs, orphan states, snapshot removals and multiple snapshot channels', () => {
  const f = fixture(),
    proposal = signed(),
    other = signed({ channel: 'ff'.repeat(32) })
  const malformed = [
    f.group(),
    f.group(f.head(proposal)),
    f.group(f.state(proposal), f.head(proposal)),
    f.group(f.remove(proposal), f.state(proposal)),
    f.group(f.head(proposal), f.state(other)),
    f.group(f.head(proposal), f.state(proposal), f.head(other), f.state(other))
  ]
  for (const group of malformed)
    expect(() => f.contract.check(group, 'snapshot')).toThrow(
      expect.objectContaining({ code: 'equivocation' })
    )
  expect(() => f.contract.check(f.group(f.head(proposal)), 'live')).toThrow('exact state')
})

it('rejects changed scope, foreign policy/service, excluded channels and an unrelated replacement', () => {
  const proposal = signed(),
    f = fixture(['ff'.repeat(32)])
  expect(() => f.contract.check(f.group(f.head(proposal), f.state(proposal)), 'snapshot')).toThrow(
    'outside'
  )
  const selected = fixture()
  const altered = selected.group(selected.head(proposal), selected.state(proposal))
  altered.observations[1].scope = { ...selected.source, epoch: 'other' }
  expect(() => selected.contract.check(altered, 'snapshot')).toThrow('scope changed')
  for (const next of [
    signed({ service: 'other' }),
    signed({ policy: { ...reference, digest: 'ff'.repeat(32) } })
  ])
    expect(() =>
      selected.contract.check(selected.group(selected.head(next), selected.state(next)), 'snapshot')
    ).toThrow('outside')
  const unrelated = signed({ revision: '1', previous: 'ff'.repeat(32) })
  expect(() =>
    selected.contract.check(
      selected.group(
        selected.remove(proposal),
        selected.head(unrelated),
        selected.state(unrelated)
      ),
      'live'
    )
  ).toThrow('predecessor')
})

it('rejects duplicate/reversed channels and same-body removal/replacement', () => {
  const f = fixture(),
    first = signed({ channel: '11'.repeat(32) }),
    second = signed({ channel: '22'.repeat(32) })
  for (const group of [
    f.group(f.head(second), f.state(second), f.head(first), f.state(first)),
    f.group(f.head(first), f.state(first), f.head(first), f.state(first))
  ])
    expect(() => f.contract.check(group, 'live')).toThrow('unique and sorted')
  expect(() =>
    f.contract.check(f.group(f.remove(first), f.head(first), f.state(first)), 'live')
  ).toThrow('predecessor')
})
