import { describe, expect, it } from '@jest/globals'
import { outputPacketDigest, Utils, type OutputSignedProposal } from '@bsv/sdk'
import {
  ProposalTransitions,
  proposalRecordToken,
  type ProposalAdmissionOutcome,
  type ProposalChannelRecord
} from '../src/proposals/index.js'
import { author, recipient, scope, registry, signed, finalize } from './proposal-fixture.js'

const lifecycle = new ProposalTransitions(registry, scope, {
  maxLifetimeSeconds: '100',
  futureSkewSeconds: '2'
})
function active(proposal = signed()): ProposalChannelRecord {
  return lifecycle.put(undefined, proposal, author, '10').next
}
function request(proposal: OutputSignedProposal, operationId = 'operation-number-one') {
  const tx = finalize(proposal)
  return {
    raw: Utils.toBase64(tx.toBinary()),
    request: {
      version: 1,
      operationId,
      service: scope.service,
      proposalId: outputPacketDigest('proposal', proposal.body),
      txid: tx.id('hex'),
      beef: 'AA=='
    }
  }
}
function reserve(record = active(), now = '11'): ProposalChannelRecord {
  const input = request(record.proposal)
  return lifecycle.reserve(record, author, input.request, input.raw, now).next
}
function outcome(record: ProposalChannelRecord): ProposalAdmissionOutcome {
  return {
    status: 'admitted',
    operationId: record.admission!.operationId,
    txid: record.admission!.txid,
    steak: {},
    assessmentContextId: 'verified-topic-context'
  }
}

describe('proposal lifecycle transition plans', () => {
  it('creates distinct proposal/state events and an owned record without claiming a durable commit', () => {
    const input = signed()
    const plan = lifecycle.put(undefined, input, author, '10')
    expect(plan.expectedToken).toBeNull()
    expect(plan.changed).toBe(true)
    expect(plan.events.map(event => event.kind)).toEqual(['proposal', 'proposal-state'])
    expect(plan.next.state).toEqual({ status: 'active', recordedAt: '10' })
    expect(plan.next.admission).toBeUndefined()
    input.body.expiresAt = '11'
    expect(plan.next.proposal.body.expiresAt).toBe('100')
    expect(() => lifecycle.put(undefined, signed({ operation: 'withdraw' }), author, '10')).toThrow(
      'revision-zero'
    )
    expect(() =>
      lifecycle.put(undefined, signed({ revision: '1', previous: 'aa'.repeat(32) }), author, '10')
    ).toThrow('revision-zero')
    expect(() => lifecycle.put(undefined, signed(), recipient, '10')).toThrow('authorize')
  })

  it('keeps the original result on same-body retries, including a separately generated signature', () => {
    const record = active()
    const retry = lifecycle.put(record, signed(), author, '500')
    expect(retry.changed).toBe(false)
    expect(retry.events).toEqual([])
    expect(retry.next).toEqual(record)
    expect(retry.expectedToken).toBe(proposalRecordToken(record))
    retry.next.state.recordedAt = '999'
    expect(record.state.recordedAt).toBe('10')
    expect(() => lifecycle.put(record, signed(), recipient, '500')).toThrow('authorize')
  })

  it('serializes signed next revisions against a whole-record token and refuses terminal reopening', () => {
    const record = active()
    const next = signed({ revision: '1', previous: record.proposalId, operation: 'withdraw' })
    const plan = lifecycle.put(record, next, author, '20')
    expect(plan.expectedToken).toBe(proposalRecordToken(record))
    expect(plan.next.state.status).toBe('withdrawn')
    expect(proposalRecordToken(plan.next)).not.toBe(plan.expectedToken)
    expect(lifecycle.put(plan.next, next, author, '101').changed).toBe(false)
    const reopen = signed({
      revision: '2',
      previous: plan.next.proposalId,
      issuedAt: '20',
      expiresAt: '120'
    })
    expect(() => lifecycle.put(plan.next, reopen, author, '30')).toThrow('no longer active')
    expect(() => lifecycle.put(record, reopen, author, '30')).toThrow('active signed head')
  })

  it('enforces both the new expiry and the old head expiry and produces timer-only terminal events', () => {
    const record = active()
    const next = signed({
      revision: '1',
      previous: record.proposalId,
      issuedAt: '90',
      expiresAt: '190'
    })
    expect(() => lifecycle.put(record, next, author, '100')).toThrow('head has expired')
    expect(() => lifecycle.put(record, next, author, '190')).toThrow('has expired')
    expect(lifecycle.expire(record, '99').changed).toBe(false)
    const expired = lifecycle.expire(record, '100')
    expect(expired.next.state).toEqual({ status: 'expired', recordedAt: '100' })
    expect(expired.next.proposal).toEqual(record.proposal)
    expect(expired.events).toEqual([
      { kind: 'proposal-state', proposalId: record.proposalId, state: expired.next.state }
    ])
    expect(lifecycle.expire(expired.next, '101').changed).toBe(false)
    expect(() => lifecycle.put(expired.next, next, author, '101')).toThrow('no longer active')
  })

  it('reserves exact transaction bytes and a pending admission job before any external effect', () => {
    const record = active(),
      input = request(record.proposal)
    const reserved = lifecycle.reserve(record, author, input.request, input.raw, '11')
    expect(reserved.expectedToken).toBe(proposalRecordToken(record))
    expect(reserved.next.state).toEqual({
      status: 'finalizing',
      recordedAt: '11',
      operationId: input.request.operationId,
      txid: input.request.txid
    })
    expect(reserved.next.admission).toEqual({
      caller: author,
      operationId: input.request.operationId,
      txid: input.request.txid,
      rawTransaction: input.raw,
      beef: 'AA==',
      requestedAt: '11'
    })
    expect(reserved.events).toHaveLength(1)
    expect(reserved.events[0].kind).toBe('proposal-state')
    expect(record.state.status).toBe('active')
    expect(() => lifecycle.reserve(record, recipient, input.request, input.raw, '11')).toThrow(
      'authorize'
    )
    expect(() =>
      lifecycle.reserve(
        record,
        author,
        { ...input.request, proposalId: 'ff'.repeat(32) },
        input.raw,
        '11'
      )
    ).toThrow('current proposal')
    expect(() =>
      lifecycle.reserve(record, author, { ...input.request, service: 'other' }, input.raw, '11')
    ).toThrow('current proposal')
    expect(() => lifecycle.reserve(record, author, input.request, input.raw, '100')).toThrow(
      'expired'
    )
    expect(() =>
      lifecycle.reserve(record, author, { ...input.request, operationId: 'short' }, input.raw, '11')
    ).toThrow('request ID')
  })

  it('makes reservation and expiry mutually exclusive while updates and withdrawal cannot cancel reserved work', () => {
    const record = active(),
      input = request(record.proposal)
    const reservation = lifecycle.reserve(record, author, input.request, input.raw, '99')
    const expiry = lifecycle.expire(record, '100')
    expect(reservation.expectedToken).toBe(expiry.expectedToken)
    expect(lifecycle.expire(reservation.next, '101').changed).toBe(false)
    expect(() => lifecycle.reserve(expiry.next, author, input.request, input.raw, '101')).toThrow(
      'no longer active'
    )
    for (const operation of ['update', 'withdraw'] as const)
      expect(() =>
        lifecycle.put(
          reservation.next,
          signed({ revision: '1', previous: record.proposalId, operation }),
          author,
          '99'
        )
      ).toThrow('no longer active')
  })

  it('recovers the original reservation with alternative verified BEEF and prevents a second transaction', () => {
    const record = reserve(),
      input = request(record.proposal)
    const retry = lifecycle.reserve(
      record,
      author,
      { ...input.request, beef: 'AQ==' },
      input.raw,
      '101'
    )
    expect(retry.changed).toBe(false)
    expect(retry.next.admission?.beef).toBe('AA==')
    const different = finalize(record.proposal)
    different.lockTime++
    const alternateRaw = Utils.toBase64(different.toBinary())
    expect(() =>
      lifecycle.reserve(
        record,
        author,
        { ...input.request, txid: different.id('hex') },
        alternateRaw,
        '101'
      )
    ).toThrow('different bytes')
    const another = lifecycle.reserve(
      record,
      author,
      { ...input.request, operationId: 'another-operation-id', txid: different.id('hex') },
      alternateRaw,
      '101'
    )
    expect(another.changed).toBe(false)
    expect(another.next).toEqual(record)
  })

  it('preserves uncertainty and links an empty positive STEAK without treating it as rejection', () => {
    const record = reserve(),
      admitted = outcome(record)
    expect(lifecycle.complete(record, { ...admitted, status: 'unresolved' }, '12').changed).toBe(
      false
    )
    const result = lifecycle.complete(record, admitted, '12')
    expect(result.next.state).toEqual({
      status: 'finalized',
      recordedAt: '12',
      operationId: admitted.operationId,
      txid: admitted.txid,
      steak: {},
      assessmentContextId: 'verified-topic-context'
    })
    expect(result.next.proposal).toEqual(record.proposal)
    expect(result.next.admission).toEqual(record.admission)
    expect(lifecycle.expire(result.next, '500').changed).toBe(false)
    expect(
      lifecycle.complete(
        result.next,
        { ...admitted, status: 'rejected', reason: 'late stale callback' },
        '501'
      ).next
    ).toEqual(result.next)
    expect(() => lifecycle.complete(record, { ...admitted, txid: 'ff'.repeat(32) }, '12')).toThrow(
      'reserved operation'
    )
    expect(() =>
      lifecycle.complete(record, { ...admitted, operationId: 'other-operation-id' }, '12')
    ).toThrow('reserved operation')
    expect(() => lifecycle.complete(active(), admitted, '12')).toThrow('reserved operation')
  })

  it('records definitive local rejection as a terminal result with unknown global outcome', () => {
    const record = reserve(),
      admitted = outcome(record)
    const failed = lifecycle.complete(
      record,
      { ...admitted, status: 'rejected', reason: 'Configured topic declined' },
      '12'
    )
    expect(failed.next.state).toEqual({
      status: 'finalization-failed',
      recordedAt: '12',
      operationId: admitted.operationId,
      txid: admitted.txid,
      reason: 'Configured topic declined',
      globalOutcome: 'unknown'
    })
    expect(lifecycle.complete(failed.next, admitted, '13').changed).toBe(false)
    expect(() =>
      lifecycle.put(
        failed.next,
        signed({ revision: '1', previous: failed.next.proposalId }),
        author,
        '13'
      )
    ).toThrow('no longer active')
    const input = request(record.proposal)
    expect(lifecycle.reserve(failed.next, author, input.request, input.raw, '101').next).toEqual(
      failed.next
    )
  })

  it('validates complete local records and rejects corrupted or mismatched admission bindings', () => {
    const record = reserve()
    expect(lifecycle.parse(JSON.parse(JSON.stringify(record)))).toEqual(record)
    for (const change of [
      { version: 2 },
      { proposalId: 'ff'.repeat(32) },
      { extra: true },
      { state: { status: 'withdrawn', recordedAt: '11' }, admission: undefined },
      { admission: { ...record.admission, caller: recipient } },
      { admission: { ...record.admission, txid: 'ff'.repeat(32) } },
      { admission: { ...record.admission, operationId: 'different-operation' } },
      { admission: { ...record.admission, rawTransaction: 1 } },
      { admission: { ...record.admission, rawTransaction: 'AA==' } }
    ]) {
      const changed = JSON.parse(JSON.stringify({ ...record, ...change }))
      expect(() => lifecycle.parse(changed)).toThrow()
    }
    const { admission: _job, ...missing } = record
    expect(() => lifecycle.parse(missing)).toThrow('admission job differ')
    expect(() => lifecycle.parse({ ...active(), admission: record.admission })).toThrow(
      'admission job differ'
    )
    expect(
      () =>
        new ProposalTransitions(registry, scope, {
          maxLifetimeSeconds: '0',
          futureSkewSeconds: '0'
        })
    ).toThrow('positive')
  })
})
