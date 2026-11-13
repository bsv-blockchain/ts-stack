import { afterEach, expect, it, jest } from '@jest/globals'
import { parseOutputPaidLookupChallenge, PrivateKey, type OutputJSONObject } from '@bsv/sdk'
import { WalletToolboxBuyerPayment as NativeBuyerPayment } from '../src/private/WalletToolboxBuyerPayment.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'
import { nativeBuyerFixture } from './private-buyer-native.fixture.js'
afterEach(() => {
  jest.restoreAllMocks()
})
it('refuses every changed native recovery binding before allocation', async () => {
  const f = await nativeBuyerFixture()
  try {
    const binding = {
      wallet: f.native.identities.wallet,
      storage: f.native.identities.storage,
      chain: f.selected,
      originator: 'buyer-reference.local'
    }
    const prepare = jest.spyOn(f.actions, 'prepare')
    for (const changed of [
      { ...binding, wallet: new PrivateKey(85).toPublicKey().toString() },
      { ...binding, storage: binding.storage + '-another' },
      { ...binding, chain: { ...binding.chain, network: 'another-native-network' } },
      { ...binding, originator: 'another-buyer.local' }
    ])
      expect(() => new NativeBuyerPayment(f.actions, f.native.wallet, changed)).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Buyer wallet owner differs from original binding'
        })
      )
    expect(prepare).not.toHaveBeenCalled()
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it('refuses altered retained native plans before reading action recovery', async () => {
  const f = await nativeBuyerFixture(),
    quote = await acquisitionFixture(f.selected)
  try {
    const recover = jest.spyOn(f.actions, 'recover')
    const payment = new NativeBuyerPayment(f.actions, f.native.wallet, {
      wallet: f.native.identities.wallet,
      storage: f.native.identities.storage,
      chain: f.selected,
      originator: 'buyer-reference.local'
    })
    const signal = new AbortController().signal
    const plan = await payment.plan(
      'a6'.repeat(32),
      quote.challenge,
      quote.payment().derivationSuffix,
      signal
    )
    const otherKey = new PrivateKey(85).toPublicKey().toString()
    const variants = [
      { value: { ...plan, format: 'another-plan' }, code: 'context-changed' },
      {
        value: {
          ...plan,
          binding: { ...(plan.binding as OutputJSONObject), originator: 'another.local' }
        },
        code: 'context-changed'
      },
      {
        value: {
          ...plan,
          request: { ...(plan.request as OutputJSONObject), description: 'another request' }
        },
        code: 'context-changed'
      },
      {
        value: { ...plan, derivationSuffix: Buffer.from('another suffix').toString('base64') },
        code: 'context-changed'
      },
      { value: { ...plan, sellerPaymentKey: otherKey }, code: 'context-changed' },
      {
        value: { ...plan, challenge: { ...(plan.challenge as OutputJSONObject), buyer: otherKey } },
        code: 'context-changed'
      },
      { value: { ...plan, operationId: 'not-hex' }, code: 'invalid' },
      { value: { ...plan, unexpected: true }, code: 'invalid' }
    ]
    for (const { value, code } of variants) {
      await expect(payment.recover(value, signal)).rejects.toMatchObject({ code })
      expect(recover).not.toHaveBeenCalled()
    }
    expect(await payment.recover(plan, signal)).toEqual({ state: 'absent' })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

it('refuses non-synchronous or non-void guards before native allocation', async () => {
  const f = await nativeBuyerFixture(),
    quote = await acquisitionFixture(f.selected)
  try {
    const prepare = jest.spyOn(f.actions, 'prepare')
    const payment = new NativeBuyerPayment(f.actions, f.native.wallet, {
      wallet: f.native.identities.wallet,
      storage: f.native.identities.storage,
      chain: f.selected,
      originator: 'buyer-reference.local'
    })
    const signal = new AbortController().signal
    const plan = await payment.plan(
      'a7'.repeat(32),
      quote.challenge,
      quote.payment().derivationSuffix,
      signal
    )
    for (const guard of [async () => undefined, () => true, () => Promise.resolve(), 42 as never])
      await expect(payment.finish(plan, guard, signal)).rejects.toMatchObject({ code: 'invalid' })
    expect(prepare).not.toHaveBeenCalled()
    expect(f.fixture.broadcast).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
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
