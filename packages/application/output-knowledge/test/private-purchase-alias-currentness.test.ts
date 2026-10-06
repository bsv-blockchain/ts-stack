import { expect, it } from '@jest/globals'
import { Beef, Utils } from '@bsv/sdk'
import { SDKPrivatePurchaseAliasCurrentness } from '../src/private/SDKPrivatePurchaseAliasCurrentness.js'
import { aliasCurrentnessFixture } from './private-purchase-alias-currentness.fixture.js'
import { context, corpus, resolver } from './evidence-fixture.js'

const signal = () => new AbortController().signal

it('authenticates exact-subject inclusion and returns an immutable detached currentness report', async () => {
  const f = aliasCurrentnessFixture(),
    input = f.submit()
  const report = (await f.adapter.assess(f.subject, input, signal()))!
  expect(report.currentAlias).toEqual({ txid: input.txid, beef: input.beef })
  expect(report.height).toBe('102')
  expect(report.blockHash).toBe(context('included').view.tipHash)
  expect(Object.isFrozen(report)).toBe(true)
  expect(Object.isFrozen(report.currentAlias)).toBe(true)
  input.beef = 'AA=='
  expect(report.currentAlias.beef).toBe(corpus.inclusion.beef)
  expect(() => report.placement.checkCurrent()).not.toThrow()
})

it('does not confuse Script-valid unmined evidence or missing raw dependencies with mined currentness', async () => {
  const f = aliasCurrentnessFixture()
  expect(await f.adapter.assess(f.subject, f.submit(false), signal())).toBeUndefined()
  const only = new Beef()
  only.mergeTxidOnly(f.submit().txid)
  expect(
    await f.adapter.assess(
      f.subject,
      { ...f.submit(), beef: Utils.toBase64(only.toBinary()) },
      signal()
    )
  ).toBeUndefined()
})

it('keeps unavailable ancestry distinct from invalid inclusion and performs a fresh assessment after recovery', async () => {
  const f = aliasCurrentnessFixture()
  f.available(false)
  expect(await f.adapter.assess(f.subject, f.submit(), signal())).toBeUndefined()
  f.available(true)
  expect(await f.adapter.assess(f.subject, f.submit(), signal())).toBeDefined()
  f.select('fork')
  await expect(f.adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
    code: 'invalid'
  })
  expect(f.counts()).toEqual({ contexts: 3, resolutions: 3 })
})

it('invalidates an earlier report across selected-ancestry changes without caching a verdict', async () => {
  const f = aliasCurrentnessFixture()
  const first = (await f.adapter.assess(f.subject, f.submit(), signal()))!
  f.select('fork')
  expect(() => first.placement.checkCurrent()).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  f.select('included')
  expect(() => first.placement.checkCurrent()).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  const second = (await f.adapter.assess(f.subject, f.submit(), signal()))!
  expect(second.contextId).not.toBe(first.contextId)
  expect(() => second.placement.checkCurrent()).not.toThrow()
  expect(f.counts()).toEqual({ contexts: 2, resolutions: 2 })
})

it('refuses a selected view changed during exact Script/SPV verification', async () => {
  const f = aliasCurrentnessFixture(),
    original = f.chains.resolve
  f.chains.resolve = async (view, abort) => {
    const v = await original.call(f.chains, view, abort)
    f.select('fork')
    return v
  }
  const adapter = new SDKPrivatePurchaseAliasCurrentness(f.chains, f.selection)
  await expect(adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
    code: 'context-changed'
  })
})

it('refuses foreign acquisition and chain before a chain resolver can contribute authority', async () => {
  const f = aliasCurrentnessFixture()
  await expect(
    f.adapter.assess(f.subject, { ...f.submit(), acquisitionId: 'be'.repeat(32) }, signal())
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    f.adapter.assess(
      { ...f.subject, chain: { ...f.subject.chain, network: 'another-chain' } },
      f.submit(),
      signal()
    )
  ).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.counts().resolutions).toBe(0)
})

it('refuses cancelled, expired and replaced installed capabilities without retaining a current verdict', async () => {
  const f = aliasCurrentnessFixture(),
    abort = new AbortController()
  abort.abort()
  await expect(f.adapter.assess(f.subject, f.submit(), abort.signal)).rejects.toMatchObject({
    code: 'cancelled'
  })
  const original = f.selection.context
  f.selection.context = async () => {
    const c = await original.call(f.selection)
    c.now = '0'
    c.limits.deadline = '1'
    return c
  }
  const expired = new SDKPrivatePurchaseAliasCurrentness(f.chains, f.selection)
  await expect(expired.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
    code: 'limited'
  })
  f.selection.context = original
  f.chains.resolve = resolver.resolve
  await expect(f.adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
    code: 'context-changed'
  })
})

it('rechecks cancellation at the native placement guard after a successful assessment', async () => {
  const f = aliasCurrentnessFixture(),
    abort = new AbortController()
  const report = (await f.adapter.assess(f.subject, f.submit(), abort.signal))!
  abort.abort()
  expect(() => report.placement.checkCurrent()).toThrow(
    expect.objectContaining({ code: 'cancelled' })
  )
})
