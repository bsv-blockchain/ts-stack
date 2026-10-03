import { expect, it, jest } from '@jest/globals'
import { readFileSync, unlinkSync } from 'node:fs'
import { PrivateKey, signOutputPacket } from '@bsv/sdk'
import { SQLitePrivatePurchaseStore } from '../src/private/SQLitePrivatePurchaseStore.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

it('reserves original material and every completion slot, then recovers the exact delivered result after native reopen', () => {
  const f = purchaseStoreFixture(),
    delivered = f.deliver()
  expect(delivered.progress.status).toBe('delivered')
  expect(delivered.row.reservedUpdates).toBe(0)
  f.close(f.owner.domain)
  const reopened = f.open(),
    loaded = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(loaded.candidate).toEqual(f.candidate)
  expect(loaded.custody).toEqual(f.custody)
  const send = jest.fn((_envelope: unknown) => {})
  reopened.store.disclose(loaded, f.buyer, f.clock, f.guard, send)
  expect(send).toHaveBeenCalledWith(f.f.envelope())
  expect(readFileSync(f.path).includes(Buffer.from('public-test-secret'))).toBe(false)
  expect(readFileSync(f.path).includes(Buffer.from(f.buyer))).toBe(false)
})

it('returns the first preparation and refuses another body for its permanent request ID', () => {
  const f = purchaseStoreFixture(),
    original = f.prepare()
  f.setNow('200')
  expect(f.prepare().custody).toEqual(original.custody)
  const request = { ...f.f.original.request, request: 'AQ==' },
    prepared = f.f.f.contracts.prepare(request, f.f.f.manifest(), f.f.f.terms, '20'),
    changed = {
      ...f.custody,
      original: f.f.f.contracts.authenticate(
        prepared,
        signOutputPacket('purchase-terms', prepared.body, f.f.f.key)
      )
    }
  expect(() => f.owner.store.prepare(changed, f.clock, f.guard)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
  expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!.custody).toEqual(original.custody)
})

it('retains the admission intent after a lost native commit reply and accepts only its original transaction', () => {
  const f = purchaseStoreFixture(),
    prepared = f.prepare(),
    commit = f.owner.domain.ledger.commit.bind(f.owner.domain.ledger)
  f.setNow('29')
  jest.spyOn(f.owner.domain.ledger, 'commit').mockImplementationOnce((...args) => {
    commit(...args)
    throw new Error('Lost admission-intent reply')
  })
  expect(() =>
    f.owner.store.pin(f.id, f.buyer, prepared.row.revision, f.candidate, f.clock, f.guard)
  ).toThrow('Lost admission-intent reply')
  const retained = f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(retained.progress.status).toBe('admission-pending')
  expect(
    f.owner.store.pin(
      f.id,
      f.buyer,
      retained.row.revision,
      { ...f.candidate, beef: 'AQ==' },
      f.clock,
      f.guard
    ).candidate
  ).toEqual(f.candidate)
  expect(() =>
    f.owner.store.pin(
      f.id,
      f.buyer,
      retained.row.revision,
      { ...f.candidate, txid: '66'.repeat(32) },
      f.clock,
      f.guard
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it('retains an exact signed result after a lost native delivery reply without replacing it', () => {
  const f = purchaseStoreFixture(),
    admitted = f.admit(),
    commit = f.owner.domain.ledger.commit.bind(f.owner.domain.ledger)
  f.setNow('33')
  jest.spyOn(f.owner.domain.ledger, 'commit').mockImplementationOnce((...args) => {
    commit(...args)
    throw new Error('Lost delivery reply')
  })
  expect(() =>
    f.owner.store.complete(f.id, f.buyer, admitted.row.revision, f.f.envelope(), f.clock, f.guard)
  ).toThrow('Lost delivery reply')
  const retained = f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(
    f.owner.store.complete(f.id, f.buyer, retained.row.revision, f.f.envelope(), f.clock, f.guard)
      .progress.status
  ).toBe('delivered')
  const replacement = f.f.envelope()
  if (replacement.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  replacement.result.potatoes = signOutputPacket(
    'potatoes',
    { ...replacement.result.potatoes.body, secret: 'AQ==' },
    f.f.f.key
  )
  expect(() =>
    f.owner.store.complete(f.id, f.buyer, retained.row.revision, replacement, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it('authorizes the current recipient at native disclosure and refuses stale snapshots', () => {
  const f = purchaseStoreFixture(),
    prepared = f.prepare(),
    send = jest.fn((_envelope: unknown) => {})
  expect(
    f.owner.store.load(f.id, new PrivateKey(45).toPublicKey().toString(), f.clock, f.guard)
  ).toBeUndefined()
  expect(() =>
    f.owner.store.disclose(
      prepared,
      new PrivateKey(45).toPublicKey().toString(),
      f.clock,
      f.guard,
      send
    )
  ).toThrow(expect.objectContaining({ code: 'not-found' }))
  f.setPermitted(false)
  expect(() => f.owner.store.disclose(prepared, f.buyer, f.clock, f.guard, send)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  f.setPermitted(true)
  f.pin()
  expect(() => f.owner.store.disclose(prepared, f.buyer, f.clock, f.guard, send)).toThrow()
  expect(send).not.toHaveBeenCalled()
})

it('rejects insufficient future result capacity before retaining a payable preparation', () => {
  const f = purchaseStoreFixture({ maximumResultBytes: 8192 })
  expect(() => f.prepare()).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(
    f.owner.domain.ledger.enumerate('acquisition', null, 64, f.clock, f.guard).entries
  ).toEqual([])
})

it('expires only unpinned preparations and preserves retained STEAK after delivery failure', () => {
  const f = purchaseStoreFixture(),
    prepared = f.prepare()
  f.setNow('86500')
  const expired = f.owner.store.advance(
    f.id,
    f.buyer,
    prepared.row.revision,
    { type: 'expire' },
    f.clock,
    f.guard
  )
  expect(expired.progress.status).toBe('expired')
  expect(expired.row.reservedUpdates).toBe(2)
  expect(() =>
    f.owner.store.pin(f.id, f.buyer, expired.row.revision, f.candidate, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'expired' }))
  const other = purchaseStoreFixture(),
    admitted = other.admit()
  other.setNow('32')
  const failed = other.owner.store.advance(
    other.id,
    other.buyer,
    admitted.row.revision,
    { type: 'delivery-failed', reason: 'Protected material is unavailable', evidence: 'AA==' },
    other.clock,
    other.guard
  )
  const send = jest.fn((_envelope: unknown) => {})
  other.owner.store.disclose(failed, other.buyer, other.clock, other.guard, send)
  expect(send.mock.calls[0][0]).toMatchObject({
    result: {
      status: 'delivery-failed',
      steak: other.f.steak,
      decision: { globalOutcome: 'unknown' }
    }
  })
})

it('refuses missing original storage, changed validation policy and asynchronous authority', () => {
  const f = purchaseStoreFixture(),
    prepared = f.prepare()
  expect(() =>
    new SQLitePrivatePurchaseStore(f.owner.domain, f.f.f.contracts, f.limits, {
      id: f.policy.id,
      digest: '88'.repeat(32)
    }).load(f.id, f.buyer, f.clock, f.guard)
  ).toThrow(expect.objectContaining({ code: 'context-changed' }))
  expect(() => f.owner.store.load(f.id, f.buyer, f.clock, async () => {})).toThrow()
  expect(() =>
    f.owner.store.disclose(prepared, f.buyer, f.clock, f.guard, async () => {})
  ).toThrow()
  f.close(f.owner.domain)
  unlinkSync(f.path)
  expect(() => f.open()).toThrow()
})

it('never recreates an original preparation from a surviving permanent request fence', () => {
  const f = purchaseStoreFixture(),
    address = f.owner.domain.identity.address('request-fence', {
      purpose: 'private-purchase-request',
      acquisitionId: f.id
    }),
    read = f.owner.domain.ledger.read([address], f.clock, f.guard)
  f.owner.domain.ledger.commit(
    read.revision,
    [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: 1024,
        reservedUpdates: 0,
        value: {
          format: 'private-purchase-fence/1',
          acquisitionId: f.id,
          requestDigest: f.custody.original.terms.body.requestDigest,
          recipient: f.buyer
        }
      }
    ],
    f.clock,
    f.guard
  )
  expect(f.owner.store.load(f.id, f.buyer, f.clock, f.guard)).toBeUndefined()
  expect(() => f.prepare()).toThrow(expect.objectContaining({ code: 'unavailable' }))
  expect(
    f.owner.domain.ledger.enumerate('acquisition', null, 64, f.clock, f.guard).entries
  ).toEqual([])
})

it('retains pinned obligations after recovery deadline without consuming another revision', () => {
  const f = purchaseStoreFixture(),
    pinned = f.pin()
  f.setNow('999999')
  const retained = f.owner.store.advance(
    f.id,
    f.buyer,
    pinned.row.revision,
    { type: 'expire' },
    f.clock,
    f.guard
  )
  expect(retained.state).toEqual(pinned.state)
  expect(retained.row.revision).toBe(pinned.row.revision)
})

it('rejects altered local disclosure snapshots before invoking the result enqueue', () => {
  const f = purchaseStoreFixture(),
    loaded = f.prepare(),
    send = jest.fn((_value: unknown) => {})
  loaded.row.key = '00'.repeat(32)
  expect(() => f.owner.store.disclose(loaded, f.buyer, f.clock, f.guard, send)).toThrow(
    expect.objectContaining({ code: 'not-found' })
  )
  expect(send).not.toHaveBeenCalled()
})

it('drains rejected promises returned by wrongly declared synchronous native ports', async () => {
  const f = purchaseStoreFixture(),
    loaded = f.prepare(),
    guard = jest.fn(() => Promise.reject(new Error('Async native policy')))
  expect(() => f.owner.store.load(f.id, f.buyer, f.clock, guard as never)).toThrow(
    'must finish synchronously'
  )
  expect(() =>
    f.owner.store.disclose(loaded, f.buyer, f.clock, f.guard, (() =>
      Promise.reject(new Error('Async native enqueue'))) as never)
  ).toThrow('must finish synchronously')
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(guard).toHaveBeenCalledTimes(1)
})

it('enqueues only the original protected signed preparation before its current exclusive cutoff', () => {
  const f = purchaseStoreFixture(),
    prepared = f.prepare(),
    send = jest.fn((_value: unknown) => {})
  const original = structuredClone(prepared.custody.original.terms)
  prepared.custody.original.terms.body.purchaseUntil = '999999'
  f.owner.store.discloseTerms(prepared, f.buyer, f.clock, f.guard, send)
  expect(send).toHaveBeenCalledWith(original)
  f.setNow('100')
  expect(() => f.owner.store.discloseTerms(prepared, f.buyer, f.clock, f.guard, send)).toThrow(
    expect.objectContaining({ code: 'expired' })
  )
  expect(send).toHaveBeenCalledTimes(1)
  f.setNow('29')
  const pinned = f.pin()
  expect(() => f.owner.store.discloseTerms(pinned, f.buyer, f.clock, f.guard, send)).toThrow(
    expect.objectContaining({ code: 'expired' })
  )
  expect(send).toHaveBeenCalledTimes(1)
})
