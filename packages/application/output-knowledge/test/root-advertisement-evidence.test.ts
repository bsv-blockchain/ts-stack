import { afterEach, expect, it, jest } from '@jest/globals'
import {
  Beef,
  outputRootAdvertisementDigest,
  OverlayAdminTokenTemplate,
  PrivateKey,
  Transaction,
  Utils
} from '@bsv/sdk'
import { SDKRootEvictionEvidence } from '../src/root-eviction/SDKRootEvictionEvidence.js'
import { context, resolver, transactions } from './evidence-fixture.js'
import {
  advertiser,
  minedRootEvidence,
  rootAdvertisementFixture,
  signRootEvidence
} from './root-advertisement-fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

it('requires the exact output index while allowing other valid inputs in a consuming transaction', async () => {
  const { body, transaction, spend } = await rootAdvertisementFixture('SHIP', 2)
  const verifier = new SDKRootEvictionEvidence(resolver)
  const anotherInput = { ...spend.inputs[0], sourceTransaction: transaction, sourceOutputIndex: 1 }
  const wrong = new Transaction(1, [anotherInput], spend.outputs, 0)
  await wrong.sign()
  body.targets[0].evidence = {
    kind: 'spent',
    txid: wrong.id('hex'),
    beef: Utils.toBase64(wrong.toAtomicBEEF())
  }
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  const together = new Transaction(
    1,
    [{ ...spend.inputs[0] }, { ...anotherInput }],
    spend.outputs,
    0
  )
  await together.sign()
  body.targets[0].evidence = {
    kind: 'spent',
    txid: together.id('hex'),
    beef: Utils.toBase64(together.toAtomicBEEF())
  }
  expect((await verifier.verify(signRootEvidence(body), 0, context())).proof).toEqual({
    kind: 'spent',
    rawTransaction: Utils.toBase64(together.toBinary())
  })
})

it('does not return verified facts after cancellation arrives during advertisement authentication', async () => {
  const { body } = await rootAdvertisementFixture()
  body.targets[0].evidence = {
    kind: 'operator-policy',
    policy: 'manual',
    detailDigest: '33'.repeat(32)
  }
  const controller = new AbortController(),
    decode = OverlayAdminTokenTemplate.decodeAndVerify
  jest.spyOn(OverlayAdminTokenTemplate, 'decodeAndVerify').mockImplementation(async (...args) => {
    const result = await decode(...args)
    controller.abort()
    return result
  })
  await expect(
    new SDKRootEvictionEvidence(resolver).verify(
      signRootEvidence(body),
      0,
      context(),
      controller.signal
    )
  ).rejects.toMatchObject({
    code: 'cancelled',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
})

it('preserves retryable context change when the resolver supplies another immutable view', async () => {
  const { body } = await rootAdvertisementFixture()
  const changed = {
    async resolve(view: Parameters<typeof resolver.resolve>[0], signal: AbortSignal) {
      const original = await resolver.resolve(view, signal)
      return { ...original, view: { ...original.view, id: 'different-view' } }
    }
  }
  await expect(
    new SDKRootEvictionEvidence(changed).verify(signRootEvidence(body), 0, context())
  ).rejects.toMatchObject({
    code: 'context-changed',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
})

it('retains exact mined placements from the selected ancestry without treating inclusion as currentness', async () => {
  const fixture = await rootAdvertisementFixture()
  const mined = minedRootEvidence(fixture)
  const { body, transaction, spend } = fixture
  const selected = await mined.chains.resolve(mined.context.view, new AbortController().signal)
  await expect(
    transaction.merklePath!.verify(transaction.id('hex'), selected.tracker)
  ).resolves.toBe(true)
  await expect(spend.merklePath!.verify(spend.id('hex'), selected.tracker)).resolves.toBe(true)
  body.targets[0].advertisement.beef = Utils.toBase64(transaction.toAtomicBEEF())
  body.targets[0].evidence = {
    kind: 'spent',
    txid: spend.id('hex'),
    beef: Utils.toBase64(spend.toAtomicBEEF())
  }
  const result = await new SDKRootEvictionEvidence(mined.chains).verify(
    signRootEvidence(body),
    0,
    mined.context
  )
  const tip = Number(mined.context.view.tipHeight)
  expect(result.advertisementPlacement).toEqual({
    height: String(tip - 1),
    blockHash: mined.extension.get(tip - 1)!.hash
  })
  expect(result.proof).toEqual({
    kind: 'spent',
    rawTransaction: Utils.toBase64(spend.toBinary()),
    placement: { height: String(tip), blockHash: mined.context.view.tipHash }
  })
  expect(result).not.toHaveProperty('eligible')
})

it.each(['SHIP', 'SLAP'] as const)(
  'verifies actual %s advertisement bytes and advertiser authority without deciding serving eligibility',
  async protocol => {
    const { body, transaction } = await rootAdvertisementFixture(protocol)
    const snapshot = context()
    const evidence = await new SDKRootEvictionEvidence(resolver).verify(
      signRootEvidence(body),
      0,
      snapshot
    )
    expect(evidence.advertisement).toEqual({
      protocol,
      identityKey: advertiser,
      domain: 'https://advertisement.example',
      topicOrService: protocol === 'SHIP' ? 'tm_example' : 'ls_example'
    })
    expect(evidence.proof).toEqual({ kind: 'owner-withdrawal', advertiser })
    expect(evidence.rawAdvertisementTransaction).toBe(Utils.toBase64(transaction.toBinary()))
    expect(evidence.verificationContext).toEqual(snapshot)
    expect(evidence.advertisementPlacement).toBeUndefined()
    evidence.verificationContext.view.id = 'consumer-change'
    evidence.target.outpoint.txid = 'ff'.repeat(32)
    expect(snapshot.view.id).toBe('base')
    expect(body.targets[0].outpoint.txid).toBe(transaction.id('hex'))
  }
)

it('verifies the actual consuming transaction and rejects a valid transaction that spends another output', async () => {
  const { body, spend } = await rootAdvertisementFixture()
  const verifier = new SDKRootEvictionEvidence(resolver)
  body.targets[0].evidence = {
    kind: 'spent',
    txid: spend.id('hex'),
    beef: Utils.toBase64(spend.toAtomicBEEF())
  }
  expect((await verifier.verify(signRootEvidence(body), 0, context())).proof).toEqual({
    kind: 'spent',
    rawTransaction: Utils.toBase64(spend.toBinary())
  })
  const unrelated = transactions.get('A')!
  body.targets[0].evidence = {
    kind: 'spent',
    txid: unrelated.id('hex'),
    beef: Utils.toBase64(unrelated.toAtomicBEEF())
  }
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
})

it('retains an operator-policy reference as unassessed and never treats its text as a resolver URL', async () => {
  const { body } = await rootAdvertisementFixture()
  body.targets[0].evidence = {
    kind: 'operator-policy',
    policy: 'https://unfetched.example/local-rule',
    detailDigest: '42'.repeat(32)
  }
  const result = await new SDKRootEvictionEvidence(resolver).verify(
    signRootEvidence(body),
    0,
    context()
  )
  expect(result.proof).toEqual(body.targets[0].evidence)
  expect(result).not.toHaveProperty('eligible')
})

it('checks both owner proof variants and accepts different BEEF packaging only for the same raw advertisement', async () => {
  const { body, transaction } = await rootAdvertisementFixture()
  const variant = Beef.fromBinary(transaction.toBEEF())
  variant.mergeBeef(transactions.get('A')!.toBEEF())
  body.targets[0].evidence = {
    kind: 'owner-withdrawal',
    advertisement: { ...body.targets[0].advertisement, beef: Utils.toBase64(variant.toBinary()) }
  }
  const verifier = new SDKRootEvictionEvidence(resolver)
  expect((await verifier.verify(signRootEvidence(body), 0, context())).proof.kind).toBe(
    'owner-withdrawal'
  )
  const missing = new Beef()
  missing.mergeTxidOnly(transaction.id('hex'))
  body.targets[0].evidence.advertisement.beef = Utils.toBase64(missing.toBinary())
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'unavailable',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
})

it('rejects an authenticated other requester, a changed signed body and a mismatched advertisement digest', async () => {
  const { body } = await rootAdvertisementFixture()
  const verifier = new SDKRootEvictionEvidence(resolver),
    outsider = new PrivateKey(83)
  const changed = { ...body, requester: outsider.toPublicKey().toString() }
  await expect(
    verifier.verify(signRootEvidence(changed, outsider), 0, context())
  ).rejects.toMatchObject({
    code: 'unauthorized',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  const packet = signRootEvidence(body)
  packet.body.reason = 'changed-after-signing'
  await expect(verifier.verify(packet, 0, context())).rejects.toMatchObject({
    code: 'unauthorized',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  body.targets[0].advertisementDigest = 'ff'.repeat(32)
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
})

it('checks the service format and rejects a real Bitcoin output that is not an authenticated advertisement', async () => {
  const { body } = await rootAdvertisementFixture()
  const verifier = new SDKRootEvictionEvidence(resolver)
  body.targets[0].service = 'ls_slap'
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  const unrelated = transactions.get('A')!
  const outpoint = { ...body.targets[0].outpoint, txid: unrelated.id('hex') }
  const advertisement = {
    txid: outpoint.txid,
    outputIndex: 0,
    beef: Utils.toBase64(unrelated.toAtomicBEEF())
  }
  body.targets[0] = {
    service: 'ls_ship',
    outpoint,
    advertisement,
    advertisementDigest: outputRootAdvertisementDigest({
      service: 'ls_ship',
      outpoint,
      lockingScript: Utils.toBase64(unrelated.outputs[0].lockingScript.toBinary())
    }),
    evidence: { kind: 'owner-withdrawal', advertisement }
  }
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
})

it('checks actual spending Script rather than accepting just the claimed consuming input', async () => {
  const { body, spend } = await rootAdvertisementFixture()
  const bad = new Transaction(
    spend.version,
    spend.inputs,
    [{ ...spend.outputs[0], satoshis: 2 }],
    spend.lockTime
  )
  body.targets[0].evidence = {
    kind: 'spent',
    txid: bad.id('hex'),
    beef: Utils.toBase64(bad.toAtomicBEEF())
  }
  await expect(
    new SDKRootEvictionEvidence(resolver).verify(signRootEvidence(body), 0, context())
  ).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
})

it('preserves cancellation, missing evidence, deadline and chain-view failures without returning verified facts', async () => {
  const { body, transaction } = await rootAdvertisementFixture()
  const verifier = new SDKRootEvictionEvidence(resolver),
    packet = signRootEvidence(body)
  await expect(verifier.verify(packet, -1, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  await expect(verifier.verify(packet, 1, context())).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  await expect(verifier.verify(packet, 0, context(), AbortSignal.abort())).rejects.toMatchObject({
    code: 'cancelled',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
  const expired = context()
  expired.now = '0'
  expired.limits.deadline = '1'
  await expect(verifier.verify(packet, 0, expired)).rejects.toMatchObject({
    code: 'limited',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
  const foreign = structuredClone(context())
  foreign.view.chain.genesisHash = 'ff'.repeat(32)
  await expect(verifier.verify(packet, 0, foreign)).rejects.toMatchObject({
    code: 'invalid',
    retryable: false,
    message: expect.stringMatching(/\S/)
  })
  const missing = new Beef()
  missing.mergeTxidOnly(transaction.id('hex'))
  body.targets[0].advertisement.beef = Utils.toBase64(missing.toBinary())
  await expect(verifier.verify(signRootEvidence(body), 0, context())).rejects.toMatchObject({
    code: 'unavailable',
    retryable: true,
    message: expect.stringMatching(/\S/)
  })
})
