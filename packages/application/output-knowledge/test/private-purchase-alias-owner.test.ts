import { PrivatePurchaseAccess } from '../src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../src/private/PrivatePurchaseDisclosure.js'
import { afterEach, expect, it, jest } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import { SQLitePrivatePurchaseAliasStore } from '../src/private/SQLitePrivatePurchaseAliasStore.js'
import { SQLiteProtectedLedger } from '../src/private/SQLiteProtectedLedger.js'
import { retained, verified } from './private-purchase-aliases.fixture.js'
import { purchaseAliasOwnerFixture } from './private-purchase-alias-owner.fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

it('prepares distinct core3 custody and keeps historical readers from opening it', () => {
  const f = purchaseAliasOwnerFixture(),
    saved = f.prepare()
  expect(saved.state.format).toBe('private-purchase-state/3')
  expect(saved.state.firstReservedAt).toBeNull()
  expect(saved.progress.status).toBe('prepared')
  expect(saved.aliases.state.original).toBeNull()
  expect(() => f.base.owner.store.load(f.base.id, f.base.buyer, f.f.clock, f.f.guard)).toThrow()
  expect(f.load(f.reopen().owner).custody).toEqual(saved.custody)
})

it('refuses an infeasible complete result before creating any payable preparation', () => {
  const f = purchaseAliasOwnerFixture(),
    owner = new SQLitePrivatePurchaseAliasStore(
      f.base.owner.domain,
      f.base.f.f.contracts,
      f.f.owner,
      { ...f.limits, maximumBatchBytes: 1048576 },
      f.base.policy,
      8
    )
  expect(() => owner.prepare(f.base.custody, f.f.clock, f.f.guard)).toThrow()
  expect(owner.load(f.base.id, f.base.buyer, f.f.clock, f.f.guard)).toBeUndefined()
  expect(f.f.read()).toBeUndefined()
})

it('commits first identity and native observation with the alias in one writer and leaves byte-identical retry inert', () => {
  const commit = jest.spyOn(SQLiteProtectedLedger.prototype, 'commitPrepared')
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  commit.mockClear()
  const candidate = f.f.variant(1),
    first = f.retain(candidate)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(first.state.firstReservedAt).toBe(f.f.clock())
  expect(first.aliases.state.original?.txid).toBe(candidate.txid)
  expect(first.progress.status).toBe('admission-pending')
  const revision = first.revision,
    updates = first.row.reservedUpdates
  const duplicate = f.retain(candidate)
  expect(duplicate.revision).toBe(revision)
  expect(duplicate.row.reservedUpdates).toBe(updates)
  expect(commit).toHaveBeenCalledTimes(1)
  commit.mockRestore()
})

it('refuses changed independent validation without advancing identity or core custody', () => {
  const f = purchaseAliasOwnerFixture(),
    before = f.prepare(),
    candidate = f.f.variant(2)
  const write = retained(
    f.f.owner.propose(
      f.base.custody.original,
      candidate,
      verified(),
      undefined,
      f.f.clock,
      f.f.guard
    )
  )
  expect(() =>
    f.store.retain(before, write, f.f.clock, f.f.guard, {
      ...verified(),
      checkCurrent: () => {
        throw Error('Changed independent domain')
      }
    })
  ).toThrow('Changed independent domain')
  const after = f.load()
  expect(after.revision).toBe(before.revision)
  expect(after.state.firstReservedAt).toBeNull()
  expect(after.aliases.state.original).toBeNull()
})

it('retains unknown jobs while selecting another alias and uses actual per-alias admission for progress', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const first = f.f.variant(3),
    selected = f.f.variant(4)
  f.retain(first)
  f.f.pending(first)
  f.retain(selected, true)
  f.admitted(selected)
  const saved = f.load()
  expect(saved.progress.txid).toBe(selected.txid)
  expect(saved.progress.status).toBe('admitted-delivery-pending')
  expect(saved.aliases.state.original?.txid).toBe(first.txid)
  expect(saved.aliases.state.pending.some(value => value?.txid === first.txid)).toBe(true)
  expect(saved.state.firstReservedAt).toBe('20')
})

it('preserves the first complete result across reopen and later selected aliases without issuing again', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const first = f.f.variant(5)
  f.retain(first)
  f.admitted(first)
  const admitted = f.load(),
    envelope = f.envelope(admitted)
  const complete = f.store.complete(admitted, envelope, undefined, f.f.clock, f.f.guard)
  expect(complete.progress.status).toBe('delivered')
  expect(complete.aliases.state.historical?.txid).toBe(first.txid)
  const reopened = f.reopen(),
    later = f.f.variant(6)
  const next = f.retain(later, true, reopened.owner, reopened.aliases)
  expect(next.progress.txid).toBe(first.txid)
  expect(next.aliases.state.selected?.txid).toBe(later.txid)
  expect(next.aliases.state.historical?.txid).toBe(first.txid)
  let disclosed: unknown
  reopened.owner.disclose(next, f.base.buyer, f.f.clock, f.f.guard, value => {
    disclosed = value
  })
  expect(canonicalOutputJSON(disclosed)).toBe(canonicalOutputJSON(envelope))
  expect(reopened.owner.complete(next, envelope, undefined, f.f.clock, f.f.guard).revision).toBe(
    next.revision
  )
  f.base.setPermitted(false)
  expect(() =>
    reopened.owner.disclose(next, f.base.buyer, f.f.clock, f.f.guard, () => {
      throw Error('Must not disclose')
    })
  ).toThrow('authority changed')
})

it('rolls back earlier alias writes when the final core row conflicts inside the actual writer', () => {
  const original = SQLiteProtectedLedger.prototype.commitPrepared
  let refuseFinalRow = false
  const commit = jest
    .spyOn(SQLiteProtectedLedger.prototype, 'commitPrepared')
    .mockImplementation(function (
      this: SQLiteProtectedLedger,
      revision,
      prepare,
      clock,
      guard,
      options
    ) {
      return original.call(
        this,
        revision,
        view => {
          const changes = prepare(view)
          if (!refuseFinalRow) return changes
          expect(changes.length).toBeGreaterThan(1)
          return changes.map((change, index) =>
            index === changes.length - 1 ? { ...change, expectedRevision: '999999' } : change
          )
        },
        clock,
        guard,
        options
      )
    })
  const f = purchaseAliasOwnerFixture(),
    before = f.prepare(),
    aliases = f.f.read()
  commit.mockClear()
  refuseFinalRow = true
  expect(() => f.retain(f.f.variant(7))).toThrow('Protected record changed before commit')
  expect(commit).toHaveBeenCalledTimes(1)
  const after = f.load()
  expect(after.revision).toBe(before.revision)
  expect(after.row).toEqual(before.row)
  expect(after.state.firstReservedAt).toBeNull()
  expect(after.aliases.state.original).toBeNull()
  expect(f.f.read()).toEqual(aliases)
})

it('requires explicit state3 access and checks recipient custody before application permission', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const policy = jest.fn(() => true)
  const old = new PrivatePurchaseAccess(
    f.base.owner.domain,
    f.base.custody.original.request.topic,
    policy,
    'full-purchase-commitment-v1'
  )
  const installed = new PrivatePurchaseAccess(
    f.base.owner.domain,
    f.base.custody.original.request.topic,
    policy,
    'full-purchase-commitment-v1',
    'alias-custody-v1'
  )
  expect(() =>
    f.store.load(
      f.base.id,
      f.base.buyer,
      f.f.clock,
      old.guard(f.base.id, f.base.buyer, () => true)
    )
  ).toThrow('Purchase access state differs')
  expect(policy).not.toHaveBeenCalled()
  expect(
    f.store.load(
      f.base.id,
      f.base.buyer,
      f.f.clock,
      installed.guard(f.base.id, f.base.buyer, () => true)
    )?.state.format
  ).toBe('private-purchase-state/3')
  expect(policy).toHaveBeenCalled()
  expect(
    () =>
      new PrivatePurchaseAccess(
        f.base.owner.domain,
        f.base.custody.original.request.topic,
        policy,
        undefined,
        'alias-custody-v1'
      )
  ).toThrow('Unsupported purchase access owner profile')
})

it('reuses physical HTTP disclosure with the alias owner and refuses changed permission before enqueue', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  let permitted = true
  const access = new PrivatePurchaseAccess(
    f.base.owner.domain,
    f.base.custody.original.request.topic,
    () => permitted,
    'full-purchase-commitment-v1',
    'alias-custody-v1'
  )
  const disclosure = new PrivatePurchaseDisclosure(
    f.base.owner.domain,
    f.store,
    f.base.f.f.contracts,
    access,
    f.f.clock,
    () => permitted
  )
  const selected = f.base.f.f.contracts.restore(f.base.custody.original.capability)
  const caller = {
    buyer: f.base.buyer,
    capability: selected.digest,
    profile: selected.profile.id,
    current: () => true,
    signal: new AbortController().signal
  }
  const response = disclosure.prepare(f.base.id, caller, { terms: true })
  expect(canonicalOutputJSON(JSON.parse(response.body))).toBe(
    canonicalOutputJSON(f.base.custody.original.terms)
  )
  const send = jest.fn((_body: string, _headers: Readonly<Record<string, string>>) => undefined)
  permitted = false
  expect(() => response.enqueue(send)).toThrow('Purchase not found')
  expect(send).not.toHaveBeenCalled()
  permitted = true
  const first = f.f.variant(8)
  f.retain(first)
  f.admitted(first)
  const admitted = f.load(),
    envelope = f.envelope(admitted)
  f.store.complete(admitted, envelope, undefined, f.f.clock, f.f.guard)
  const delivered = disclosure.prepare(f.base.id, caller)
  delivered.enqueue(send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(canonicalOutputJSON(JSON.parse(send.mock.calls[0][0]))).toBe(canonicalOutputJSON(envelope))
  expect(() => delivered.enqueue(send)).toThrow('already attempted')
})

it('keeps mutable currentAlias reports outside the immutable first signed result', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const candidate = f.f.variant(9)
  f.retain(candidate)
  f.admitted(candidate)
  const admitted = f.load(),
    envelope = f.envelope(admitted)
  expect(() =>
    f.store.complete(
      admitted,
      {
        ...envelope,
        currentAlias: { txid: candidate.txid, beef: candidate.beef }
      },
      undefined,
      f.f.clock,
      f.f.guard
    )
  ).toThrow('cannot retain a currentness report')
  expect(f.load().state.result.digest).toBeNull()
  expect(f.load().progress.status).toBe('admitted-delivery-pending')
})

it('retains a terminal local delivery failure and complete exact candidate independently of alias cache turnover', () => {
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const paid = f.f.variant(20)
  f.retain(paid)
  const pending = f.load()
  expect(() =>
    f.store.fail(
      pending,
      { reason: 'Irrecoverable material', evidence: 'AA==' },
      f.f.clock,
      f.f.guard
    )
  ).toThrow('lacks actual admitted')
  expect(f.load().revision).toBe(pending.revision)
  f.admitted(paid)
  const failed = f.store.fail(
    f.load(),
    { reason: 'Irrecoverable material', evidence: 'AA==' },
    f.f.clock,
    f.f.guard
  )
  expect(failed.progress.status).toBe('delivery-failed')
  expect(failed.progress.decision?.globalOutcome).toBe('unknown')
  expect(failed.aliases.state.historical).toBeNull()
  expect(failed.candidate).toEqual(paid)
  expect(failed.state.result.digest).not.toBeNull()
  const reopened = f.reopen()
  for (let n = 21; n <= 25; n++) f.retain(f.f.variant(n), false, reopened.owner, reopened.aliases)
  const retained = f.load(reopened.owner)
  expect(retained.progress).toEqual(failed.progress)
  expect(retained.state.selectedTxid).toBe(paid.txid)
  expect(retained.candidate).toEqual(paid)
  let disclosed: unknown
  reopened.owner.disclose(retained, f.base.buyer, f.f.clock, f.f.guard, value => {
    disclosed = value
  })
  expect(disclosed).toMatchObject({
    result: {
      status: 'delivery-failed',
      txid: paid.txid,
      steak: failed.progress.admission!.steak,
      decision: failed.progress.decision
    }
  })
  expect(Object.hasOwn(disclosed as object, 'releaseEvidence')).toBe(false)
  expect(Object.hasOwn((disclosed as { result: object }).result, 'potatoes')).toBe(false)
  const again = reopened.owner.fail(
    retained,
    { reason: 'Irrecoverable material', evidence: 'AA==' },
    f.f.clock,
    f.f.guard
  )
  expect(again.revision).toBe(retained.revision)
  expect(() =>
    reopened.owner.fail(
      again,
      { reason: 'A changed terminal decision', evidence: 'AA==' },
      f.f.clock,
      f.f.guard
    )
  ).toThrow('immutable')
  expect(() =>
    reopened.owner.complete(again, f.envelope(again), undefined, f.f.clock, f.f.guard)
  ).toThrow('lacks actual admitted')
})

it('rolls back every failure-result slot when its final reserved row conflicts in the same native writer', () => {
  const original = SQLiteProtectedLedger.prototype.commitPrepared
  let refuse = false
  const commit = jest
    .spyOn(SQLiteProtectedLedger.prototype, 'commitPrepared')
    .mockImplementation(function (
      this: SQLiteProtectedLedger,
      revision,
      prepare,
      clock,
      guard,
      options
    ) {
      return original.call(
        this,
        revision,
        view => {
          const changes = prepare(view)
          return refuse
            ? changes.map((change, index) =>
                index === changes.length - 1 ? { ...change, expectedRevision: '999999' } : change
              )
            : changes
        },
        clock,
        guard,
        options
      )
    })
  const f = purchaseAliasOwnerFixture()
  f.prepare()
  const paid = f.f.variant(26)
  f.retain(paid)
  f.admitted(paid)
  const before = f.load()
  commit.mockClear()
  refuse = true
  expect(() =>
    f.store.fail(
      before,
      { reason: 'Irrecoverable material', evidence: 'AA==' },
      f.f.clock,
      f.f.guard
    )
  ).toThrow('Protected record changed before commit')
  expect(commit).toHaveBeenCalledTimes(1)
  const after = f.load()
  expect(after.revision).toBe(before.revision)
  expect(after.row).toEqual(before.row)
  expect(after.state.result).toEqual(before.state.result)
  expect(after.progress.status).toBe('admitted-delivery-pending')
  expect(after.aliases.state.historical).toBeNull()
})
