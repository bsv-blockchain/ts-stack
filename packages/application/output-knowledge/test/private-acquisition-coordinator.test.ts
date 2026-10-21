import { expect, it } from '@jest/globals'
import { OutputProtocolError, PrivateKey, type OutputPaidLookupAcquired } from '@bsv/sdk'
import { acquisitionCoordinatorFixture } from './private-acquisition-coordinator.fixture.js'

it('freezes before payment, reserves before the wallet and commits one recoverable delivery', async () => {
  const f = await acquisitionCoordinatorFixture()
  expect(await f.quote()).toBe(f.f.id)
  expect(f.projected()).toMatchObject({ status: 'quoted', challenge: { satoshis: '100' } })
  expect(f.counts.internalize).toBe(0)
  expect(await f.pay()).toBe(f.f.id)
  expect(f.projected()).toMatchObject({
    status: 'delivered',
    funding: { txid: f.paymentTransaction.id('hex'), outputIndex: 0 },
    result: { context: 'AQID' }
  })
  expect(f.getCredits()).toBe(1)
  expect(f.counts).toEqual({
    prepare: 1,
    validate: 1,
    issue: 1,
    status: 1,
    internalize: 1,
    assess: 1
  })
  await f.pay()
  await f.recover()
  expect(f.getCredits()).toBe(1)
  expect(f.counts.issue).toBe(1)
})
it('returns the original quote and retained material after catalogue and manifest expiry', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  const original = f.current()!.original
  f.setAvailable(false)
  f.f.setNow('1000')
  await f.quote()
  expect(f.current()!.original).toEqual(original)
  await f.pay()
  expect(f.projected()).toMatchObject({ status: 'delivered' })
  expect(f.counts.prepare).toBe(1)
})
it('rejects changed request semantics without replacing the original invoice', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  const original = f.current()!.original
  await expect(
    f.coordinator.acquire({ ...f.request, request: 'AQ==' }, undefined, f.caller)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.current()!.original).toEqual(original)
  expect(f.counts.prepare).toBe(1)
})
it('never creates a quote implicitly when presented with an unprepared payment', async () => {
  const f = await acquisitionCoordinatorFixture()
  await expect(f.pay()).rejects.toMatchObject({ code: 'not-found' })
  expect(f.current()).toBeUndefined()
  expect(f.counts.prepare).toBe(0)
})
it('keeps policy-delayed complete candidates pinned through their deadline', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  f.setRelease(false)
  await f.pay()
  expect(f.current()!.state.progress.candidate!.verdict).toBe('pending')
  expect(f.getCredits()).toBe(0)
  f.f.setNow('100000')
  f.setRelease(true)
  await f.recover()
  expect(f.projected()).toMatchObject({ status: 'delivered', recoveryUntil: '186400' })
})
it('expires only unpinned quotes and never accepts a first payment at the exact cutoff', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  f.f.setNow(f.current()!.state.progress.recoveryUntil)
  await expect(f.pay()).rejects.toMatchObject({ code: 'expired' })
  await f.recover()
  expect(f.projected()).toMatchObject({ status: 'expired' })
  expect(f.getCredits()).toBe(0)
})
it('holds an unresolved wallet result without retrying or disclosing a secret', async () => {
  // Install the model port before constructing the coordinator, not by replacing a live method.
  const g = await acquisitionCoordinatorFixture({
    wallet: {
      status: async () => ({ state: 'unknown' }),
      internalize: async () => {
        throw new Error('Must not retry unknown')
      }
    }
  })
  await g.quote()
  await g.pay()
  await g.recover()
  expect(g.projected()).toMatchObject({ status: 'funding-pending' })
  expect((g.projected() as OutputPaidLookupAcquired).result).toBeUndefined()
  expect(g.getCredits()).toBe(0)
})
it('retains a definitive local wallet rejection without implying a global transaction failure', async () => {
  const f = await acquisitionCoordinatorFixture({
    wallet: {
      status: async state => ({
        state: 'rejected',
        operationId: state.funding!.operation.id,
        reason: 'payment-script-mismatch'
      }),
      internalize: async () => {
        throw new Error('must not execute')
      }
    }
  })
  await f.quote()
  await f.pay()
  await f.recover()
  expect(f.projected()).toMatchObject({ status: 'failed', reason: 'payment-script-mismatch' })
})
it('keeps funded material recoverable when the issuer is temporarily unavailable', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  f.setIssue(false)
  await expect(f.pay()).rejects.toThrow('issuer unavailable')
  expect(f.current()!.state.progress.phase).toBe('delivery-pending')
  expect(f.getCredits()).toBe(1)
  f.f.setNow('100000')
  f.setIssue(true)
  await f.recover()
  expect(f.projected()).toMatchObject({ status: 'delivered' })
  expect(f.getCredits()).toBe(1)
})
it('refuses current authorization and selected capability changes on retained work', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  await expect(
    f.coordinator.recover(f.f.id, {
      ...f.caller,
      buyer: new PrivateKey(92).toPublicKey().toString()
    })
  ).rejects.toMatchObject({ code: 'not-found' })
  await expect(
    f.coordinator.recover(f.f.id, { ...f.caller, capability: '99'.repeat(32) })
  ).rejects.toMatchObject({ code: 'context-changed' })
  f.setAccess(false)
  await expect(f.recover()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.getCredits()).toBe(0)
})
it('refuses domain failure before quote and domain revocation before any payment effect', async () => {
  const f = await acquisitionCoordinatorFixture()
  f.setDomainValid(false)
  await expect(f.quote()).rejects.toThrow('domain binding')
  expect(f.current()).toBeUndefined()
  f.setDomainValid(true)
  await f.quote()
  f.setAuthority(false)
  await expect(f.pay()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.getCredits()).toBe(0)
})
it('marks a conclusively invalid candidate without authorizing an uncertain replacement', async () => {
  const f = await acquisitionCoordinatorFixture({
    funding: {
      verify: async () => {
        throw new OutputProtocolError('invalid', 'invalid fixture')
      }
    }
  })
  await f.quote()
  await expect(f.pay()).rejects.toMatchObject({ code: 'invalid' })
  expect(f.current()!.state.progress).toMatchObject({
    phase: 'quoted',
    candidate: { verdict: 'invalid' }
  })
  expect(f.getCredits()).toBe(0)
  f.f.setNow('100000')
  await f.recover()
  expect(f.projected()).toMatchObject({ status: 'expired' })
})
it('preserves an inconclusive funding verification for uncharged recovery', async () => {
  const f = await acquisitionCoordinatorFixture({
    funding: {
      verify: async () => {
        throw new OutputProtocolError('unavailable', 'ancestry offline', true)
      }
    }
  })
  await f.quote()
  await expect(f.pay()).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.current()!.state.progress).toMatchObject({
    phase: 'quoted',
    candidate: { verdict: 'pending' }
  })
  expect(f.getCredits()).toBe(0)
})
it('pins installed port identities and refuses requests after stop', async () => {
  const f = await acquisitionCoordinatorFixture()
  await f.quote()
  f.wallet.status = async () => ({ state: 'absent' })
  await expect(f.recover()).rejects.toMatchObject({ code: 'context-changed' })
  const g = await acquisitionCoordinatorFixture()
  await g.coordinator.stop()
  await expect(g.quote()).rejects.toMatchObject({ code: 'cancelled' })
})
it('retains physical capacity after cancellation and drains the exact wallet effect before stopping', async () => {
  const { PrivateAcquisitionCoordinator } =
    await import('../src/private/PrivateAcquisitionCoordinator.js')
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
      enter = resolve
    }),
    blocked = new Promise<void>(resolve => {
      release = resolve
    })
  let saved: import('../src/private/PrivateAcquisitionWallet.js').PrivateAcquisitionWalletOutcome =
    { state: 'absent' }
  const f = await acquisitionCoordinatorFixture({
    maximumWork: 1,
    perBuyerWork: 1,
    wallet: {
      status: async () => saved,
      internalize: async state => {
        enter()
        await blocked
        saved = { state: 'accepted', receipt: f.f.f.f.receipt(state) }
        return saved
      }
    }
  })
  await f.quote()
  const abort = new AbortController(),
    work = f.coordinator.acquire(f.request, f.payment, { ...f.caller, signal: abort.signal })
  try {
    await Promise.race([
      entered,
      work.then(() => {
        throw new Error('Acquisition settled before its held wallet effect was entered')
      })
    ])
    abort.abort()
    await expect(work).rejects.toMatchObject({ code: 'cancelled' })
    await expect(f.recover()).rejects.toMatchObject({ code: 'limited' })
    let drained = false
    const stopping = f.coordinator.stop().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await stopping
    expect(f.current()!.state.progress.phase).toBe('funding-pending')
  } finally {
    release()
    await f.coordinator.stop()
    await work.catch(() => undefined)
  }
  const resumed = new PrivateAcquisitionCoordinator(f.options)
  try {
    await resumed.recover(f.f.id, f.caller)
    expect(f.projected()).toMatchObject({ status: 'delivered' })
  } finally {
    await resumed.stop()
  }
})
