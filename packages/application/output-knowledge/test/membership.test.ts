import { describe, expect, it } from '@jest/globals'
import type { OutputObservation, OutputScope, SourceBatch } from '../src/index.js'
import { parseSourceBatch, runtimeLimits } from '../src/index.js'
import { SourceMembershipLedger } from '../src/SourceMembership.js'
import { chain, partition, candidate } from './evidence-fixture.js'

const scope: OutputScope = {
  chain,
  provider: 'configured-source-a',
  service: 'records',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'public',
  epoch: 'epoch-0'
}
const outpoint = { chain, txid: candidate('A').evidence.txid, outputIndex: 0 }
function observation(id: string, withdraw = false, selectedScope = scope): OutputObservation {
  return withdraw
    ? {
        id,
        scope: selectedScope,
        kind: 'withdraw',
        payload: { outpoint, reason: 'Index policy changed' }
      }
    : { id, scope: selectedScope, kind: 'output', payload: { evidence: candidate('A').evidence } }
}
function batch(
  id: string,
  sequence = '10',
  observations = [observation(id)],
  phase: SourceBatch['coverage']['phase'] = 'snapshot',
  generation = '0',
  complete = true,
  selectedScope = scope
): SourceBatch {
  const result: SourceBatch = {
    provenance: {
      partition,
      generation,
      adapter: 'test',
      scope: selectedScope,
      authentication: 'configured-transport',
      peer: selectedScope.provider,
      receivedAt: '1'
    },
    groups: [{ id, sequence, observations }],
    coverage: {
      scope: selectedScope,
      phase,
      status: complete ? 'complete' : 'partial',
      ...(phase === 'finite' ? {} : { through: sequence, highWater: sequence })
    }
  }
  return parseSourceBatch(result, result.provenance, runtimeLimits())
}
function accepted(ledger: SourceMembershipLedger, input: SourceBatch, received: string): void {
  ledger.receive(input, received)
  for (const group of input.groups)
    ledger.decide(input.provenance.scope, input.provenance.generation, group.id, 'accepted')
}

describe('whole-group source membership ordering', () => {
  it('does not let verification completion reorder withdrawal and re-entry', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    ledger.receive(batch('remove', '11', [observation('remove', true)], 'live'), '2')
    ledger.receive(batch('return', '12', [observation('return')], 'live'), '3')
    ledger.decide(scope, '0', 'return', 'accepted')
    expect(ledger.memberships()[0]).toMatchObject({
      present: true,
      sequence: '10',
      observationId: 'seed'
    })
    ledger.decide(scope, '0', 'remove', 'accepted')
    expect(ledger.memberships()[0]).toMatchObject({
      present: true,
      sequence: '12',
      observationId: 'return'
    })
    accepted(ledger, batch('remove', '11', [observation('remove', true)], 'live'), '4')
    expect(ledger.memberships()[0].sequence).toBe('12')
  })

  it('retains observation order within an indivisible group', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed', '10', [observation('out'), observation('withdraw', true)]), '1')
    expect(ledger.memberships()[0]).toMatchObject({ present: false, observationId: 'withdraw' })
    expect(ledger.observations()).toHaveLength(2)
  })

  it('publishes only the accepted snapshot prefix when pages share a watermark', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('page-0', '10', [observation('seed')], 'snapshot', '0', false), '1')
    ledger.receive(
      batch('page-1', '10', [observation('remove', true)], 'snapshot', '0', false),
      '2'
    )
    accepted(ledger, batch('page-2', '10', [observation('return')]), '3')
    expect(ledger.memberships()[0]).toMatchObject({ present: true, observationId: 'seed' })
    expect(ledger.observations().map(row => row.id)).toEqual(['seed'])
    ledger.decide(scope, '0', 'page-1', 'accepted')
    expect(ledger.memberships()[0]).toMatchObject({ present: true, observationId: 'return' })
    expect(ledger.observations()).toHaveLength(3)
  })

  it('stages a replacement snapshot and fences late work from the retired generation', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    const next = { ...scope, epoch: 'epoch-1' }
    accepted(
      ledger,
      batch('page-1', '40', [observation('new', true, next)], 'snapshot', '1', false, next),
      '2'
    )
    expect(ledger.memberships()[0]).toMatchObject({ generation: '0', present: true })
    const end = batch('page-2', '40', [], 'snapshot', '1', true, next)
    ledger.receive(end, '3')
    expect(ledger.memberships()[0].generation).toBe('0')
    ledger.decide(next, '1', 'page-2', 'accepted')
    expect(ledger.memberships()[0]).toMatchObject({ generation: '1', present: false })
    expect(() => ledger.decide(scope, '0', 'seed', 'accepted')).toThrow('retired')
    expect(() => ledger.receive(batch('late', '11', [observation('late')], 'live'), '4')).toThrow(
      'Retired'
    )
  })

  it('keeps other sources and input objects independent during replacement', () => {
    const ledger = new SourceMembershipLedger(),
      other = { ...scope, provider: 'configured-source-b' }
    const input = batch('a')
    accepted(ledger, input, '1')
    input.groups[0].observations.splice(0)
    accepted(
      ledger,
      batch('b', '20', [observation('b', false, other)], 'snapshot', '0', true, other),
      '2'
    )
    accepted(ledger, batch('refresh', '0', [], 'finite', '1'), '3')
    expect(ledger.memberships()).toHaveLength(1)
    expect(ledger.memberships()[0].scope.provider).toBe(other.provider)
    expect(ledger.observations()).toHaveLength(1)
  })

  it('quarantines an entire group, preserves prior membership, and requires a new generation', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    accepted(ledger, batch('withdraw', '11', [observation('withdraw', true)], 'live'), '2')
    ledger.receive(
      batch('bad', '12', [observation('good-sibling'), observation('bad-sibling')], 'live'),
      '3'
    )
    ledger.decide(scope, '0', 'bad', 'quarantined')
    expect(ledger.memberships()[0]).toMatchObject({ sequence: '11', present: false })
    expect(ledger.observations().some(row => row.id === 'good-sibling')).toBe(false)
    expect(ledger.pending()[0].reason).toContain('quarantined')
    expect(() => ledger.receive(batch('later', '13', [], 'live'), '4')).toThrow('continuity')
    accepted(ledger, batch('new-seed', '50', [], 'snapshot', '1'), '5')
    expect(ledger.memberships()).toEqual([])
  })

  it('detects changed group bytes, duplicate observation identity, and new stale live groups', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    expect(() => ledger.receive(batch('seed', '10', [observation('changed')]), '2')).toThrow(
      'identity was reused'
    )
    expect(() => ledger.receive(batch('stale', '9', [], 'live'), '2')).toThrow('watermark')
    expect(() => ledger.receive(batch('next', '11', [observation('seed')], 'live'), '2')).toThrow(
      'another source group'
    )
    accepted(
      ledger,
      batch('valid-after-rejection', '11', [observation('valid-after-rejection')], 'live'),
      '2'
    )
    expect(ledger.memberships()[0].observationId).toBe('valid-after-rejection')
  })

  it('requires stable completed-snapshot watermarks before live state and permits a transient outage', () => {
    const ledger = new SourceMembershipLedger()
    expect(() => ledger.receive(batch('live', '1', [], 'live'), '1')).toThrow('requires a snapshot')
    accepted(ledger, batch('seed', '10', [observation('seed')], 'snapshot', '0', false), '1')
    expect(() => ledger.receive(batch('page', '11', [], 'snapshot'), '2')).toThrow(
      'watermark changed'
    )
    expect(() => ledger.receive(batch('live', '11', [], 'live'), '2')).toThrow('completed snapshot')
    accepted(ledger, batch('end', '10', []), '2')
    const outage = batch('outage', '10', [], 'live')
    outage.groups = []
    outage.coverage.status = 'unavailable'
    ledger.receive(outage, '3')
    accepted(ledger, batch('return', '11', [observation('return')], 'live'), '4')
    expect(ledger.memberships()[0].sequence).toBe('11')
  })

  it('preserves immutable observation identities across refreshes within an epoch', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed', '10', [observation('stable')]), '1')
    accepted(ledger, batch('refresh', '20', [observation('stable')], 'snapshot', '1'), '2')
    expect(ledger.memberships()[0]).toMatchObject({ generation: '1', present: true })
    expect(() =>
      ledger.receive(batch('changed', '30', [observation('stable', true)], 'snapshot', '2'), '3')
    ).toThrow('identity changed within the source epoch')
    expect(ledger.memberships()[0]).toMatchObject({ generation: '1', present: true })
    expect(ledger.groups()).toHaveLength(2)
    const next = { ...scope, epoch: 'epoch-1' }
    accepted(
      ledger,
      batch('new-epoch', '30', [observation('stable', true, next)], 'snapshot', '2', true, next),
      '3'
    )
    expect(ledger.memberships()[0]).toMatchObject({ generation: '2', present: false, scope: next })
    // Changing back to a previously used epoch does not release its identities.
    expect(() =>
      ledger.receive(batch('old-epoch', '40', [observation('stable', true)], 'snapshot', '3'), '4')
    ).toThrow('identity changed within the source epoch')
  })

  it('does not reserve observation identities or retire a generation on rejected intake', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed', '10', [observation('stable')]), '1')
    expect(() =>
      ledger.receive(
        batch('rejected', '20', [observation('new'), observation('stable', true)], 'snapshot', '1'),
        '2'
      )
    ).toThrow('identity changed within the source epoch')
    accepted(ledger, batch('withdraw', '11', [observation('live', true)], 'live'), '2')
    expect(ledger.memberships()[0]).toMatchObject({ generation: '0', present: false })
    accepted(ledger, batch('valid', '20', [observation('new', true)], 'snapshot', '1'), '3')
    expect(ledger.memberships()[0]).toMatchObject({ generation: '1', observationId: 'new' })
  })

  it('enforces trusted local provenance and bounded closed batch schemas', () => {
    const input = batch('seed'),
      expected = input.provenance
    expect(() => parseSourceBatch({ ...input, hidden: true }, expected, runtimeLimits())).toThrow()
    expect(() =>
      parseSourceBatch(
        { ...input, provenance: { ...expected, generation: '1' } },
        expected,
        runtimeLimits()
      )
    ).toThrow('generation')
    expect(() =>
      parseSourceBatch(
        { ...input, provenance: { ...expected, partition: { ...partition, account: 'bob' } } },
        expected,
        runtimeLimits()
      )
    ).toThrow('partition')
    expect(() => parseSourceBatch(input, expected, runtimeLimits({ batchBytes: 64 }))).toThrow()
    expect(() =>
      parseSourceBatch(
        { ...input, groups: [...input.groups, ...input.groups] },
        expected,
        runtimeLimits()
      )
    ).toThrow('duplicated')
  })
})
