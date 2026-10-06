import { expect, jest, test } from '@jest/globals'
import { Beef, decodeOutputBytes, ownOutputJSON } from '@bsv/sdk'
import { SQLitePrivatePurchaseAliases } from '../src/private/SQLitePrivatePurchaseAliases.js'
import { privatePurchaseOperation } from '../src/private/PrivatePurchaseProgress.js'
import { purchaseEvidenceFixture } from './private-purchase-evidence.fixture.js'
import type { ProtectedLedgerChange } from '../src/private/ProtectedLedgerCodec.js'
import {
  identity,
  verified,
  placement,
  retained,
  purchaseAliasesFixture as fixture
} from './private-purchase-aliases.fixture.js'

// Storage-only unit oracles; no BRC197 Script/chain/issuance qualification.
test('native alias custody requires complete prior reservations and preserves them after reopen', () => {
  const f = fixture()
  expect(() => f.read()).toThrow('missing')
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  expect(f.read().state.original).toBeNull()
  f.put(f.e.candidate)
  f.e.base.close(f.e.base.owner.domain)
  const reopened = f.reopen()
  expect(f.read(reopened).candidates.get('original')).toEqual(f.e.candidate)
  const changed = new SQLitePrivatePurchaseAliases(f.e.base.open().domain, f.e.base.f.f.contracts, {
    ...f.limits,
    maximumUnconfirmed: 2
  })
  expect(() => changed.reserve(f.e.original, f.clock, f.guard)).toThrow()
})

test('native alias proof union retains shared rows while original bytes stay immutable', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  const plan = retained(
    f.owner.propose(f.e.original, f.e.alternate, verified(), undefined, f.clock, f.guard)
  )
  const merged = Beef.fromBinaryStrict(decodeOutputBytes(plan.candidate!.beef, 8192))
  expect(merged.txs).toHaveLength(3)
  expect(merged.findTxid(f.e.candidate.txid)!.tx!.toHex()).toBe(f.e.target.toHex())
  expect(() => plan.retain(f.clock, f.guard)).toThrow('validation')
  plan.retain(f.clock, f.guard, verified())
  const saved = f.read(f.reopen())
  expect(saved.candidates.get('original')).toEqual(f.e.candidate)
  expect(saved.candidates.get('unconfirmed/0')).toEqual(plan.candidate)
  saved.state.original!.txid = 'ff'.repeat(32)
  saved.candidates.get('unconfirmed/0')!.beef = 'AA=='
  expect(f.read().candidates.get('unconfirmed/0')).toEqual(plan.candidate)
})

test('native cache turnover and selected alias replacement preserve every unresolved exact job', () => {
  const f = fixture(),
    cached = f.variant(10),
    a = f.variant(11),
    b = f.variant(12),
    c = f.variant(13)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.put(cached)
  f.pending(cached)
  f.put(a, true)
  f.pending(a)
  f.put(b, true)
  f.pending(b)
  f.put(c, true)
  f.pending(c)
  const saved = f.read(f.reopen())
  expect(saved.state.pending.map(x => x?.txid)).toEqual([a.txid, b.txid])
  expect(saved.state.selected?.txid).toBe(c.txid)
  expect(saved.state.unconfirmed[0]?.txid).toBe(cached.txid)
  for (const [role, candidate] of [
    ['pending/0', a],
    ['pending/1', b],
    ['selected', c],
    ['unconfirmed/0', cached]
  ] as const) {
    expect(saved.candidates.get(role)).toEqual(candidate)
    expect(saved.state.purchaseCommitment).toBe(identity)
    expect(saved.outcomes.has(role)).toBe(false)
  }
  expect(
    f.owner.propose(f.e.original, f.variant(14), verified(), placement(), f.clock, f.guard)
  ).toEqual({ status: 'pending', reason: 'external-operations-unresolved' })
  expect(f.read().state).toEqual(saved.state)
})

test('native alias proposals reject changed combined identity, stale CAS and mutated returned candidate', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  const a = retained(
      f.owner.propose(f.e.original, f.e.candidate, verified(), undefined, f.clock, f.guard)
    ),
    b = retained(
      f.reopen().propose(f.e.original, f.variant(21), verified(), undefined, f.clock, f.guard)
    )
  expect(() =>
    a.retain(f.clock, f.guard, { ...verified(), purchaseCommitment: 'f1'.repeat(32) })
  ).toThrow()
  a.retain(f.clock, f.guard, verified())
  expect(() => b.retain(f.clock, f.guard, verified())).toThrow()
  const changed = retained(
    f.owner.propose(f.e.original, f.e.alternate, verified(), undefined, f.clock, f.guard)
  )
  changed.candidate!.beef = 'AA=='
  expect(() => changed.retain(f.clock, f.guard, verified())).toThrow()
  expect(f.read().state.original?.txid).toBe(f.e.candidate.txid)
})

test('native historical copy and independent result-owner marker commit atomically and cannot be rewritten', () => {
  const f = fixture(),
    alias = f.variant(30)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.admit(f.e.candidate)
  f.put(alias, true)
  f.admit(alias)
  const address = f.e.base.owner.domain.identity.address('delivery', {
      purpose: 'alias-result-unit-marker'
    }),
    result: ProtectedLedgerChange = {
      ...address,
      expectedRevision: null,
      reservedBytes: 1024,
      reservedUpdates: 0,
      value: { purpose: 'storage-only-first-result-marker', txid: alias.txid }
    }
  const plan = retained(
    f.owner.release(f.e.original, alias.txid, placement(), [result], f.clock, f.guard)
  )
  expect(() =>
    plan.retain(f.clock, () => {
      throw Error('Authority withdrawn')
    })
  ).toThrow('Authority withdrawn')
  expect(f.read().state.historical).toBeNull()
  expect(f.e.base.owner.domain.ledger.read([address], f.clock, f.guard).records[0]).toBeUndefined()
  plan.retain(f.clock, f.guard)
  const saved = f.read(f.reopen())
  expect(saved.state.original?.txid).toBe(f.e.candidate.txid)
  expect(saved.state.historical?.txid).toBe(alias.txid)
  expect(saved.candidates.get('historical')).toEqual(alias)
  expect(
    f.e.base.owner.domain.ledger.read([address], f.clock, f.guard).records[0]?.value.txid
  ).toBe(alias.txid)
  expect(() =>
    f.owner.release(f.e.original, alias.txid, undefined, [result], f.clock, f.guard)
  ).toThrow('cannot rewrite')
  expect(() =>
    f.owner.release(f.e.original, f.e.candidate.txid, undefined, [], f.clock, f.guard)
  ).toThrow('immutable')
  retained(f.owner.release(f.e.original, alias.txid, undefined, [], f.clock, f.guard)).retain(
    f.clock,
    f.guard
  )
  expect(f.read().state.historical).toEqual(saved.state.historical)
})

test('lost native alias replies retain the exact committed transaction and do not repeat financial work', () => {
  const f = fixture(),
    commit = f.e.base.owner.domain.ledger.commitPrepared.bind(f.e.base.owner.domain.ledger)
  let lose = false
  jest.spyOn(f.e.base.owner.domain.ledger, 'commitPrepared').mockImplementation((...args) => {
    const result = commit(...args)
    if (lose) {
      lose = false
      throw Error('Lost alias native reply')
    }
    return result
  })
  const owner = f.construct()
  owner.reserve(f.e.original, f.clock, f.guard)
  lose = true
  expect(() => f.put(f.e.candidate, false, owner)).toThrow('Lost alias native reply')
  const reopened = f.reopen()
  expect(f.read(reopened).candidates.get('original')).toEqual(f.e.candidate)
  f.put(f.e.candidate, false, reopened)
  expect(f.read(reopened).candidates.get('original')).toEqual(f.e.candidate)
})

test('alias custody refuses insufficient initial completion capacity and late asynchronous or changed validation', () => {
  const e = purchaseEvidenceFixture()
  expect(
    () =>
      new SQLitePrivatePurchaseAliases(e.base.owner.domain, e.base.f.f.contracts, {
        maximumCandidateBytes: 8192,
        maximumUnconfirmed: 1,
        maximumPending: 2,
        maximumWrites: 3,
        maximumBatchBytes: 2 * 1048576
      })
  ).toThrow('first promised release')
  const f = fixture(),
    validation = verified()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  const plan = retained(
    f.owner.propose(f.e.original, f.e.candidate, validation, undefined, f.clock, f.guard)
  )
  validation.checkCurrent = () => {
    throw Error('New guard')
  }
  expect(() => plan.retain(f.clock, f.guard, verified())).toThrow('guard changed')
  expect(f.read().state.original).toBeNull()
  expect(() => f.owner.reserve(f.e.original, f.clock, async () => undefined)).toThrow('synchronous')
})

test('keeps the retained terminal exact-job decision after a late unresolved reply', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.admit(f.e.candidate)
  const admitted = f.read().outcomes.get('original')!
  const ledger = f.e.base.owner.domain.ledger
  const probe = f.e.base.owner.domain.identity.address('delivery', {
    purpose: 'alias-no-write-probe'
  })
  const revision = ledger.read([probe], f.clock, f.guard).revision
  retained(f.owner.admission(f.e.original, f.e.candidate.txid, undefined, f.clock, f.guard)).retain(
    f.clock,
    f.guard
  )
  retained(
    f.owner.admission(
      f.e.original,
      f.e.candidate.txid,
      {
        status: 'unresolved',
        operationId: admitted.operationId,
        txid: admitted.txid
      },
      f.clock,
      f.guard
    )
  ).retain(f.clock, f.guard)
  expect(ledger.read([probe], f.clock, f.guard).revision).toBe(revision)
  expect(f.read().outcomes.get('original')).toEqual(admitted)
  expect(() =>
    f.owner.admission(
      f.e.original,
      f.e.candidate.txid,
      {
        status: 'rejected',
        operationId: admitted.operationId,
        txid: admitted.txid,
        reason: 'rejected',
        evidence: ''
      },
      f.clock,
      f.guard
    )
  ).toThrow()
  expect(f.read().outcomes.get('original')).toEqual(admitted)
})

test('joins owned alias and result contributions inside one actual native writer without nesting', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.admit(f.e.candidate)
  const ledger = f.e.base.owner.domain.ledger
  const address = f.e.base.owner.domain.identity.address('delivery', {
    purpose: 'alias-joined-result-marker'
  })
  const marker: ProtectedLedgerChange = {
    ...address,
    expectedRevision: null,
    reservedBytes: 1024,
    reservedUpdates: 0,
    value: { purpose: 'storage-only-joined-marker', txid: f.e.candidate.txid }
  }
  const plan = retained(
    f.owner.release(f.e.original, f.e.candidate.txid, undefined, [marker], f.clock, f.guard)
  )
  const prepared = plan.prepare(f.guard)
  ledger.commitPrepared(
    prepared.revision,
    view => {
      expect(f.owner.inspect(f.e.original, view, f.guard).state.historical).toBeNull()
      return prepared.changes(view)
    },
    f.clock,
    prepared.checkCurrent,
    { maximumBatchBytes: f.limits.maximumBatchBytes }
  )
  expect(f.read(f.reopen()).state.historical?.txid).toBe(f.e.candidate.txid)
  expect(ledger.read([address], f.clock, f.guard).records[0]?.value.txid).toBe(f.e.candidate.txid)
})

test('refuses a changed public plan method or owned contribution before any native alias effect', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  const plan = retained(
    f.owner.propose(f.e.original, f.e.candidate, verified(), undefined, f.clock, f.guard)
  )
  const prepared = plan.prepare(f.guard, verified())
  const probe = f.e.base.owner.domain.identity.address('delivery', {
    purpose: 'alias-immutable-contribution-probe'
  })
  f.e.base.owner.domain.ledger.read([probe], f.clock, view => {
    const changes = prepared.changes(view)
    expect(Object.isFrozen(changes)).toBe(true)
    expect(Object.isFrozen(changes[0])).toBe(true)
    expect(Object.isFrozen(changes[0].value)).toBe(true)
    expect(() => {
      changes[0].value = { changed: true }
    }).toThrow()
  })
  expect(f.read().state.original).toBeNull()
  plan.prepare = () => {
    throw Error('Replacement prepare must not run')
  }
  expect(() => plan.retain(f.clock, f.guard, verified())).toThrow('proposal method changed')
  expect(f.read().state.original).toBeNull()
})

test('retains a rejected exact-job time from the committing native view, not the earlier read', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.pending(f.e.candidate)
  let now = '20'
  const clock = () => now
  const rejected = {
    status: 'rejected' as const,
    operationId: privatePurchaseOperation(f.e.original, f.e.candidate.txid),
    txid: f.e.candidate.txid,
    reason: 'local-test-rejection',
    evidence: ''
  }
  const plan = retained(f.owner.admission(f.e.original, rejected.txid, rejected, clock, f.guard))
  now = '21'
  plan.retain(clock, f.guard)
  const saved = f.owner.read(f.e.original, clock, f.guard)
  expect(saved.outcomes.get('original')).toEqual(rejected)
  expect(saved.completedAt.get('original')).toBe('21')
  retained(f.owner.admission(f.e.original, rejected.txid, undefined, clock, f.guard)).retain(
    clock,
    f.guard
  )
  expect(f.owner.read(f.e.original, clock, f.guard).completedAt.get('original')).toBe('21')
})

test('minimum prepaid revisions still complete the first exact-job release after reopen', () => {
  const f = fixture(4)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  const owner = f.reopen()
  f.pending(f.e.candidate, owner)
  f.admit(f.e.candidate, owner)
  const address = f.e.base.owner.domain.identity.address('delivery', {
    purpose: 'alias-minimum-budget-result'
  })
  const result: ProtectedLedgerChange = {
    ...address,
    expectedRevision: null,
    reservedBytes: 1024,
    reservedUpdates: 0,
    value: { purpose: 'storage-only-minimum-budget', txid: f.e.candidate.txid }
  }
  retained(
    owner.release(f.e.original, f.e.candidate.txid, undefined, [result], f.clock, f.guard)
  ).retain(f.clock, f.guard)
  expect(f.read(f.reopen()).state.historical?.txid).toBe(f.e.candidate.txid)
  expect(
    f.e.base.owner.domain.ledger.read([address], f.clock, f.guard).records[0]?.value.txid
  ).toBe(f.e.candidate.txid)
})

test('optional cache work cannot consume prepaid completion capacity for unfinished jobs', () => {
  const f = fixture(4),
    other = f.variant(44)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  expect(() => f.put(other)).toThrow('completion revisions')
  expect(f.read().state.unconfirmed).toEqual([null])
  f.admit(f.e.candidate)
  expect(f.read(f.reopen()).state.original?.admission).toBe('admitted')
})

test('the same exact job cannot restore divergent terminal evidence in different alias roles', () => {
  const f = fixture()
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate, true)
  f.admit(f.e.candidate)
  const domain = f.e.base.owner.domain,
    ledger = domain.ledger
  const address = domain.identity.address('candidate', {
    purpose: 'private-purchase-alias-slots/1',
    acquisitionId: f.e.original.terms.body.acquisitionId,
    role: 'selected',
    index: 0
  })
  const read = ledger.read([address], f.clock, f.guard),
    row = read.records[0]!
  const value = structuredClone(row.value)
  value.outcome = ownOutputJSON({
    ...f.read().outcomes.get('selected')!,
    assessmentContextId: 'different-view'
  }).value
  ledger.commit(
    read.revision,
    [
      {
        ...address,
        expectedRevision: row.revision,
        reservedBytes: row.reservedBytes,
        reservedUpdates: row.reservedUpdates - 1,
        value
      }
    ],
    f.clock,
    f.guard
  )
  expect(() => f.read(f.reopen())).toThrow('repeated exact outcome differs')
})

test('alias composition refuses another physical domain or changed installation methods', () => {
  const f = fixture()
  const second = purchaseEvidenceFixture()
  expect(() => f.owner.installedOn(second.base.owner.domain, f.e.base.f.f.contracts)).toThrow(
    'purchase installation'
  )
  f.owner.reserve(f.e.original, f.clock, f.guard)
  const originalMethod = f.e.base.owner.domain.ledger.commitPrepared
  f.e.base.owner.domain.ledger.commitPrepared = () => {
    throw Error('Replacement must not run')
  }
  expect(() => f.read()).toThrow('installation changed')
  f.e.base.owner.domain.ledger.commitPrepared = originalMethod
  expect(f.read().state.original).toBeNull()
})

test('byte-identical original recovery needs no optional cache slot even when every cache job is pending', () => {
  const f = fixture(),
    cached = f.variant(57)
  f.owner.reserve(f.e.original, f.clock, f.guard)
  f.put(f.e.candidate)
  f.put(cached)
  f.pending(cached)
  const before = f.read(),
    domain = f.e.base.owner.domain
  const probe = domain.identity.address('delivery', { purpose: 'alias-original-recovery-no-write' })
  const revision = domain.ledger.read([probe], f.clock, f.guard).revision
  f.put(f.e.candidate)
  expect(domain.ledger.read([probe], f.clock, f.guard).revision).toBe(revision)
  expect(f.read(f.reopen()).state).toEqual(before.state)
  expect(f.read().state.unconfirmed[0]?.txid).toBe(cached.txid)
  expect(f.read().state.unconfirmed[0]?.admission).toBe('pending')
})
