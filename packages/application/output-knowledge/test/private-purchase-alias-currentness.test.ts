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

import { jest } from '@jest/globals'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import type { VerificationResult } from '../src/ports.js'

it.each(['resolve', 'context', 'current', 'async-current'])(
  'refuses the missing or asynchronous installed alias capability %s',
  field => {
    const f = aliasCurrentnessFixture(),
      chains = { ...f.chains },
      selection = { ...f.selection }
    if (field === 'resolve') chains.resolve = undefined as never
    if (field === 'context') selection.context = undefined as never
    if (field === 'current') selection.current = undefined as never
    if (field === 'async-current') selection.current = (async () => true) as never
    const message =
      field === 'resolve'
        ? 'Selected alias ancestry is required'
        : field === 'context'
          ? 'Selected alias context is required'
          : 'Selected alias authority must be synchronous'
    expect(() => new SDKPrivatePurchaseAliasCurrentness(chains, selection)).toThrow(message)
  }
)

it.each(['resolve', 'context', 'current'] as const)(
  'rejects replacement of only the installed alias %s capability',
  async field => {
    const f = aliasCurrentnessFixture()
    if (field === 'resolve') f.chains.resolve = f.chains.resolve.bind(f.chains)
    if (field === 'context') f.selection.context = f.selection.context.bind(f.selection)
    if (field === 'current') f.selection.current = f.selection.current.bind(f.selection)
    await expect(f.adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Selected alias chain capability changed'
    })
    expect(f.counts().resolutions).toBe(0)
  }
)

it.each(['resolve', 'context', 'current'] as const)(
  'fences a capability changed by the synchronous selected-authority %s callback',
  async field => {
    const f = aliasCurrentnessFixture(),
      current = f.selection.current
    f.selection.current = snapshot => {
      const result = current(snapshot)
      if (field === 'resolve') f.chains.resolve = f.chains.resolve.bind(f.chains)
      if (field === 'context') f.selection.context = f.selection.context.bind(f.selection)
      if (field === 'current') f.selection.current = current
      return result
    }
    const adapter = new SDKPrivatePurchaseAliasCurrentness(f.chains, f.selection)
    await expect(adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Selected alias chain capability changed'
    })
    expect(f.counts().resolutions).toBe(0)
  }
)

it('drains a promised selected-authority rejection without treating it as currentness', async () => {
  const f = aliasCurrentnessFixture()
  f.selection.current = (() => Promise.reject(new Error('deferred selected authority'))) as never
  const adapter = new SDKPrivatePurchaseAliasCurrentness(f.chains, f.selection)
  await expect(adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Selected alias ancestry changed'
  })
  expect(f.counts().resolutions).toBe(0)
})

it('rejects the exact selected-authority deadline before consulting ancestry', async () => {
  const f = aliasCurrentnessFixture(),
    snapshot = await f.selection.context()
  f.selection.context = async () => snapshot
  const adapter = new SDKPrivatePurchaseAliasCurrentness(f.chains, f.selection),
    now = jest.spyOn(Date, 'now').mockReturnValue(Number(BigInt(snapshot.limits.deadline) * 1000n))
  try {
    await expect(adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
      code: 'limited',
      message: 'Selected alias assessment deadline elapsed'
    })
    expect(f.counts().resolutions).toBe(0)
  } finally {
    now.mockRestore()
  }
})

// Deliberate verifier-port fault injection, after a complete genuine SDK
// verification. These tests assert adapter custody; they do not attest the
// altered result as Script/SPV evidence or replace the real fixture qualification.
it.each(['context', 'variant', 'transaction', 'chain', 'height'] as const)(
  'refuses a verified response changed at its %s binding boundary',
  async field => {
    const f = aliasCurrentnessFixture(),
      original = SDKEvidenceVerifier.prototype.verify,
      verify = jest.spyOn(SDKEvidenceVerifier.prototype, 'verify')
    verify.mockImplementationOnce(async function (this: SDKEvidenceVerifier, ...args) {
      const result = await original.apply(this, args)
      if (result.status !== 'verified') throw new Error('Genuine fixture did not verify')
      const changed = structuredClone(result)
      if (field === 'context') changed.contextId += '-foreign'
      if (field === 'variant') changed.variantId = 'aa'.repeat(32)
      if (field === 'transaction') changed.fact.txid = 'aa'.repeat(32)
      if (field === 'chain') changed.fact.chain.network = 'foreign-chain'
      if (field === 'height') {
        if (!changed.placement) throw new Error('Genuine fixture placement missing')
        changed.placement.height = (BigInt(args[1].view.tipHeight) + 1n).toString()
      }
      return changed
    })
    try {
      await expect(f.adapter.assess(f.subject, f.submit(), signal())).rejects.toMatchObject({
        code: field === 'height' ? 'invalid' : 'context-changed',
        message:
          field === 'height'
            ? 'Selected alias inclusion is above the selected tip'
            : 'Selected alias verification subject changed'
      })
    } finally {
      verify.mockRestore()
    }
  }
)

it.each(['invalid', 'cancelled', 'context-changed', 'unresolved', 'limited'] as const)(
  'preserves the verifier %s status without inventing currentness',
  async status => {
    const f = aliasCurrentnessFixture(),
      verify = jest.spyOn(SDKEvidenceVerifier.prototype, 'verify')
    verify.mockImplementationOnce(async (candidate, snapshot): Promise<VerificationResult> => ({
      status,
      contextId: snapshot.id,
      variantId: candidate.variantId,
      reason: 'Explicit verifier-port failure injection',
      dependencies: []
    }))
    try {
      const assessment = f.adapter.assess(f.subject, f.submit(), signal())
      if (status === 'unresolved' || status === 'limited') expect(await assessment).toBeUndefined()
      else
        await expect(assessment).rejects.toMatchObject({
          code: status,
          message: 'Selected alias verification ' + status,
          retryable: status !== 'invalid'
        })
    } finally {
      verify.mockRestore()
    }
  }
)
