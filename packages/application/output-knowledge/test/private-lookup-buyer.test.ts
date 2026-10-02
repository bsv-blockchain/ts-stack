import { afterEach, expect, it, jest } from '@jest/globals'
import { PrivateLookupBuyer } from '../src/private/PrivateLookupBuyer.js'
import { buyerFixture } from './private-lookup-buyer.fixture.js'
import { buyerRemote } from './private-lookup-buyer-transport.fixture.js'
afterEach(() => {
  jest.restoreAllMocks()
})
it('retains originals and complete capacity before paying, then separates receipt, validation and usability', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f),
    owner = await f.open(true)
  expect(await owner.buyer.status()).toBe('ready')
  expect(f.counts.finish).toBe(0)
  expect(await owner.buyer.advance()).toEqual(wire.delivered)
  expect(await owner.buyer.status()).toBe('received')
  await expect(owner.buyer.usableResult()).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.counts).toMatchObject({ plan: 1, finish: 1, verify: 0 })
  f.setUsable(false)
  expect(await owner.buyer.validate()).toBe('validated')
  f.setUsable(true)
  expect(await owner.buyer.validate()).toBe('usable')
  expect(await owner.buyer.status()).toBe('usable')
  expect(await owner.buyer.advance()).toEqual(wire.delivered)
  expect(await owner.buyer.status()).toBe('usable')
  expect(await owner.buyer.usableResult()).toEqual(wire.delivered)
  f.setUsable(false)
  await expect(owner.buyer.usableResult()).rejects.toMatchObject({ code: 'unavailable' })
  f.setUsable(true)
  const reopened = await f.open()
  expect(await reopened.buyer.recover()).toEqual(wire.delivered)
  expect(await reopened.buyer.status()).toBe('usable')
  expect(wire.calls).toEqual(['quote', 'pay'])
  expect(f.counts.finish).toBe(1)
  wire.send.mockRestore()
})
it.each(['quote', 'pay'] as const)(
  'recovers a lost %s reply after reopen without a new payment or paid dispatch',
  async lost => {
    const f = await buyerFixture(),
      wire = buyerRemote(f),
      owner = await f.open(true)
    wire.lose(lost)
    await expect(owner.buyer.advance()).rejects.toThrow('Lost original')
    f.setNow('200')
    const reopened = await f.open(),
      recovered = await reopened.buyer.recover()
    expect(recovered?.status).toBe(lost === 'quote' ? 'quoted' : 'delivered')
    expect(f.counts.finish).toBe(lost === 'quote' ? 0 : 1)
    expect(wire.calls.filter(value => value === 'pay')).toHaveLength(lost === 'quote' ? 0 : 1)
    if (lost === 'quote')
      await expect(reopened.buyer.advance()).rejects.toMatchObject({ code: 'expired' })
    wire.send.mockRestore()
  }
)
it('retains an unusable first result and never replaces its originals or pays again', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f),
    owner = await f.open(true)
  await owner.buyer.advance()
  f.setValid(false)
  await expect(owner.buyer.validate()).rejects.toThrow('material is invalid')
  expect(await owner.buyer.status()).toBe('received')
  expect(await owner.buyer.recover()).toEqual(wire.delivered)
  expect(f.counts.finish).toBe(1)
  wire.send.mockRestore()
})
it('opens only existing original state and rejects changed bindings and revoked access before effects', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f),
    owner = await f.open(true)
  await expect(
    PrivateLookupBuyer.open({
      ...owner.ports,
      original: { ...owner.ports.original, derivationSuffix: 'changed' }
    })
  ).rejects.toMatchObject({ code: 'context-changed' })
  f.setAccess(false)
  await expect(owner.buyer.advance()).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(owner.buyer.recover()).rejects.toMatchObject({ code: 'unauthorized' })
  expect(wire.calls).toEqual([])
  expect(f.counts.finish).toBe(0)
  wire.send.mockRestore()
})
it('recovers a wallet commit whose reply was lost without another signing operation', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f),
    owner = await f.open(true),
    finish = owner.ports.payment.finish
  const interrupted = jest
    .spyOn(owner.ports.payment, 'finish')
    .mockImplementation(async (...args) => {
      await finish(...args)
      throw new Error('Lost wallet commit')
    })
  // Pins deliberately reject replacement capabilities; install the wrapper before opening a new owner.
  const reopened = await f.open()
  await expect(reopened.buyer.advance()).rejects.toThrow('Lost wallet commit')
  interrupted.mockRestore()
  f.setNow('200')
  const restored = await f.open()
  expect((await restored.buyer.recover())?.status).toBe('quoted')
  expect(await restored.buyer.status()).toBe('paid')
  expect(f.counts.finish).toBe(1)
  expect(wire.calls.filter(operation => operation === 'pay')).toEqual([])
})
it('holds physical capacity after cancellation and drains verification before closing custody', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f)
  let release = () => {},
    entered = () => {}
  const blocked = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  jest.spyOn(f.partial.validation, 'verify').mockImplementation(async () => {
    entered()
    await blocked
  })
  const owner = await f.open(true)
  await owner.buyer.advance()
  const cancellation = new AbortController(),
    validation = owner.buyer.validate(cancellation.signal)
  await started
  cancellation.abort()
  await expect(validation).rejects.toMatchObject({ code: 'cancelled' })
  await expect(owner.buyer.recover()).rejects.toMatchObject({ code: 'limited' })
  let drained = false
  const stop = owner.buyer.stop().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await stop
  const reopened = await f.open()
  expect(await reopened.buyer.status()).toBe('received')
  expect(f.counts.finish).toBe(1)
  wire.send.mockRestore()
})
it('rejects installation replacement and access withdrawal during independent validation', async () => {
  const f = await buyerFixture(),
    wire = buyerRemote(f)
  jest.spyOn(f.partial.validation, 'verify').mockImplementation(async () => {
    await Promise.resolve()
    f.setAccess(false)
  })
  const owner = await f.open(true)
  await owner.buyer.advance()
  await expect(owner.buyer.validate()).rejects.toMatchObject({ code: 'unauthorized' })
  f.setAccess(true)
  expect(await owner.buyer.status()).toBe('received')
  const replaced = jest.spyOn(owner.ports.payment, 'recover').mockResolvedValue({ state: 'absent' })
  await expect(owner.buyer.recover()).rejects.toMatchObject({ code: 'context-changed' })
  expect(replaced).not.toHaveBeenCalled()
  expect(f.counts.finish).toBe(1)
  wire.send.mockRestore()
})
