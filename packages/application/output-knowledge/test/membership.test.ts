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

describe('standalone membership intake and complete publication boundaries', () => {
  const snapshot = (ledger: SourceMembershipLedger) => ({
    groups: ledger.groups(),
    states: ledger.sourceStates(),
    memberships: ledger.memberships(),
    observations: ledger.observations(),
    published: ledger.publishedGroups(),
    pending: ledger.pending()
  })

  it('retains the same visible generation and idempotent outcomes after same-generation equivocation', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    ledger.receive(batch('pending', '11', [observation('pending')], 'live'), '2')
    expect(
      ledger.receiveRetainingEquivocation(
        batch('pending', '11', [observation('conflicting')], 'live'),
        '3'
      )
    ).toBe('quarantined')
    expect(ledger.sourceStates()).toMatchObject([
      { generation: '0', current: true, visible: true, continuous: false, complete: true }
    ])
    expect(ledger.groups().map(row => [row.group.id, row.status])).toEqual([
      ['seed', 'accepted'],
      ['pending', 'quarantined']
    ])
    expect(() => ledger.decide(scope, '0', 'pending', 'quarantined')).not.toThrow()
    expect(() => ledger.decide(scope, '0', 'seed', 'accepted')).not.toThrow()
    expect(ledger.memberships()[0].observationId).toBe('seed')
    expect(ledger.observations().map(row => row.id)).toEqual(['seed'])
    expect(ledger.quarantines()).toHaveLength(1)
  })

  it.each(['-1', '01', '18446744073709551616'])(
    'refuses a noncanonical local receipt clock without retaining source data: %s',
    received => {
      const ledger = new SourceMembershipLedger(),
        before = snapshot(ledger)
      expect(() => ledger.receive(batch('seed'), received)).toThrow(
        expect.objectContaining({ code: 'invalid' })
      )
      expect(snapshot(ledger)).toEqual(before)
    }
  )

  it('publishes an initial empty source progressively before its explicit complete-seed acceptance', () => {
    const ledger = new SourceMembershipLedger(),
      input = batch('unused')
    input.groups = []
    ledger.receive(input, '1')
    expect(ledger.sourceStates()).toMatchObject([
      { current: true, visible: true, continuous: true, complete: false, snapshot: true }
    ])
    expect(ledger.hasPendingCompletion()).toBe(true)
    ledger.acceptCompletions()
    expect(ledger.hasPendingCompletion()).toBe(false)
    expect(ledger.sourceStates()[0].complete).toBe(true)
  })

  it('rejects a changed epoch at the same generation without replacing the visible source', () => {
    const ledger = new SourceMembershipLedger(),
      changed = { ...scope, epoch: 'unexpected-epoch' }
    accepted(ledger, batch('seed'), '1')
    const before = snapshot(ledger)
    expect(() =>
      ledger.receive(batch('other', '10', [], 'snapshot', '0', true, changed), '2')
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Retired source generation or changed epoch'
      })
    )
    expect(snapshot(ledger)).toEqual(before)
  })

  it.each(['initial', 'replacement'] as const)(
    'requires a durable seed before accepting live groups in a new %s generation',
    mode => {
      const ledger = new SourceMembershipLedger()
      if (mode === 'replacement') accepted(ledger, batch('seed'), '1')
      const before = snapshot(ledger)
      expect(() =>
        ledger.receive(batch('live', '11', [], 'live', mode === 'initial' ? '0' : '1'), '2')
      ).toThrow(
        expect.objectContaining({
          code: 'reset-required',
          message: 'A new source generation requires a snapshot'
        })
      )
      expect(snapshot(ledger)).toEqual(before)
    }
  )

  it('refuses reinterpreting a retained snapshot group as a live receipt', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    const before = snapshot(ledger)
    expect(() => ledger.receive(batch('seed', '10', [observation('seed')], 'live'), '2')).toThrow(
      expect.objectContaining({ code: 'equivocation', message: 'Source group identity was reused' })
    )
    expect(snapshot(ledger)).toEqual(before)
  })

  it('advances an empty durable live watermark and rejects both stale and equal new groups', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    const watermark = batch('unused', '15', [], 'live')
    watermark.groups = []
    ledger.receive(watermark, '2')
    for (const sequence of ['12', '15'])
      expect(() => ledger.receive(batch('stale-' + sequence, sequence, [], 'live'), '3')).toThrow(
        expect.objectContaining({
          code: 'equivocation',
          message: 'New live group predates the received watermark'
        })
      )
    accepted(ledger, batch('next', '16', [observation('next')], 'live'), '4')
    expect(ledger.memberships()[0].observationId).toBe('next')
  })

  it('accepts the complete snapshot boundary while a later live group still awaits verification', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('page', '10', [observation('seed')], 'snapshot', '0', false), '1')
    ledger.receive(batch('end', '10', []), '2')
    ledger.receive(batch('live', '11', [observation('live')], 'live'), '3')
    ledger.decide(scope, '0', 'end', 'accepted')
    expect(ledger.sourceStates()).toMatchObject([{ complete: true, continuous: false }])
    expect(ledger.publishedGroups().map(row => row.group.id)).toEqual(['page', 'end'])
    ledger.decide(scope, '0', 'live', 'accepted')
    expect(ledger.sourceStates()).toMatchObject([{ complete: true, continuous: true }])
    expect(ledger.memberships()[0].observationId).toBe('live')
  })

  it('requires an explicit snapshot watermark before retaining any group', () => {
    const ledger = new SourceMembershipLedger(),
      input = batch('missing-watermark'),
      before = snapshot(ledger)
    delete input.coverage.through
    expect(() => ledger.receive(input, '1')).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Snapshot watermark is required' })
    )
    expect(snapshot(ledger)).toEqual(before)
    accepted(ledger, batch('valid'), '2')
    expect(ledger.memberships()[0].observationId).toBe('valid')
  })

  it.each(['finite-first', 'snapshot-first'] as const)(
    'refuses mixed finite and durable receipts atomically: %s',
    order => {
      const ledger = new SourceMembershipLedger(),
        first = order === 'finite-first' ? 'finite' : 'snapshot',
        second = first === 'finite' ? 'snapshot' : 'finite'
      accepted(
        ledger,
        batch('seed', first === 'finite' ? '0' : '10', [observation('seed')], first, '0', false),
        '1'
      )
      const before = snapshot(ledger)
      expect(() =>
        ledger.receive(batch('mixed', second === 'finite' ? '0' : '10', [], second), '2')
      ).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Mixed finite and durable source generation'
        })
      )
      expect(snapshot(ledger)).toEqual(before)
    }
  )

  it.each(['finite', 'snapshot'] as const)(
    'refuses newly arriving groups after the complete %s seed',
    phase => {
      const ledger = new SourceMembershipLedger(),
        sequence = phase === 'finite' ? '0' : '10'
      accepted(ledger, batch('seed', sequence, [observation('seed')], phase), '1')
      const before = snapshot(ledger)
      expect(() => ledger.receive(batch('late', sequence, [], phase), '2')).toThrow(
        expect.objectContaining({
          code: 'equivocation',
          message: 'Completed source snapshot acquired another group'
        })
      )
      expect(snapshot(ledger)).toEqual(before)
      ledger.receive(batch('seed', sequence, [observation('seed')], phase), '3')
      ledger.decide(scope, '0', 'seed', 'accepted')
      expect(snapshot(ledger)).toEqual(before)
    }
  )

  function unwatermarkedLive(id: string, sequence: string): SourceBatch {
    const input = batch(id, sequence, [observation(id)], 'live')
    delete input.coverage.through
    delete input.coverage.highWater
    return parseSourceBatch(input, input.provenance, runtimeLimits())
  }

  it('rejects different live groups at one sequence across receipts without a new watermark', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    ledger.receive(unwatermarkedLive('one', '11'), '2')
    const before = snapshot(ledger)
    expect(() => ledger.receive(unwatermarkedLive('two', '11'), '3')).toThrow(
      expect.objectContaining({ code: 'equivocation', message: 'Live sequence was reused' })
    )
    expect(snapshot(ledger)).toEqual(before)
    ledger.decide(scope, '0', 'one', 'accepted')
    expect(ledger.memberships()[0].observationId).toBe('one')
  })

  it('requires a known pending group and preserves an accepted whole-group verdict', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    const before = snapshot(ledger)
    expect(() => ledger.decide(scope, '0', 'absent', 'accepted')).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Unknown source group' })
    )
    expect(() => ledger.decide(scope, '0', 'seed', 'quarantined')).toThrow(
      expect.objectContaining({ code: 'equivocation', message: 'Whole-group outcome changed' })
    )
    expect(snapshot(ledger)).toEqual(before)
  })

  it('retains an initially unavailable empty generation without publishing invented membership', () => {
    const ledger = new SourceMembershipLedger(),
      input = batch('unused')
    input.groups = []
    input.coverage.status = 'reset-required'
    ledger.receive(input, '1')
    expect(ledger.memberships()).toEqual([])
    expect(ledger.observations()).toEqual([])
    expect(ledger.publishedGroups()).toEqual([])
    expect(ledger.sourceStates()).toMatchObject([
      { current: true, visible: false, continuous: false, complete: false }
    ])
    expect(ledger.hasPendingContinuity()).toBe(true)
    expect(ledger.hasPendingCompletion()).toBe(false)
    expect(ledger.canAccept(scope, '0')).toBe(false)
    expect(ledger.pending()).toEqual([
      {
        scope,
        groupId: 'continuity-reset:0',
        reason: 'Source continuity unavailable; generation reset required'
      }
    ])
    ledger.acceptContinuity()
    expect(ledger.hasPendingContinuity()).toBe(false)
    accepted(ledger, batch('replacement', '20', [], 'snapshot', '1'), '2')
    expect(ledger.pending()).toEqual([])
    expect(ledger.hasPendingCompletion()).toBe(false)
  })

  it('publishes accepted out-of-receipt-order live groups in numeric sequence order', () => {
    const ledger = new SourceMembershipLedger()
    accepted(ledger, batch('seed'), '1')
    ledger.receive(unwatermarkedLive('later', '13'), '2')
    ledger.receive(unwatermarkedLive('earlier', '11'), '3')
    ledger.decide(scope, '0', 'later', 'accepted')
    expect(ledger.publishedGroups().map(row => row.group.id)).toEqual(['seed'])
    ledger.decide(scope, '0', 'earlier', 'accepted')
    expect(ledger.publishedGroups().map(row => row.group.id)).toEqual(['seed', 'earlier', 'later'])
    expect(ledger.memberships()[0].observationId).toBe('later')
  })

  it('orders equal-transaction membership by output index and owns all returned records', () => {
    const ledger = new SourceMembershipLedger(),
      indices = [31, 2, 17, 0],
      observations = indices.map(index => ({
        id: `remove-${index}`,
        scope,
        kind: 'withdraw' as const,
        payload: { outpoint: { ...outpoint, outputIndex: index }, reason: 'Query membership' }
      }))
    accepted(ledger, batch('seed', '10', observations), '1')
    const rows = ledger.memberships()
    expect(rows.map(row => row.outpoint.outputIndex)).toEqual([0, 2, 17, 31])
    expect(rows.every(row => !row.present)).toBe(true)
    rows[0].outpoint.outputIndex = 42
    expect(ledger.memberships()[0].outpoint.outputIndex).toBe(0)
  })

  it('orders retained observation identifiers by UTF-8 bytes including prefixes and astral names', () => {
    const ledger = new SourceMembershipLedger(),
      ids = ['😀', 'aa', 'é', 'a', '𝄞', 'a0', '\uE000', 'a/']
    accepted(
      ledger,
      batch(
        'seed',
        '10',
        ids.map(id => observation(id))
      ),
      '1'
    )
    expect(ledger.observations().map(row => row.id)).toEqual([
      'a',
      'a/',
      'a0',
      'aa',
      'é',
      '\uE000',
      '𝄞',
      '😀'
    ])
  })

  it('orders many interleaved source generations numerically without truncating retained history', () => {
    const ledger = new SourceMembershipLedger(),
      sources = Array.from({ length: 12 }, (_, i) => ({
        ...scope,
        provider: `source-${String(11 - i).padStart(2, '0')}`
      }))
    for (let generation = 0; generation < 12; generation++)
      for (const selected of sources) {
        const input = batch('unused', '10', [], 'snapshot', String(generation), true, selected)
        input.groups = []
        ledger.receive(input, String(generation + 1))
        ledger.acceptCompletions()
      }
    const states = ledger.sourceStates()
    expect(states).toHaveLength(144)
    for (let source = 0; source < 12; source++) {
      const rows = states.slice(source * 12, (source + 1) * 12)
      expect(rows.map(row => row.generation)).toEqual(
        Array.from({ length: 12 }, (_, i) => String(i))
      )
      expect(rows.map(row => row.scope.provider)).toEqual(
        Array.from({ length: 12 }, () => `source-${String(source).padStart(2, '0')}`)
      )
      expect(rows.filter(row => row.current || row.visible).map(row => row.generation)).toEqual([
        '11'
      ])
    }
    expect(ledger.groups()).toEqual([])
    expect(ledger.publishedGroups()).toEqual([])
  })

  it('retains source order when a sorting host evaluates comparator arguments in reverse polarity', () => {
    const ledger = new SourceMembershipLedger()
    for (const generation of ['0', '1', '2', '10']) {
      const input = batch('unused', '10', [], 'snapshot', generation)
      input.groups = []
      ledger.receive(input, '1')
      ledger.acceptCompletions()
    }
    const expected = ledger.sourceStates(),
      nativeSort = Array.prototype.sort
    let actual: ReturnType<SourceMembershipLedger['sourceStates']>
    try {
      // A conforming sorting host may compare either pair polarity. Reversing
      // the operands and result sign is equivalent for a lawful comparator;
      // the native algorithm, receiver, elements and stable ordering remain.
      Array.prototype.sort = function <T>(this: T[], compare?: (left: T, right: T) => number): T[] {
        if (!compare) return nativeSort.call(this) as T[]
        return nativeSort.call(this, (left: T, right: T) => -compare(right, left)) as T[]
      }
      actual = ledger.sourceStates()
    } finally {
      Array.prototype.sort = nativeSort
    }
    expect(actual).toEqual(expected)
    expect(actual.map(row => row.generation)).toEqual(['0', '1', '2', '10'])
  })
})
