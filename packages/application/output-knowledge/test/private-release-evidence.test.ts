import { expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  OUTPUT_PROCESSOR_ATTESTATION_POLICY,
  PrivateKey,
  signOutputPacket,
  Utils,
  type OutputReleaseEvidence
} from '@bsv/sdk'
import { SDKPrivateReleaseEvidence } from '../src/private/SDKPrivateReleaseEvidence.js'
import { context, corpus, resolver, chain, candidate } from './evidence-fixture.js'
const signal = () => new AbortController().signal
const txid = corpus.transactions[corpus.inclusion.name].txid

it('accepts actual covenant purchase inclusion beyond 64 KiB while preserving the complete envelope and caller limits', async () => {
  const { purchaseFixture } = await import('./revenue-purchase.fixture.js'),
    { minedChain } = await import('./revenue-lineage-fixture.js'),
    { MerklePath } = await import('@bsv/sdk'),
    f = await purchaseFixture(),
    selected = minedChain(f.purchase.txid)
  f.completed.merklePath = new MerklePath(1, [[{ offset: 0, hash: f.purchase.txid, txid: true }]])
  const beef = f.completed.toAtomicBEEF(),
    view = await selected.chains.resolve(selected.context.view, signal()),
    header = await view.header(1, signal()),
    evidence: OutputReleaseEvidence = {
      chain: f.original.request.listing.chain,
      txid: f.purchase.txid,
      policy: { kind: 'mined', confirmations: 100 },
      acceptedAt: '20',
      blockEvidence: {
        blockHash: header.hash,
        height: '1',
        tipHash: selected.context.view.tipHash,
        tipHeight: selected.context.view.tipHeight,
        beef: Utils.toBase64(beef),
        contextId: selected.context.id,
        chainPolicyDigest: selected.context.view.chainPolicyDigest
      }
    },
    expected = { chain: evidence.chain, txid: evidence.txid, policy: evidence.policy },
    verifier = new SDKPrivateReleaseEvidence(selected.chains)
  expect(beef.length).toBeGreaterThan(65536)
  expect(Buffer.byteLength(canonicalOutputJSON(evidence))).toBeLessThan(131072)
  let current = true
  const assessment = await verifier.verify(
    evidence,
    expected,
    {
      now: '30',
      verification: selected.context,
      current: () => current
    },
    signal()
  )
  expect(assessment.evidence).toEqual(evidence)
  assessment.checkCurrent()
  current = false
  expect(() => assessment.checkCurrent()).toThrow(
    expect.objectContaining({ code: 'context-changed' })
  )
  const narrowed = structuredClone(selected.context)
  narrowed.limits.bytes = beef.length - 1
  await expect(
    verifier.verify(
      evidence,
      expected,
      {
        now: '30',
        verification: narrowed,
        current: () => true
      },
      signal()
    )
  ).rejects.toThrow(expect.objectContaining({ code: 'limited' }))
}, 30000)
function local() {
  const evidence = { chain, txid, policy: { kind: 'local-admission' as const }, acceptedAt: '20' }
  const expected = { chain, txid, policy: evidence.policy }
  return { evidence, expected, premises: { now: '30', localAcceptedAt: '20', current: () => true } }
}
async function mined() {
  const snapshot = context('included')
  const view = await resolver.resolve(snapshot.view, signal())
  const target = (await import('@bsv/sdk')).Transaction.fromAtomicBEEF(
    Utils.toArray(corpus.inclusion.beef, 'base64')
  )
  const height = target.merklePath!.blockHeight
  const header = await view.header(height, signal())
  const evidence: OutputReleaseEvidence = {
    chain,
    txid,
    policy: { kind: 'mined', confirmations: 1 },
    acceptedAt: '20',
    blockEvidence: {
      blockHash: header.hash,
      height: String(height),
      tipHash: snapshot.view.tipHash,
      tipHeight: snapshot.view.tipHeight,
      beef: corpus.inclusion.beef,
      contextId: snapshot.id,
      chainPolicyDigest: snapshot.view.chainPolicyDigest
    }
  }
  return {
    evidence,
    expected: { chain, txid, policy: evidence.policy },
    premises: { now: '30', verification: snapshot, current: () => true }
  }
}
it('requires exact durable local acceptance and retains a guard for the commit boundary', async () => {
  const f = local(),
    verifier = new SDKPrivateReleaseEvidence(resolver)
  let current = true
  const checked = await verifier.verify(
    f.evidence,
    f.expected,
    { ...f.premises, current: () => current },
    signal()
  )
  expect(checked.evidence).toEqual(f.evidence)
  checked.checkCurrent()
  current = false
  expect(() => checked.checkCurrent()).toThrow('context changed')
  await expect(
    verifier.verify(f.evidence, f.expected, { ...f.premises, localAcceptedAt: undefined }, signal())
  ).rejects.toThrow('durable acceptance')
  await expect(
    verifier.verify(f.evidence, f.expected, { ...f.premises, localAcceptedAt: '19' }, signal())
  ).rejects.toThrow('durable acceptance')
})
it('verifies the installed processor identity and exact signed statement', async () => {
  const key = new PrivateKey(91),
    policy = {
      kind: 'processor-accepted' as const,
      identity: key.toPublicKey().toString(),
      policy: OUTPUT_PROCESSOR_ATTESTATION_POLICY
    }
  const packet = signOutputPacket(
    'processor-acceptance',
    { version: 1, chain, txid, policy: policy.policy, acceptedAt: '20' },
    key
  )
  const evidence = {
    chain,
    txid,
    policy,
    acceptedAt: '20',
    processorEvidence: Utils.toBase64(Utils.toArray(canonicalOutputJSON(packet), 'utf8'))
  }
  const verifier = new SDKPrivateReleaseEvidence(resolver),
    expected = { chain, txid, policy }
  expect(
    (await verifier.verify(evidence, expected, { now: '30', current: () => true }, signal()))
      .evidence
  ).toEqual(evidence)
  const different = { ...policy, identity: new PrivateKey(92).toPublicKey().toString() }
  await expect(
    verifier.verify(
      { ...evidence, policy: different },
      { ...expected, policy: different },
      { now: '30', current: () => true },
      signal()
    )
  ).rejects.toThrow('Unexpected packet signer')
})
it('checks actual target inclusion against the selected verified ancestry', async () => {
  const f = await mined(),
    verifier = new SDKPrivateReleaseEvidence(resolver)
  const checked = await verifier.verify(f.evidence, f.expected, f.premises, signal())
  expect(checked.evidence).toEqual(f.evidence)
  checked.checkCurrent()
})
it.each([
  'contextId',
  'chainPolicyDigest',
  'tipHash',
  'tipHeight',
  'blockHash',
  'height',
  'beef'
] as const)('refuses mismatched mined %s', async field => {
  const f = await mined(),
    block = f.evidence.blockEvidence!
  if (field === 'tipHeight' || field === 'height') block[field] = String(BigInt(block[field]) + 1n)
  else if (field === 'contextId') block.contextId = 'another-context'
  else if (field === 'beef') block.beef = candidate('A').evidence.beef
  else block[field] = '99'.repeat(32)
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(f.evidence, f.expected, f.premises, signal())
  ).rejects.toThrow()
})
it('does not accept a mined assertion on a competing ancestry or erase the old assessment', async () => {
  const f = await mined(),
    verifier = new SDKPrivateReleaseEvidence(resolver)
  let current = true
  const historical = await verifier.verify(
    f.evidence,
    f.expected,
    { ...f.premises, current: () => current },
    signal()
  )
  current = false
  expect(() => historical.checkCurrent()).toThrow('context changed')
  expect(historical.evidence).toEqual(f.evidence)
  const fork = context('fork'),
    block = f.evidence.blockEvidence!
  Object.assign(block, {
    tipHash: fork.view.tipHash,
    tipHeight: fork.view.tipHeight,
    contextId: fork.id,
    chainPolicyDigest: fork.view.chainPolicyDigest
  })
  await expect(
    verifier.verify(f.evidence, f.expected, { ...f.premises, verification: fork }, signal())
  ).rejects.toMatchObject({ code: 'invalid' })
})
it('keeps absent or unavailable ancestry unresolved', async () => {
  const f = await mined()
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(
      f.evidence,
      f.expected,
      { ...f.premises, verification: undefined },
      signal()
    )
  ).rejects.toMatchObject({ code: 'unavailable' })
  const offline = new SDKPrivateReleaseEvidence({
    resolve: async () => {
      throw new Error('private tracker detail')
    }
  })
  await expect(offline.verify(f.evidence, f.expected, f.premises, signal())).rejects.toMatchObject({
    code: 'limited',
    message: 'Mined release verification limited'
  })
})
it('preserves selected confirmation count and refuses future acceptance or expired work', async () => {
  const f = await mined(),
    verifier = new SDKPrivateReleaseEvidence(resolver)
  f.evidence.policy = { kind: 'mined', confirmations: 100 }
  await expect(
    verifier.verify(f.evidence, { ...f.expected, policy: f.evidence.policy }, f.premises, signal())
  ).rejects.toThrow('confirmation')
  const l = local()
  await expect(
    verifier.verify(l.evidence, l.expected, { ...l.premises, now: '19' }, signal())
  ).rejects.toThrow('future')
  const timed = await mined()
  timed.premises.verification.now = '0'
  timed.premises.verification.limits.deadline = '1'
  await expect(
    verifier.verify(timed.evidence, timed.expected, timed.premises, signal())
  ).rejects.toMatchObject({ code: 'limited' })
})
it('owns the evidence and context before asynchronous verification', async () => {
  const f = await mined(),
    expected = structuredClone(f.evidence)
  let calls = 0
  const verifier = new SDKPrivateReleaseEvidence({
    resolve: async (view, abort) => {
      f.evidence.blockEvidence!.blockHash = '99'.repeat(32)
      f.premises.verification.view.tipHash = '88'.repeat(32)
      return resolver.resolve(view, abort)
    }
  })
  const checked = await verifier.verify(
    f.evidence,
    f.expected,
    {
      ...f.premises,
      current: snapshot => {
        calls++
        expect(snapshot!.view.tipHash).toBe(expected.blockEvidence!.tipHash)
        snapshot!.view.tipHash = '77'.repeat(32)
        return true
      }
    },
    signal()
  )
  expect(checked.evidence).toEqual(expected)
  checked.checkCurrent()
  expect(calls).toBe(3)
})
it('checks cancellation and changed installed resolver at the final commit boundary', async () => {
  const f = local(),
    abort = new AbortController(),
    chains = { ...resolver },
    verifier = new SDKPrivateReleaseEvidence(chains)
  const checked = await verifier.verify(f.evidence, f.expected, f.premises, abort.signal)
  abort.abort()
  expect(() => checked.checkCurrent()).toThrow('cancelled')
  await expect(
    verifier.verify(f.evidence, f.expected, f.premises, abort.signal)
  ).rejects.toMatchObject({ code: 'cancelled' })
  const other = await verifier.verify(f.evidence, f.expected, f.premises, signal())
  chains.resolve = async () => {
    throw new Error('replaced')
  }
  expect(() => other.checkCurrent()).toThrow('capability changed')
})
it('fails closed for async, throwing and non-boolean currentness callbacks', async () => {
  const f = local(),
    verifier = new SDKPrivateReleaseEvidence(resolver)
  for (const current of [
    async () => true,
    () => Promise.reject(new Error('no')),
    () => 'yes',
    () => {
      throw new Error('private detail')
    }
  ]) {
    await expect(
      verifier.verify(
        f.evidence,
        f.expected,
        { ...f.premises, current: current as unknown as () => boolean },
        signal()
      )
    ).rejects.toThrow()
  }
})
it('enforces complete evidence size and constructor limits before use', async () => {
  for (const limit of [0, -1, 1.5, 131073, NaN])
    expect(() => new SDKPrivateReleaseEvidence(resolver, {}, limit)).toThrow('allowance')
  const f = local()
  await expect(
    new SDKPrivateReleaseEvidence(resolver, {}, 16).verify(
      f.evidence,
      f.expected,
      f.premises,
      signal()
    )
  ).rejects.toThrow()
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(
      f.evidence,
      { ...f.expected, txid: '99'.repeat(32) },
      f.premises,
      signal()
    )
  ).rejects.toThrow('binding')
})
it('requires target inclusion even when the same raw transaction passes Script verification', async () => {
  const f = await mined()
  f.evidence.blockEvidence!.beef = candidate(corpus.inclusion.name).evidence.beef
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(f.evidence, f.expected, f.premises, signal())
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Release target has no verified inclusion'
  })
})
it('rechecks currentness after actual ancestry verification', async () => {
  const f = await mined()
  let current = true
  const verifier = new SDKPrivateReleaseEvidence({
    resolve: async (view, abort) => {
      const selected = await resolver.resolve(view, abort)
      current = false
      return selected
    }
  })
  await expect(
    verifier.verify(f.evidence, f.expected, { ...f.premises, current: () => current }, signal())
  ).rejects.toMatchObject({ code: 'context-changed' })
})
it('does not let a currentness callback replace the retained local acceptance time', async () => {
  const f = local()
  f.premises.localAcceptedAt = '19'
  f.premises.current = () => {
    f.premises.localAcceptedAt = '20'
    return true
  }
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(f.evidence, f.expected, f.premises, signal())
  ).rejects.toThrow('durable acceptance')
})
it('keeps a mined byte budget and configured chain distinct from a remote assertion', async () => {
  const f = await mined()
  f.premises.verification.view.chain = { ...chain, network: 'other' }
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(f.evidence, f.expected, f.premises, signal())
  ).rejects.toMatchObject({ code: 'context-changed' })
  const bounded = await mined()
  bounded.premises.verification.limits.bytes = 1
  await expect(
    new SDKPrivateReleaseEvidence(resolver).verify(
      bounded.evidence,
      bounded.expected,
      bounded.premises,
      signal()
    )
  ).rejects.toThrow()
})
