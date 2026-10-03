import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, Utils, type OutputJSONObject } from '@bsv/sdk'
import { WalletToolboxPurchasePayment } from '../src/private/WalletToolboxPurchasePayment.js'
import { nativePurchaseWalletFixture } from './private-purchase-wallet-native.fixture.js'
const signal = () => new AbortController().signal
it('constructs, funds, signs and recovers an actual native purchase with full selected-chain Script/genesis verification', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('71'.repeat(32), f.prepare, f.terms, active)
  expect(await f.payment.recover(plan, active)).toEqual({ state: 'absent' })
  expect(f.counts.prepare).toBe(0)
  const candidate = await f.payment.finish(plan, () => {}, active)
  expect(canonicalOutputJSON(candidate).length).toBeLessThanOrEqual(f.payment.maximumCandidateBytes)
  expect(await f.verify(candidate)).toMatchObject({
    status: 'verified',
    increment: f.lineage.descriptor.purchasePrice
  })
  const reopened = await f.reopen()
  expect(await reopened.payment.recover(plan, active)).toEqual({ state: 'finalized', candidate })
  expect(
    await reopened.payment.finish(
      plan,
      () => {
        throw new Error('No new financial work')
      },
      active
    )
  ).toEqual(candidate)
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.finalize).toBe(1)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('recovers lost native finalization after reopening without another funding allocation or signature', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('72'.repeat(32), f.prepare, f.terms, active)
  f.loseFinalization()
  await expect(f.payment.finish(plan, () => {}, active)).rejects.toThrow('Lost native')
  const reopened = await f.reopen(),
    result = await reopened.payment.recover(plan, active)
  expect(result.state).toBe('finalized')
  if (result.state === 'finalized')
    expect(await f.verify(result.candidate)).toMatchObject({ status: 'verified' })
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.finalize).toBe(1)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('refuses a funded transaction exceeding future submission capacity before any native signing', async () => {
  const f = await nativePurchaseWalletFixture(4096),
    active = signal(),
    plan = await f.payment.plan('73'.repeat(32), f.prepare, f.terms, active)
  await expect(f.payment.finish(plan, () => {}, active)).rejects.toThrow('capacity')
  const reopened = await f.reopen()
  expect(await reopened.payment.recover(plan, active)).toEqual({ state: 'prepared' })
  expect(f.counts.finalize).toBe(0)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('requires independent current lineage and immutable wallet construction before allocation', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('74'.repeat(32), f.prepare, f.terms, active)
  const wrong = JSON.parse(canonicalOutputJSON(plan, { bytes: 4194304 })) as OutputJSONObject
  ;(wrong.request as OutputJSONObject).options = { noSend: false }
  await expect(f.payment.finish(wrong, () => {}, active)).rejects.toThrow('construction changed')
  const malformed = {
    ...f.terms,
    body: {
      ...f.terms.body,
      domainEvidence: { ...f.terms.body.domainEvidence, bytes: Utils.toBase64([1]) }
    }
  }
  await expect(f.payment.plan('75'.repeat(32), f.prepare, malformed, active)).rejects.toThrow()
  f.setAccess(false)
  await expect(f.payment.finish(plan, () => {}, active)).rejects.toThrow('context changed')
  expect(f.counts.prepare).toBe(0)
  expect(
    () =>
      new WalletToolboxPurchasePayment({
        ...f.paymentOptions,
        binding: { ...f.paymentOptions.binding, storage: 'other' }
      })
  ).toThrow('owner differs')
})
it('refuses asynchronous or Promise-valued chain and signing guards before native allocation', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('76'.repeat(32), f.prepare, f.terms, active)
  expect(
    () =>
      new WalletToolboxPurchasePayment({
        ...f.paymentOptions,
        checkCurrent: async () => {}
      })
  ).toThrow('synchronous')
  const guarded = new WalletToolboxPurchasePayment({
    ...f.paymentOptions,
    checkCurrent: () => Promise.reject(new Error('Deferred chain refusal'))
  })
  await expect(guarded.plan('77'.repeat(32), f.prepare, f.terms, active)).rejects.toThrow(
    'guard did not complete'
  )
  await expect(f.payment.finish(plan, async () => {}, active)).rejects.toThrow('synchronous')
  await expect(
    f.payment.finish(plan, () => Promise.reject(new Error('Deferred signing refusal')), active)
  ).rejects.toThrow('guard did not complete')
  expect(f.counts.prepare).toBe(0)
  expect(f.counts.finalize).toBe(0)
})
it('recovers the exact native transaction finalized by another owner while preparation returns', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('78'.repeat(32), f.prepare, f.terms, active)
  let originalCandidate: unknown
  const competing = new WalletToolboxPurchasePayment({
    ...f.paymentOptions,
    actions: {
      ...f.actions,
      prepare: async (...args) => {
        const result = await f.actions.prepare(...args)
        originalCandidate = await f.payment.finish(plan, () => {}, active)
        return result
      }
    }
  })
  const candidate = await competing.finish(plan, () => {}, active)
  expect(candidate).toEqual(originalCandidate)
  expect(await f.verify(candidate)).toMatchObject({ status: 'verified' })
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.finalize).toBe(1)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('rejects changes to both public capacity fields instead of widening the installed promise', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    plan = await f.payment.plan('7a'.repeat(32), f.prepare, f.terms, active)
  f.paymentOptions.maximumCandidateBytes = 1048576
  Object.defineProperty(f.payment, 'maximumCandidateBytes', { value: 1048576 })
  await expect(f.payment.finish(plan, () => {}, active)).rejects.toThrow('installation changed')
  expect(f.counts.prepare).toBe(0)
  expect(f.counts.finalize).toBe(0)
})
