import { afterEach, expect, it, jest } from '@jest/globals'
import { Beef, outputRootAdvertisementDigest, OverlayAdminTokenTemplate, Utils } from '@bsv/sdk'
import {
  SDKRootAdvertisementEvidence,
  SDKRootEvictionEvidence,
  type RootAdvertisementEvidenceInput
} from '../src/root-eviction/SDKRootEvictionEvidence.js'
import { context, resolver } from './evidence-fixture.js'
import {
  advertiser,
  minedRootEvidence,
  rootAdvertisementFixture,
  signRootEvidence
} from './root-advertisement-fixture.js'

const inputFor = (fixture: Awaited<ReturnType<typeof rootAdvertisementFixture>>) => {
  const original = fixture.body.targets[0]
  return {
    target: {
      service: original.service,
      outpoint: structuredClone(original.outpoint),
      advertisementDigest: original.advertisementDigest
    },
    advertisement: { ...original.advertisement }
  }
}
afterEach(() => {
  jest.restoreAllMocks()
})

it.each(['SHIP', 'SLAP'] as const)(
  'verifies %s locally with no peer identity, requested action or serving assertion',
  async protocol => {
    const fixture = await rootAdvertisementFixture(protocol)
    const input = inputFor(fixture),
      snapshot = context()
    const result = await new SDKRootAdvertisementEvidence(resolver).verify(input, snapshot)
    expect(result).toEqual({
      target: input.target,
      advertisement: {
        protocol,
        identityKey: advertiser,
        domain: 'https://advertisement.example',
        topicOrService: protocol === 'SHIP' ? 'tm_example' : 'ls_example'
      },
      rawAdvertisementTransaction: Utils.toBase64(fixture.transaction.toBinary()),
      verificationContext: snapshot
    })
    const peer = await new SDKRootEvictionEvidence(resolver).verify(
      signRootEvidence(fixture.body),
      0,
      snapshot
    )
    expect(peer.advertisement).toEqual(result.advertisement)
    expect(peer.rawAdvertisementTransaction).toEqual(result.rawAdvertisementTransaction)
    result.target.outpoint.txid = 'aa'.repeat(32)
    result.verificationContext.view.id = 'consumer-change'
    expect(input.target.outpoint.txid).toBe(fixture.transaction.id('hex'))
    expect(snapshot.view.id).toBe('base')
  }
)

it('rejects incomplete, extra and malformed nested fields before resolving chain evidence', async () => {
  const input = inputFor(await rootAdvertisementFixture())
  const resolve = jest.fn(resolver.resolve),
    verifier = new SDKRootAdvertisementEvidence({ resolve })
  const malformed: unknown[] = [
    null,
    {},
    { ...input, peer: advertiser },
    { ...input, target: null },
    { ...input, target: { ...input.target, action: 'suppress' } },
    { ...input, target: { ...input.target, service: 'ls_other' } },
    { ...input, target: { ...input.target, outpoint: null } },
    { ...input, target: { ...input.target, outpoint: { ...input.target.outpoint, chain: [] } } },
    {
      ...input,
      target: { ...input.target, outpoint: { ...input.target.outpoint, outputIndex: -1 } }
    },
    { ...input, advertisement: null },
    { ...input, advertisement: { ...input.advertisement, current: true } },
    { ...input, advertisement: { ...input.advertisement, beef: 'not-base64' } }
  ]
  for (const value of malformed)
    await expect(
      verifier.verify(value as RootAdvertisementEvidenceInput, context())
    ).rejects.toMatchObject({ code: 'invalid' })
  expect(resolve).not.toHaveBeenCalled()
})

it('binds exact txid, output index, protocol and script digest independently', async () => {
  const fixture = await rootAdvertisementFixture('SHIP', 2),
    input = inputFor(fixture)
  const verifier = new SDKRootAdvertisementEvidence(resolver)
  for (const advertisement of [
    { ...input.advertisement, txid: '11'.repeat(32) },
    { ...input.advertisement, outputIndex: 1 }
  ])
    await expect(verifier.verify({ ...input, advertisement }, context())).rejects.toMatchObject({
      code: 'invalid',
      message: 'Advertisement selects another output'
    })
  await expect(
    verifier.verify(
      { ...input, target: { ...input.target, advertisementDigest: '22'.repeat(32) } },
      context()
    )
  ).rejects.toMatchObject({
    code: 'invalid',
    message: 'Root advertisement digest differs from verified output'
  })
  const other = { ...input.target, service: 'ls_slap' as const }
  other.advertisementDigest = outputRootAdvertisementDigest({
    service: other.service,
    outpoint: other.outpoint,
    lockingScript: Utils.toBase64(fixture.script.toBinary())
  })
  await expect(verifier.verify({ ...input, target: other }, context())).rejects.toMatchObject({
    code: 'invalid',
    message: 'Root advertisement authentication failed'
  })
})

it('owns all caller inputs before an asynchronous chain dependency and returns their original facts', async () => {
  const fixture = await rootAdvertisementFixture(),
    input = inputFor(fixture),
    snapshot = context()
  const expected = structuredClone({ input, snapshot })
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const verifier = new SDKRootAdvertisementEvidence({
    async resolve(view, signal) {
      entered()
      await waiting
      return await resolver.resolve(view, signal)
    }
  })
  const pending = verifier.verify(input, snapshot)
  await started
  input.target.outpoint.txid = 'ff'.repeat(32)
  input.target.outpoint.chain.network = 'changed'
  input.advertisement.beef = 'AAAA'
  snapshot.view.id = 'changed'
  snapshot.limits.bytes = 1
  release()
  const result = await pending
  expect(result.target).toEqual(expected.input.target)
  expect(result.verificationContext).toEqual(expected.snapshot)
  expect(result.rawAdvertisementTransaction).toBe(Utils.toBase64(fixture.transaction.toBinary()))
})

it('returns selected ancestry placement without inventing currentness even when a spend is also known', async () => {
  const fixture = await rootAdvertisementFixture(),
    mined = minedRootEvidence(fixture)
  const input = inputFor(fixture)
  input.advertisement.beef = Utils.toBase64(fixture.transaction.toAtomicBEEF())
  const result = await new SDKRootAdvertisementEvidence(mined.chains).verify(input, mined.context)
  const height = Number(mined.context.view.tipHeight) - 1
  expect(result.advertisementPlacement).toEqual({
    height: String(height),
    blockHash: mined.extension.get(height)!.hash
  })
  expect(result.verificationContext).toEqual(mined.context)
  expect(result).not.toHaveProperty('eligible')
  expect(result).not.toHaveProperty('currentness')
})

it('preserves missing, bounded, context-change and cancellation outcomes for local callers', async () => {
  const fixture = await rootAdvertisementFixture(),
    input = inputFor(fixture)
  const verifier = new SDKRootAdvertisementEvidence(resolver)
  const missing = new Beef()
  missing.mergeTxidOnly(fixture.transaction.id('hex'))
  await expect(
    verifier.verify(
      {
        ...input,
        advertisement: { ...input.advertisement, beef: Utils.toBase64(missing.toBinary()) }
      },
      context()
    )
  ).rejects.toMatchObject({ code: 'unavailable', retryable: true })
  await expect(
    new SDKRootAdvertisementEvidence(resolver, { candidateBytes: 1 }).verify(input, context())
  ).rejects.toMatchObject({ code: 'limited', retryable: true })
  await expect(verifier.verify(input, context(), AbortSignal.abort())).rejects.toMatchObject({
    code: 'cancelled',
    retryable: true
  })
  const changed = new SDKRootAdvertisementEvidence({
    async resolve(view, signal) {
      const original = await resolver.resolve(view, signal)
      return { ...original, view: { ...original.view, id: 'changed' } }
    }
  })
  await expect(changed.verify(input, context())).rejects.toMatchObject({
    code: 'context-changed',
    retryable: true
  })
  const foreign = context()
  foreign.view.chain.genesisHash = 'ff'.repeat(32)
  await expect(verifier.verify(input, foreign)).rejects.toMatchObject({
    code: 'invalid',
    retryable: false
  })
  const resolve = jest.fn(resolver.resolve)
  await expect(
    new SDKRootAdvertisementEvidence({ resolve }).verify(
      { ...input, advertisement: { ...input.advertisement, beef: 'A'.repeat(1048577) } },
      context()
    )
  ).rejects.toMatchObject({ code: 'limited' })
  expect(resolve).not.toHaveBeenCalled()
})

it('does not expose a positive result after cancellation during advertisement authentication', async () => {
  const input = inputFor(await rootAdvertisementFixture()),
    controller = new AbortController()
  const decode = OverlayAdminTokenTemplate.decodeAndVerify
  jest.spyOn(OverlayAdminTokenTemplate, 'decodeAndVerify').mockImplementation(async (...args) => {
    const result = await decode(...args)
    controller.abort()
    return result
  })
  await expect(
    new SDKRootAdvertisementEvidence(resolver).verify(input, context(), controller.signal)
  ).rejects.toMatchObject({
    code: 'cancelled',
    retryable: true,
    message: 'Root evidence verification cancelled'
  })
})
