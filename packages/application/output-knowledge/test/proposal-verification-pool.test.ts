import { describe, expect, it } from '@jest/globals'
import { canonicalOutputJSON, OutputProtocolError } from '@bsv/sdk'
import { ProposalVerificationPool } from '../src/proposals/ProposalVerificationPool.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import type { ReceivedSourceGroup } from '../src/SourceMembership.js'
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
const source = {
  chain,
  provider: author,
  service: 'ls_documents',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader',
  epoch: 'epoch'
}
function policy() {
  const { epoch: _epoch, ...selection } = source
  return new ProposalSourcePolicy(createRegistry(), recipient, [
    {
      source: selection,
      proposalService: scope.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
}
function row(): ReceivedSourceGroup {
  return {
    scope: source,
    generation: '0',
    received: '2',
    phase: 'finite',
    status: 'pending',
    group: {
      id: 'one',
      sequence: '0',
      observations: [
        { id: 'head', scope: source, kind: 'proposal', payload: { proposal: signed() } }
      ]
    }
  }
}
describe('local proposal exact-envelope receipt binding', () => {
  it('retains first local receipt through duplicate delivery and replay without repeated validation', () => {
    const input = row(),
      pool = new ProposalVerificationPool(policy()),
      stamps = pool.stamps([input], '10')
    pool.receive([input], stamps)
    const checks = pool.pending().map(stamp => pool.verify(stamp))
    expect(checks.map(check => check.status)).toEqual(['verified'])
    pool.apply(checks)
    expect(pool.pending()).toEqual([])
    expect(pool.stamps([input], '90')).toEqual([])
    pool.receive([input], [])
    const restored = new ProposalVerificationPool(policy())
    restored.receive([input], stamps)
    restored.apply(checks)
    const observed = input.group.observations[0]
    if (observed.kind !== 'proposal') throw new Error('fixture')
    expect(restored.check(input, observed.id, observed.payload.proposal)).toEqual(checks[0])
    stamps[0].firstReceivedAt = '90'
    checks[0].status = 'invalid'
    expect(restored.check(input, observed.id, observed.payload.proposal)?.status).toBe('verified')
  })

  it('does not qualify a changed signature with the same proposal body', () => {
    const input = row(),
      pool = new ProposalVerificationPool(policy())
    pool.receive([input], pool.stamps([input], '10'))
    pool.apply(pool.pending().map(stamp => pool.verify(stamp)))
    const observed = input.group.observations[0]
    if (observed.kind !== 'proposal') throw new Error('fixture')
    observed.payload.proposal.signature = 'AQ=='
    expect(pool.check(input, observed.id, observed.payload.proposal)).toBeUndefined()
    const changed = pool.stamps([input], '11')
    expect(changed).toHaveLength(1)
    pool.receive([input], changed)
    expect(pool.verify(pool.pending()[0]).status).toBe('invalid')
  })

  it('rejects altered and duplicated local bindings atomically', () => {
    const input = row(),
      pool = new ProposalVerificationPool(policy()),
      stamps = pool.stamps([input], '10')
    pool.receive([input], stamps)
    const checked = pool.verify(stamps[0])
    expect(() => pool.apply([checked, checked])).toThrow('repeated')
    expect(pool.pending()).toHaveLength(1)
    expect(() => pool.apply([{ ...checked, firstReceivedAt: '11' }])).toThrow('differs')
    expect(() => pool.verify({ ...stamps[0], firstReceivedAt: '11' })).toThrow('Unknown')
    pool.apply([checked])
    expect(() => pool.apply([checked])).not.toThrow()
    expect(() => pool.apply([{ ...checked, status: 'invalid' }])).toThrow('Conflicting')
  })

  it('checks complete receipt and byte bounds before retaining any addition', () => {
    const first = row(),
      second = row()
    second.group.id = 'two'
    const pool = new ProposalVerificationPool(policy(), 1)
    expect(() => pool.receive([first, second], pool.stamps([first, second], '10'))).toThrow(
      'capacity'
    )
    expect(pool.pending()).toEqual([])
    const tiny = new ProposalVerificationPool(policy(), 2, 1)
    expect(() => tiny.receive([first], tiny.stamps([first], '10'))).toThrow('byte capacity')
    expect(tiny.pending()).toEqual([])
    expect(() => pool.receive([first], [])).toThrow('stamp set')
    const stamps = pool.stamps([first], '10')
    stamps[0].reference.envelope = 'ff'.repeat(32)
    expect(() => pool.receive([first], stamps)).toThrow('differs')
    expect(pool.pending()).toEqual([])
  })
})

it.each(['scope', 'generation', 'group', 'observation'] as const)(
  'does not reuse qualification across a changed %s identity',
  field => {
    const input = row(),
      pool = new ProposalVerificationPool(policy())
    pool.receive([input], pool.stamps([input], '10'))
    pool.apply(pool.pending().map(stamp => pool.verify(stamp)))
    const altered = structuredClone(input)
    if (field === 'scope') altered.scope.epoch = 'another-epoch'
    if (field === 'generation') altered.generation = '1'
    if (field === 'group') altered.group.id = 'other-group'
    if (field === 'observation') altered.group.observations[0].id = 'other-observation'
    const observed = altered.group.observations[0]
    if (observed.kind !== 'proposal') throw new Error('fixture')
    expect(pool.check(altered, observed.id, observed.payload.proposal)).toBeUndefined()
  }
)

it('does not repeat signature and permission callbacks when applying retained local checks', () => {
  const installed = policy(),
    validate = installed.validate.bind(installed)
  let calls = 0
  installed.validate = (...args) => {
    calls++
    return validate(...args)
  }
  const input = row(),
    pool = new ProposalVerificationPool(installed),
    stamps = pool.stamps([input], '10')
  pool.receive([input], stamps)
  const checks = pool.pending().map(stamp => pool.verify(stamp))
  expect(calls).toBe(1)
  const replay = new ProposalVerificationPool(installed)
  replay.receive([input], stamps)
  replay.apply(checks)
  expect(calls).toBe(1)
  expect(replay.pending()).toEqual([])
})

it('does not turn interrupted installed validation into a permanent invalid verdict', () => {
  const installed = policy()
  installed.validate = () => {
    throw new Error('synthetic dependency failure')
  }
  const input = row(),
    pool = new ProposalVerificationPool(installed)
  pool.receive([input], pool.stamps([input], '10'))
  expect(() => pool.verify(pool.pending()[0])).toThrow('synthetic dependency')
  expect(pool.pending()).toHaveLength(1)
})

it('rejects a mixed duplicate stamp set without partially retaining its first item', () => {
  const first = row(),
    second = row(),
    pool = new ProposalVerificationPool(policy())
  second.group.id = 'second'
  const stamps = pool.stamps([first, second], '10')
  expect(() => pool.receive([first, second], [stamps[0], stamps[0]])).toThrow('differs')
  expect(pool.pending()).toEqual([])
  pool.receive([first, second], stamps)
  expect(pool.pending()).toHaveLength(2)
  const altered = structuredClone(pool.pending()[0])
  altered.firstReceivedAt = '90'
  expect(pool.pending()[0].firstReceivedAt).toBe('10')
})

it.each([0, -1, 4097, 1.5])('rejects an invalid retained receipt bound %s', bound => {
  expect(() => new ProposalVerificationPool(policy(), bound)).toThrow('bound')
})

it.each([0, -1, 16777217, 1.5])('rejects an invalid retained byte bound %s', bound => {
  expect(() => new ProposalVerificationPool(policy(), 2, bound)).toThrow('byte bound')
})

it('rejects an oversized decision batch before applying any retained check', () => {
  const input = row(),
    pool = new ProposalVerificationPool(policy(), 1)
  pool.receive([input], pool.stamps([input], '10'))
  const checked = pool.verify(pool.pending()[0])
  expect(() => pool.apply([checked, checked])).toThrow('decision capacity')
  expect(pool.pending()).toHaveLength(1)
  pool.apply([checked])
  expect(pool.pending()).toEqual([])
})

it('does not collect or retain private proposal work from a quarantined source group', () => {
  const rejected = row(),
    accepted = row(),
    pool = new ProposalVerificationPool(policy(), 1)
  rejected.status = 'quarantined'
  accepted.group.id = 'second'
  const stamps = pool.stamps([rejected, accepted], '10')
  expect(stamps).toHaveLength(1)
  pool.receive([rejected, accepted], stamps)
  const checks = pool.pending().map(item => pool.verify(item))
  expect(checks.map(item => item.status)).toEqual(['verified'])
  pool.apply(checks)
  const observation = rejected.group.observations[0]
  if (observation.kind !== 'proposal') throw new Error('fixture')
  expect(pool.check(rejected, observation.id, observation.payload.proposal)).toBeUndefined()
})

it('counts cumulative retained bytes and accepts the exact configured byte boundary', () => {
  const first = row(),
    second = row(),
    selected = policy()
  second.group.id = 'two'
  const unbounded = new ProposalVerificationPool(selected)
  const stamps = unbounded.stamps([first, second], '10')
  const observation = first.group.observations[0]
  if (observation.kind !== 'proposal') throw new Error('fixture')
  const bytes = new TextEncoder().encode(
    canonicalOutputJSON({
      stamp: stamps[0],
      scope: first.scope,
      proposal: observation.payload.proposal
    })
  ).length
  const exact = new ProposalVerificationPool(selected, 2, bytes)
  exact.receive([first], [stamps[0]])
  expect(exact.pending()).toEqual([stamps[0]])
  const cumulative = new ProposalVerificationPool(selected, 2, bytes * 2 - 1)
  cumulative.receive([first], [stamps[0]])
  expect(() => cumulative.receive([second], [stamps[1]])).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect(cumulative.pending()).toEqual([stamps[0]])
})

it.each(['unsupported', 'unauthorized'] as const)(
  'retains an exact %s decision without retrying it as unresolved work',
  status => {
    const input = row()
    const base = policy()
    const selected =
      status === 'unauthorized'
        ? new ProposalSourcePolicy(createRegistry(), outsider, base.describe().rules)
        : base
    if (status === 'unsupported') input.scope = { ...source, access: 'uninstalled' }
    const pool = new ProposalVerificationPool(selected)
    pool.receive([input], pool.stamps([input], '10'))
    const checked = pool.verify(pool.pending()[0])
    expect(checked.status).toBe(status)
    pool.apply([checked])
    expect(pool.pending()).toEqual([])
    const observation = input.group.observations[0]
    if (observation.kind !== 'proposal') throw new Error('fixture')
    const returned = pool.check(input, observation.id, observation.payload.proposal)!
    returned.status = 'verified'
    expect(pool.check(input, observation.id, observation.payload.proposal)?.status).toBe(status)
  }
)

it('propagates an operational protocol error without recording it as a negative proposal verdict', () => {
  const selected = policy()
  selected.validate = () => {
    throw new OutputProtocolError('unavailable', 'Temporary installed dependency failure', true)
  }
  const input = row(),
    pool = new ProposalVerificationPool(selected)
  pool.receive([input], pool.stamps([input], '10'))
  expect(() => pool.verify(pool.pending()[0])).toThrow(
    expect.objectContaining({ code: 'unavailable', retryable: true })
  )
  expect(pool.pending()).toHaveLength(1)
})

it('ignores a lifecycle-only observation while retaining its accompanying signed head', () => {
  const input = row(),
    pool = new ProposalVerificationPool(policy())
  input.group.observations.push({
    id: 'report',
    scope: source,
    kind: 'proposal-remove',
    payload: {
      service: scope.service,
      policy: reference,
      channel: '02'.repeat(32),
      proposalId: '03'.repeat(32),
      reason: 'Catalogue removal'
    }
  })
  const stamps = pool.stamps([input], '10')
  expect(stamps).toHaveLength(1)
  pool.receive([input], stamps)
  expect(pool.verify(pool.pending()[0]).status).toBe('verified')
})
