import { afterEach, expect, it, jest } from '@jest/globals'
import { parseOutputPaidLookupChallenge, type OutputJSONObject } from '@bsv/sdk'
import { acquisitionFixture } from './private-acquisition.fixture.js'
import { nativeBuyerFixture } from './private-buyer-native.fixture.js'
afterEach(() => {
  jest.restoreAllMocks()
})
it('uses one actual noSend action and recovers its exact BEEF after reopening without another signature', async () => {
  const f = await nativeBuyerFixture(),
    quote = await acquisitionFixture(f.selected),
    signal = new AbortController().signal
  try {
    const plan = await f.payment.plan(
      'a4'.repeat(32),
      quote.challenge,
      quote.payment().derivationSuffix,
      signal
    )
    expect(await f.payment.recover(plan, signal)).toEqual({ state: 'absent' })
    const guard = jest.fn(),
      paid = await f.payment.finish(plan, guard, signal)
    expect(guard).toHaveBeenCalled()
    expect(paid.derivationPrefix).toBe(quote.challenge.derivationPrefix)
    expect(await f.payment.recover(plan, signal)).toEqual({ state: 'finalized', payment: paid })
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
    await f.native.close()
    const reopened = await f.reopen()
    jest.spyOn(reopened.actions, 'prepare').mockRejectedValue(new Error('Must not allocate again'))
    jest.spyOn(reopened.actions, 'finalize').mockRejectedValue(new Error('Must not sign again'))
    // Pin replacement spies before explicitly installing a fresh adapter.
    const { WalletToolboxBuyerPayment } =
      await import('../src/private/WalletToolboxBuyerPayment.js')
    const owner = new WalletToolboxBuyerPayment(reopened.actions, reopened.native.wallet, {
      wallet: reopened.native.identities.wallet,
      storage: reopened.native.identities.storage,
      chain: f.selected,
      originator: 'buyer-reference.local'
    })
    const expired = () => {
      throw new Error('New payment expired')
    }
    expect(await owner.finish(plan, expired, signal)).toEqual(paid)
    expect(await owner.recover(plan, signal)).toEqual({ state: 'finalized', payment: paid })
    expect(reopened.actions.prepare).not.toHaveBeenCalled()
    expect(reopened.actions.finalize).not.toHaveBeenCalled()
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
}, 30000)
it('checks local authority before allocation and refuses changed construction or wallet ownership', async () => {
  const f = await nativeBuyerFixture(),
    quote = await acquisitionFixture(f.selected),
    signal = new AbortController().signal
  try {
    const plan = await f.payment.plan(
      'a5'.repeat(32),
      quote.challenge,
      quote.payment().derivationSuffix,
      signal
    )
    await expect(
      f.payment.finish(
        plan,
        () => {
          throw new Error('No authority')
        },
        signal
      )
    ).rejects.toThrow('No authority')
    expect(await f.payment.recover(plan, signal)).toEqual({ state: 'absent' })
    const changed = structuredClone(plan)
    ;(changed.request as OutputJSONObject).description = 'Another construction'
    await expect(f.payment.finish(changed, () => {}, signal)).rejects.toMatchObject({
      code: 'context-changed'
    })
    await expect(
      f.payment.plan(
        'a6'.repeat(32),
        parseOutputPaidLookupChallenge({ ...quote.challenge, buyer: quote.seller }),
        quote.payment().derivationSuffix,
        signal
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
  } finally {
    await f.close()
  }
}, 30000)

it('retains preparation when authority expires during allocation and does not sign it during recovery', async () => {
  const f = await nativeBuyerFixture(),
    quote = await acquisitionFixture(f.selected),
    signal = new AbortController().signal,
    prepare = f.actions.prepare.bind(f.actions)
  let allowed = true
  jest.spyOn(f.actions, 'prepare').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    allowed = false
    return result
  })
  const finalize = jest.spyOn(f.actions, 'finalize'),
    { WalletToolboxBuyerPayment } = await import('../src/private/WalletToolboxBuyerPayment.js'),
    payment = new WalletToolboxBuyerPayment(f.actions, f.native.wallet, {
      wallet: f.native.identities.wallet,
      storage: f.native.identities.storage,
      chain: f.selected,
      originator: 'buyer-reference.local'
    })
  try {
    const plan = await payment.plan(
        'a7'.repeat(32),
        quote.challenge,
        quote.payment().derivationSuffix,
        signal
      ),
      guard = () => {
        if (!allowed) throw new Error('Quote expired during preparation')
      }
    await expect(payment.finish(plan, guard, signal)).rejects.toThrow(
      'Quote expired during preparation'
    )
    expect(await payment.recover(plan, signal)).toEqual({ state: 'prepared' })
    await expect(payment.finish(plan, guard, signal)).rejects.toThrow(
      'Quote expired during preparation'
    )
    expect(f.actions.prepare).toHaveBeenCalledTimes(1)
    expect(finalize).not.toHaveBeenCalled()
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
}, 30000)
