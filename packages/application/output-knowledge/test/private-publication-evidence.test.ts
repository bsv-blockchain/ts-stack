import { expect, it } from '@jest/globals'
import {
  Beef,
  LockingScript,
  outputPrivatePublicationRequestDigest,
  P2PKH,
  PrivateKey,
  Transaction,
  Utils,
  type OutputPrivatePublish
} from '@bsv/sdk'
import { SDKPrivatePublicationEvidence } from '../src/private/SDKPrivatePublicationEvidence.js'
import { context, resolver, chain, transactions, candidate } from './evidence-fixture.js'

const publisher = new PrivateKey(63).toPublicKey().toString()
async function publication() {
  const transaction = new Transaction(
    1,
    [
      {
        sourceTransaction: transactions.get('P')!,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
        sequence: 0xffffffff
      }
    ],
    [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }],
    0
  )
  await transaction.sign()
  const request: OutputPrivatePublish = {
    version: 1,
    requestId: 'verified-publication-1',
    topic: 'tm_synthetic',
    evidence: {
      txid: transaction.id('hex'),
      outputIndex: 0,
      beef: Utils.toBase64(transaction.toAtomicBEEF())
    },
    assetId: '44'.repeat(32),
    schema: 'urn:test:private-material',
    privateValues: 'AQID'
  }
  return { request, transaction }
}
it('returns exact signed transaction bytes and an owned original immutable header context', async () => {
  const { request, transaction } = await publication(),
    original = context()
  const verifier = new SDKPrivatePublicationEvidence(resolver, (owned, author, selectedChain) => {
    expect(owned).toEqual(request)
    expect(author).toBe(publisher)
    expect(selectedChain).toEqual(chain)
    owned.privateValues = 'BA=='
    selectedChain.network = 'changed'
    return original
  })
  const result = await verifier.verify(request, publisher, chain)
  expect(result).toEqual({
    rawTransaction: Utils.toBase64(transaction.toBinary()),
    publisher,
    requestDigest: outputPrivatePublicationRequestDigest(request),
    verificationContext: original
  })
  result.verificationContext.view.id = 'changed'
  expect(original.view.id).toBe('base')
  expect(request.privateValues).toBe('AQID')
  expect(chain.network).toBe('brc-reconciliation-fixture')
})
it('rejects a transaction whose signed output was changed', async () => {
  const { request, transaction } = await publication()
  transaction.outputs[0].satoshis = 2
  const changed = new Transaction(
    transaction.version,
    transaction.inputs,
    transaction.outputs,
    transaction.lockTime
  )
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(
      {
        ...request,
        evidence: {
          ...request.evidence,
          txid: changed.id('hex'),
          beef: Utils.toBase64(changed.toAtomicBEEF())
        }
      },
      publisher,
      chain
    )
  ).rejects.toMatchObject({ code: 'invalid', retryable: false })
})
it('rejects an absent output even when the transaction and its Script verify', async () => {
  const { request } = await publication()
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(
      { ...request, evidence: { ...request.evidence, outputIndex: 1 } },
      publisher,
      chain
    )
  ).rejects.toMatchObject({ code: 'invalid' })
})
it('preserves unresolved missing ancestry without making a false definitive rejection', async () => {
  const { request } = await publication(),
    missing = new Beef()
  missing.mergeTxidOnly(request.evidence.txid)
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(
      {
        ...request,
        evidence: {
          ...request.evidence,
          beef: Utils.toBase64(missing.toBinary())
        }
      },
      publisher,
      chain
    )
  ).rejects.toMatchObject({ code: 'unavailable', retryable: true })
})
it('rejects a selected chain different from the immutable verification context before resolving ancestry', async () => {
  const { request } = await publication()
  let calls = 0
  const verifier = new SDKPrivatePublicationEvidence(
    {
      resolve: async (...args) => {
        calls++
        return resolver.resolve(...args)
      }
    },
    () => context()
  )
  await expect(
    verifier.verify(request, publisher, {
      ...chain,
      genesisHash: 'ff'.repeat(32)
    })
  ).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Private publication chain context differs'
  })
  expect(calls).toBe(0)
})
it('rejects an aggregate whose default transaction is not the requested verified target', async () => {
  const { request, transaction } = await publication(),
    aggregate = Beef.fromBinary(transaction.toBEEF())
  aggregate.mergeBeef(Utils.toArray(candidate('Q').evidence.beef, 'base64'))
  const bytes = aggregate.toBinary()
  expect(Transaction.fromBEEF(bytes).id('hex')).not.toBe(request.evidence.txid)
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(
      {
        ...request,
        evidence: { ...request.evidence, beef: Utils.toBase64(bytes) }
      },
      publisher,
      chain
    )
  ).rejects.toMatchObject({
    code: 'invalid',
    message: 'Private publication BEEF default target differs'
  })
})
it('accepts alternate valid proofs of the same default target with the same semantic request digest', async () => {
  const { request, transaction } = await publication()
  const verifier = new SDKPrivatePublicationEvidence(resolver, () => context())
  const variant = {
    ...request,
    evidence: {
      ...request.evidence,
      beef: Utils.toBase64(transaction.toBEEF())
    }
  }
  expect(variant.evidence.beef).not.toBe(request.evidence.beef)
  const [first, second] = await Promise.all([
    verifier.verify(request, publisher, chain),
    verifier.verify(variant, publisher, chain)
  ])
  expect(first.requestDigest).toBe(second.requestDigest)
  expect(first.rawTransaction).toBe(second.rawTransaction)
})
it('preserves cancellation and elapsed-deadline failures as retryable outcomes', async () => {
  const { request } = await publication(),
    abort = new AbortController()
  abort.abort()
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(
      request,
      publisher,
      chain,
      abort.signal
    )
  ).rejects.toMatchObject({ code: 'cancelled', retryable: true })
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => ({
      ...context(),
      now: '0',
      limits: { ...context().limits, deadline: '1' }
    })).verify(request, publisher, chain)
  ).rejects.toMatchObject({ code: 'limited', retryable: true })
})

it('owns installed critical extensions and keeps their data in the semantic request', async () => {
  const { request } = await publication()
  const extension = 'urn:test:private-material-context'
  const installed = [extension]
  const verifier = new SDKPrivatePublicationEvidence(resolver, () => context(), {}, installed)
  installed.length = 0
  const selected = {
    ...request,
    extensions: { [extension]: { revision: 1 } },
    critical: [extension]
  }
  const result = await verifier.verify(selected, publisher, chain)
  expect(result.requestDigest).toBe(outputPrivatePublicationRequestDigest(selected, [extension]))
  expect(result.requestDigest).not.toBe(outputPrivatePublicationRequestDigest(request))
  await expect(
    new SDKPrivatePublicationEvidence(resolver, () => context()).verify(selected, publisher, chain)
  ).rejects.toMatchObject({ code: 'unsupported' })
})

it('keeps changed immutable resolver context retryable with an explicit verification outcome', async () => {
  const { request } = await publication()
  const verifier = new SDKPrivatePublicationEvidence(
    {
      resolve: async (...args) => {
        const resolved = await resolver.resolve(...args)
        return { ...resolved, view: { ...resolved.view, id: 'different-immutable-view' } }
      }
    },
    () => context()
  )
  await expect(verifier.verify(request, publisher, chain)).rejects.toMatchObject({
    code: 'context-changed',
    retryable: true,
    message: 'Private publication evidence verification context-changed'
  })
})
