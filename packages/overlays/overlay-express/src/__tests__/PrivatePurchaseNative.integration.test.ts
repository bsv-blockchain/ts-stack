import { expect, it } from '@jest/globals'
import { OutputProtocolError, OutputPurchaseServiceError } from '@bsv/sdk'
import { privatePurchaseNativeFixture } from './PrivatePurchaseNative.fixture.js'

async function retryClockConflict<T>(operation: () => Promise<T>, remaining = 8): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      (!(error instanceof OutputProtocolError) && !(error instanceof OutputPurchaseServiceError)) ||
      error.code !== 'conflict'
    )
      throw error
    if (remaining === 1)
      throw new Error('Original conflict reconciliation budget exhausted', { cause: error })
    // Retry only the original durable operation; no replacement request,
    // funding, candidate or relaxed clock/CAS guard is supplied.
    return retryClockConflict(operation, remaining - 1)
  }
}

it('constructs one real native purchase, authenticates submission, retains actual admission and decrypts licensed content', async () => {
  const f = await privatePurchaseNativeFixture()
  try {
    let owned = await f.openBuyer(true)
    await retryClockConflict(() => owned.buyer.advance())
    await owned.buyer.validate()
    const delivered = await owned.buyer.usableResult()
    expect(delivered.result.status).toBe('delivered')
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    await f.reopenSeller()
    f.withdraw()
    await owned.close()
    await f.reopenLicense()
    await f.native.owner.close()
    const wallet = await f.native.reopen()
    owned = await f.openBuyer(false, wallet.payment)
    await owned.buyer.recover()
    const recovered = await owned.buyer.usableResult()
    expect(recovered).toEqual(delivered)
    expect(await f.playback(recovered)).toEqual(f.asset.plaintext)
    f.setPermitted(false)
    await expect(owned.buyer.usableResult()).rejects.toMatchObject({ code: 'unauthorized' })
    f.setPermitted(true)
    await owned.close()
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
  } catch (error) {
    throw new AggregateError(
      [error, ...f.failures.slice(-1)],
      'Joint integration failed; retained host refusal is supplementary evidence'
    )
  } finally {
    await f.close()
  }
}, 120000)

it.each(['prepare', 'finalize', 'delivery'] as const)(
  'recovers a lost actual %s reply after reopening native buyer, wallet, seller and LCH custody',
  async lost => {
    const f = await privatePurchaseNativeFixture()
    try {
      const first = await f.openBuyer(true)
      if (lost === 'finalize') f.native.loseFinalization()
      else f.loseReply(lost)
      await expect(retryClockConflict(() => first.buyer.advance())).rejects.toThrow()
      if (lost !== 'finalize') expect(f.lostReplies).toHaveLength(1)
      else expect(f.native.counts.finalize).toBe(1)
      await first.close()
      await f.reopenSeller()
      await f.reopenLicense()
      await f.native.owner.close()
      const native = await f.native.reopen(),
        reopened = await f.openBuyer(false, native.payment),
        count = f.native.counts.finalize
      await retryClockConflict(() => reopened.buyer.recover())
      expect(f.native.counts.finalize).toBe(count)
      await retryClockConflict(() => reopened.buyer.advance())
      expect(await reopened.buyer.validate()).toBe('usable')
      const result = await reopened.buyer.usableResult()
      expect(await f.playback(result)).toEqual(f.asset.plaintext)
      expect(f.native.counts.prepare).toBe(1)
      expect(f.native.counts.finalize).toBe(1)
      await reopened.close()
    } finally {
      await f.close()
    }
  },
  120000
)

it('coordinates two native buyers while a real delivered reply is physically pending without a second financial action', async () => {
  const f = await privatePurchaseNativeFixture()
  try {
    const first = await f.openBuyer(true),
      pause = f.pauseDelivery(),
      attempt = retryClockConflict(() => first.buyer.advance())
    // Attach rejection handling before waiting on the independent physical cut.
    const outcome = attempt.then(
      result => ({ result }),
      error => ({ error })
    )
    await Promise.race([
      pause.entered,
      outcome.then(result => {
        if ('error' in result) throw result.error
        throw new Error('Purchase ended before the physical delivery cut', { cause: result })
      })
    ])
    await expect(first.buyer.advance()).rejects.toThrow('still active')
    const second = await f.openBuyer(),
      recovered = await retryClockConflict(() => second.buyer.recover())
    expect(recovered?.result.status).toBe('delivered')
    expect(await second.buyer.validate()).toBe('usable')
    expect(await f.playback(await second.buyer.usableResult())).toEqual(f.asset.plaintext)
    pause.release()
    expect(await attempt).toEqual(recovered)
    expect(await first.buyer.usableResult()).toEqual(recovered)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    await first.close()
    await second.close()
  } finally {
    await f.close()
  }
}, 120000)
