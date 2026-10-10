import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Beef,
  canonicalOutputJSON,
  Utils,
  signOutputPacket,
  outputPacketDigest,
  PrivateKey,
  Transaction,
  type OutputJSONObject
} from '@bsv/sdk'
import { WalletToolboxPurchasePayment } from '../src/private/WalletToolboxPurchasePayment.js'
import { nativePurchaseWalletFixture } from './private-purchase-wallet-native.fixture.js'
import { WalletToolboxProfilePurchasePayment } from '../src/private/WalletToolboxProfilePurchasePayment.js'
import type { RecoverableBuyerActions } from '../src/private/WalletToolboxBuyerPayment.js'
import { nativeProfilePurchaseWalletFixture } from './private-purchase-wallet-profile.fixture.js'
import {
  REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { fixture as currentProfileFixture } from './revenue-profile.fixture.js'
const signal = () => new AbortController().signal
it.each(['historical', 'current'] as const)(
  'rechecks returned funded bytes on every finalized recovery (%s)',
  async profile => {
    const { f, paymentFromActions } = await (
      profile === 'current'
        ? async () => {
            const f = await nativeProfilePurchaseWalletFixture()
            return {
              f,
              paymentFromActions: (actions: RecoverableBuyerActions) =>
                new WalletToolboxProfilePurchasePayment({ ...f.paymentOptions, actions })
            }
          }
        : async () => {
            const f = await nativePurchaseWalletFixture()
            return {
              f,
              paymentFromActions: (actions: RecoverableBuyerActions) =>
                new WalletToolboxPurchasePayment({ ...f.paymentOptions, actions })
            }
          }
    )()
    const active = signal()
    let alterResult = false
    const options = {
      ...f.paymentOptions,
      actions: {
        ...f.actions,
        recover: async (...args: Parameters<typeof f.actions.recover>) => {
          const result = await f.actions.recover(...args)
          if (!alterResult || result.state !== 'finalized') return result
          const changed = Transaction.fromAtomicBEEF(result.result.tx!)
          changed.outputs[0].satoshis = changed.outputs[0].satoshis! - 1
          return {
            state: 'finalized' as const,
            result: {
              ...result.result,
              tx: changed.toAtomicBEEF(),
              txid: changed.id('hex')
            }
          }
        }
      }
    }
    const payment = paymentFromActions(options.actions),
      plan = await payment.plan('89'.repeat(32), f.prepare, f.terms, active),
      candidate = await payment.finish(plan, () => {}, active)
    expect(await payment.recover(plan, active)).toEqual({ state: 'finalized', candidate })
    alterResult = true
    await expect(payment.recover(plan, active)).rejects.toThrow()
    await expect(payment.finish(plan, () => {}, active)).rejects.toThrow()
    alterResult = false
    expect(await payment.recover(plan, active)).toEqual({ state: 'finalized', candidate })
    expect(f.counts.prepare).toBe(1)
    expect(f.counts.finalize).toBe(1)
    expect(f.native.broadcast).not.toHaveBeenCalled()
  }
)
it('passes owned native bytes while retaining the original base64 plan and recovery identity', async () => {
  const f = await nativePurchaseWalletFixture(),
    active = signal(),
    recover = jest.spyOn(f.actions, 'recover'),
    payment = new WalletToolboxPurchasePayment(f.paymentOptions),
    plan = await payment.plan('70'.repeat(32), f.prepare, f.terms, active),
    before = canonicalOutputJSON(plan, { bytes: 4194304 })
  expect(await payment.recover(plan, active)).toEqual({ state: 'absent' })
  const request = recover.mock.calls[0][1],
    bytes = request.inputBEEF!
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect(Utils.toBase64(bytes)).toBe((plan.request as OutputJSONObject).inputBEEF)
  expect(Array.from(bytes)).toEqual(
    Beef.fromBinaryStrict(bytes).toBinaryAtomic(f.prepare.listing.txid)
  )
  bytes[0] ^= 255
  expect(canonicalOutputJSON(plan, { bytes: 4194304 })).toBe(before)
  const candidate = await payment.finish(plan, () => {}, active)
  expect(await f.verify(candidate)).toMatchObject({ status: 'verified' })
  const reopened = await f.reopen()
  expect(await reopened.payment.recover(plan, active)).toEqual({ state: 'finalized', candidate })
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.finalize).toBe(1)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
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

it('funds and recovers a current two-stage purchase with complete activation history and one native operation', async () => {
  const f = await nativeProfilePurchaseWalletFixture(),
    active = signal()
  const plan = await f.payment.plan('81'.repeat(32), f.prepare, f.terms, active)
  expect(plan.format).toBe('private-purchase-wallet/2')
  expect(f.payment.configuration.script).toEqual({
    activation: REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
    active: REVENUE_LISTING_ACTIVE_PROGRAM_SHA256
  })
  const candidate = await f.payment.finish(plan, () => {}, active)
  const verified = await f.verify(candidate)
  expect(verified).toMatchObject({
    status: 'verified',
    increment: f.lineage.descriptor.purchasePrice
  })
  if (verified.status !== 'verified') throw new Error('Current native purchase was not verified')
  expect(verified.purchaseCommitment).toMatch(/^[0-9a-f]{64}$/)
  expect(verified.lineage.stage).toBe('active')
  expect(verified.lineage.genesis).toEqual(f.lineage.genesis)
  const reopened = await f.reopen()
  f.setHeight(f.lineage.descriptor.expiryHeight)
  f.setAccess(false)
  expect(await reopened.payment.recover(plan, active)).toEqual({ state: 'finalized', candidate })
  expect(
    await reopened.payment.finish(
      plan,
      () => {
        throw new Error('Historical recovery cannot grant new work')
      },
      active
    )
  ).toEqual(candidate)
  expect(f.counts.prepare).toBe(1)
  expect(f.counts.finalize).toBe(1)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('refuses a verified expired current listing before native allocation', async () => {
  const f = await nativeProfilePurchaseWalletFixture(524288, 101)
  await expect(f.payment.plan('82'.repeat(32), f.prepare, f.terms, signal())).rejects.toThrow(
    'height expired'
  )
  expect(f.counts.prepare).toBe(0)
  expect(f.counts.finalize).toBe(0)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
describe('selected chain during native allocation', () => {
  let f: Awaited<ReturnType<typeof nativeProfilePurchaseWalletFixture>>
  // Fixture setup and the full operation each keep Jest's original 5s bound.
  // Every case owns a fresh wallet; no signed intent or verification is reused.
  beforeEach(async () => {
    f = await nativeProfilePurchaseWalletFixture()
  })
  it('retains original native funding when the verified current chain view changes during allocation', async () => {
    const active = signal()
    const originalPrepare = f.actions.prepare
    const options = {
      ...f.paymentOptions,
      actions: {
        ...f.actions,
        prepare: async (...args: Parameters<typeof originalPrepare>) => {
          const result = await originalPrepare(...args)
          f.setHeight(102)
          return result
        }
      }
    }
    const payment = new WalletToolboxProfilePurchasePayment(options)
    const plan = await payment.plan('83'.repeat(32), f.prepare, f.terms, active)
    await expect(payment.finish(plan, () => {}, active)).rejects.toThrow('chain context changed')
    expect(await payment.recover(plan, active)).toEqual({ state: 'prepared' })
    expect(f.counts.prepare).toBe(1)
    expect(f.counts.finalize).toBe(0)
    f.setHeight(101)
    const candidate = await payment.finish(plan, () => {}, active)
    expect(await f.verify(candidate)).toMatchObject({ status: 'verified' })
    expect(f.counts.prepare).toBe(1)
    expect(f.counts.finalize).toBe(1)
    expect(f.native.broadcast).not.toHaveBeenCalled()
  })
})
it('binds current native plans to both frozen programs and the separately selected format', async () => {
  const f = await nativeProfilePurchaseWalletFixture(),
    active = signal()
  const plan = await f.payment.plan('84'.repeat(32), f.prepare, f.terms, active)
  for (const change of ['format', 'active-program', 'activation-program']) {
    const altered = JSON.parse(canonicalOutputJSON(plan, { bytes: 4194304 })) as OutputJSONObject
    if (change === 'format') altered.format = 'private-purchase-wallet/1'
    else
      ((altered.binding as OutputJSONObject).script as OutputJSONObject)[
        change === 'active-program' ? 'active' : 'activation'
      ] = '00'.repeat(32)
    await expect(f.payment.finish(altered, () => {}, active)).rejects.toThrow('owner differs')
  }
  expect(f.counts.prepare).toBe(0)
  expect(f.counts.finalize).toBe(0)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})
it('refuses an authenticated reserve-stage listing without treating it as an active purchase', async () => {
  const f = await nativeProfilePurchaseWalletFixture(),
    active = signal()
  const point = structuredClone(f.lineage.genesis.body.genesis)
  const request = { ...f.prepare, listing: point }
  const lineage = {
    ...f.lineage,
    target: point,
    transactions: f.lineage.transactions.filter(tx => tx.txid === point.txid)
  }
  const terms = signOutputPacket(
    'purchase-terms',
    {
      ...f.terms.body,
      listing: point,
      requestDigest: outputPacketDigest('purchase-request', request),
      domainEvidence: {
        ...f.terms.body.domainEvidence,
        bytes: Utils.toBase64(
          new TextEncoder().encode(canonicalOutputJSON(lineage, { bytes: 4194304 }))
        )
      }
    },
    new PrivateKey(currentProfileFixture.testActors.seller.scalar)
  )
  await expect(f.payment.plan('85'.repeat(32), request, terms, active)).rejects.toThrow(
    'stage does not permit'
  )
  expect(f.counts.prepare).toBe(0)
  expect(f.counts.finalize).toBe(0)
  expect(f.native.broadcast).not.toHaveBeenCalled()
})

it.each(['actions', 'family', 'chains'] as const)(
  'refuses replacing the selected current wallet %s owner before new allocation',
  async key => {
    const f = await nativeProfilePurchaseWalletFixture(),
      active = signal()
    const options = { ...f.paymentOptions }
    const payment = new WalletToolboxProfilePurchasePayment(options)
    const plan = await payment.plan('87'.repeat(32), f.prepare, f.terms, active)
    if (key === 'actions') options.actions = { ...options.actions }
    else if (key === 'family') options.family = Object.create(options.family)
    else options.chains = { ...options.chains }
    await expect(payment.finish(plan, () => {}, active)).rejects.toThrow('installation changed')
    expect(f.counts.prepare).toBe(0)
    expect(f.counts.finalize).toBe(0)
    expect(f.native.broadcast).not.toHaveBeenCalled()
  }
)
it.each(['actions', 'family', 'chains'] as const)(
  'preserves historical installation identity when its %s owner is replaced',
  async key => {
    const f = await nativePurchaseWalletFixture(),
      active = signal()
    const options = { ...f.paymentOptions }
    const payment = new WalletToolboxPurchasePayment(options)
    const plan = await payment.plan('88'.repeat(32), f.prepare, f.terms, active)
    if (key === 'actions') options.actions = { ...options.actions }
    else if (key === 'family') options.family = Object.create(options.family)
    else options.chains = { ...options.chains }
    await expect(payment.finish(plan, () => {}, active)).rejects.toThrow('installation changed')
    expect(f.counts.prepare).toBe(0)
    expect(f.counts.finalize).toBe(0)
    expect(f.native.broadcast).not.toHaveBeenCalled()
  }
)
