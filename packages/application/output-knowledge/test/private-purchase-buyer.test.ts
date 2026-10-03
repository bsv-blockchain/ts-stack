import { expect, it, jest } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  PrivatePurchaseBuyer,
  privatePurchaseBuyerBinding
} from '../src/private/PrivatePurchaseBuyer.js'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'
it('retains one original purchase in protected native custody and reopens usable rights after expiry', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  expect(await owner.buyer.status()).toBe('ready')
  const result = await owner.buyer.advance()
  expect(result.result.status).toBe('delivered')
  expect(await owner.buyer.status()).toBe('received')
  expect(await owner.buyer.validate()).toBe('usable')
  await owner.buyer.stop()
  await owner.state.close()
  await owner.objects.close()
  f.setNow('200')
  const reopened = await f.open()
  expect(await reopened.buyer.recover()).toEqual(result)
  expect(await reopened.buyer.usableResult()).toEqual(result)
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  expect(f.calls).toEqual(['prepare', 'submit'])
})
it.each(['prepare', 'finish', 'submit'] as const)(
  'recovers a lost %s reply without a replacement financial action',
  async lost => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true)
    f.lose(lost)
    await expect(first.buyer.advance()).rejects.toThrow('Lost original')
    const second = await f.open()
    const prior = f.counts.finish
    await second.buyer.recover()
    expect(f.counts.finish).toBe(prior)
    const result = await second.buyer.advance()
    expect(result.result.status).toBe('delivered')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
    expect(await second.buyer.validate()).toBe('usable')
  }
)
it('allows an already finalized retained transaction after cutoff but refuses new funding', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  f.lose('finish')
  await expect(owner.buyer.advance()).rejects.toThrow('wallet reply')
  f.setNow('200')
  expect((await owner.buyer.advance()).result.status).toBe('delivered')
  expect(f.counts.finish).toBe(1)
  const g = purchaseBuyerFixture(),
    other = await g.open(true)
  g.setNow('200')
  await expect(other.buyer.advance()).rejects.toThrow()
  expect(g.counts.finish).toBe(0)
})
it('separates retained delivered bytes, independent validation and current usability', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  await owner.buyer.advance()
  f.setValid(false)
  await expect(owner.buyer.validate()).rejects.toThrow('material')
  expect(await owner.buyer.status()).toBe('received')
  f.setValid(true)
  f.setUsable(false)
  expect(await owner.buyer.validate()).toBe('validated')
  await expect(owner.buyer.usableResult()).rejects.toThrow('not usable')
  f.setUsable(true)
  expect(await owner.buyer.validate()).toBe('usable')
  f.setAccess(false)
  await expect(owner.buyer.usableResult()).rejects.toThrow('access changed')
  expect(f.counts.finish).toBe(1)
})
it('refuses changed owners, original requests and missing future capacity before money', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  for (const partial of [
    {
      ...f.partial,
      original: {
        ...f.partial.original,
        request: { ...f.partial.original.request, request: 'AQ==' }
      }
    },
    { ...f.partial, payment: { ...f.partial.payment, configuration: { replaced: true } } }
  ]) {
    expect(canonicalOutputJSON(privatePurchaseBuyerBinding(partial))).not.toBe(
      canonicalOutputJSON(f.binding)
    )
    await expect(PrivatePurchaseBuyer.open({ ...owner.ports, ...partial })).rejects.toThrow(
      'binding'
    )
  }
  await expect(
    PrivatePurchaseBuyer.open({
      ...owner.ports,
      objects: {
        ...owner.objects,
        configuration: { ...owner.objects.configuration, maximumObjects: 5 }
      }
    } as never)
  ).rejects.toThrow('capacity')
  Object.defineProperty(f.partial.validation, 'id', { value: 'changed' })
  await expect(owner.buyer.advance()).rejects.toThrow('capability changed')
  expect(f.counts.finish).toBe(0)
})
it('read-only recovery never starts preparation and backward clocks refuse new effects', async () => {
  const f = purchaseBuyerFixture(),
    owner = await f.open(true)
  expect(await owner.buyer.recover()).toBeUndefined()
  expect(f.calls).toEqual([])
  f.setNow('19')
  await expect(owner.buyer.advance()).rejects.toThrow('clock moved')
  expect(f.counts.finish).toBe(0)
})
it.each(['terms', 'plan', 'candidate', 'result'] as const)(
  'reconciles a committed %s object after its local reply is lost',
  async role => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true),
      put = first.objects.put.bind(first.objects)
    let cut = true
    jest.spyOn(first.objects, 'put').mockImplementation(async (id, binding, bytes) => {
      const result = await put(id, binding, bytes)
      if (cut && binding.role === role) {
        cut = false
        throw new Error('Lost committed object reply')
      }
      return result
    })
    const interrupted = await PrivatePurchaseBuyer.open(first.ports)
    await expect(interrupted.advance()).rejects.toThrow('Lost committed object')
    await interrupted.stop()
    const next = await f.open(),
      financialWork = f.counts.finish
    await next.buyer.recover()
    expect(f.counts.finish).toBe(financialWork)
    expect((await next.buyer.advance()).result.status).toBe('delivered')
    expect(await next.buyer.validate()).toBe('usable')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
  }
)
it.each(['prepared', 'funding', 'funded', 'received'] as const)(
  'reconciles native %s control commit without another financial action',
  async phase => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true),
      cas = first.state.compareAndSwap.bind(first.state)
    let cut = true
    jest.spyOn(first.state, 'compareAndSwap').mockImplementation(async (revision, value) => {
      const result = await cas(revision, value)
      if (cut && value.phase === phase) {
        cut = false
        throw new Error('Lost committed control reply')
      }
      return result
    })
    const interrupted = await PrivatePurchaseBuyer.open(first.ports)
    await expect(interrupted.advance()).rejects.toThrow('Lost committed control')
    await interrupted.stop()
    const next = await f.open(),
      financialWork = f.counts.finish
    await next.buyer.recover()
    expect(f.counts.finish).toBe(financialWork)
    expect((await next.buyer.advance()).result.status).toBe('delivered')
    expect(f.counts.finish).toBe(1)
    expect(f.server.counts.issue).toBe(1)
  }
)
it('drains physical preparation after cancellation and rejects overlap while it is still active', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    original = f.partial.validation.preflight
  let release = () => {},
    entered = () => {}
  const begun = new Promise<void>(resolve => {
      entered = resolve
    }),
    pending = new Promise<void>(resolve => {
      release = resolve
    })
  f.partial.validation.preflight = async (...args) => {
    entered()
    await pending
    await original(...args)
  }
  const buyer = await PrivatePurchaseBuyer.open(first.ports),
    abort = new AbortController(),
    attempt = buyer.advance(abort.signal),
    stopped = expect(attempt).rejects.toThrow('cancelled')
  await begun
  abort.abort()
  await stopped
  await expect(buyer.advance()).rejects.toThrow('still active')
  let drained = false
  const stopping = buyer.stop().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await stopping
  expect(drained).toBe(true)
  expect(f.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
})
it('refuses Promise-valued access guards before disclosure or financial work', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true)
  await expect(
    PrivatePurchaseBuyer.open({ ...first.ports, current: async () => true } as never)
  ).rejects.toThrow('synchronous')
  const buyer = await PrivatePurchaseBuyer.open({
    ...first.ports,
    current: (() =>
      Promise.reject(new Error('Deferred access refusal'))) as unknown as () => boolean
  })
  await expect(buyer.advance()).rejects.toThrow('access changed')
  expect(f.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
})
it('retains completed rights when the original wallet cannot be queried any longer', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    result = await first.buyer.advance()
  await first.buyer.validate()
  f.partial.payment.recover = async () => {
    throw new Error('Original wallet is offline')
  }
  const second = await PrivatePurchaseBuyer.open(first.ports)
  expect(await second.recover()).toEqual(result)
  expect(await second.usableResult()).toEqual(result)
  expect(f.counts.finish).toBe(1)
})
it('observes rights completed by another native owner during original wallet recovery', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true)
  f.lose('finish')
  await expect(first.buyer.advance()).rejects.toThrow('Lost original wallet')
  const recover = f.partial.payment.recover
  let other: PrivatePurchaseBuyer,
    entered = false,
    delivered: unknown
  f.partial.payment.recover = async (...args) => {
    if (!entered) {
      entered = true
      delivered = await other.advance()
    }
    return recover(...args)
  }
  const reader = await f.open(),
    writer = await f.open()
  other = writer.buyer
  expect(await reader.buyer.recover()).toEqual(delivered)
  expect((await reader.buyer.recover())?.result.status).toBe('delivered')
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  expect(f.calls).toEqual(['prepare', 'recover', 'submit'])
})
it('idempotent initialization preserves the completed original obligation', async () => {
  const f = purchaseBuyerFixture(),
    first = await f.open(true),
    delivered = await first.buyer.advance()
  await first.buyer.validate()
  const again = await PrivatePurchaseBuyer.initialize(first.ports)
  expect(await again.status()).toBe('usable')
  expect(await again.usableResult()).toEqual(delivered)
  expect(f.counts.finish).toBe(1)
  expect(f.server.counts.issue).toBe(1)
  await again.stop()
})
it.each([null, undefined, { state: 'unknown' }] as const)(
  'preserves uncertain original funding when its owner returns an unsupported outcome %p',
  async outcome => {
    const f = purchaseBuyerFixture(),
      first = await f.open(true)
    f.lose('finish')
    await expect(first.buyer.advance()).rejects.toThrow('Lost original wallet')
    f.partial.payment.recover = async () => outcome as never
    const next = await f.open()
    await expect(next.buyer.recover()).rejects.toThrow('outcome is unresolved')
    await expect(next.buyer.advance()).rejects.toThrow('outcome is unresolved')
    expect(f.counts.finish).toBe(1)
    expect(f.calls).toEqual(['prepare'])
  }
)
