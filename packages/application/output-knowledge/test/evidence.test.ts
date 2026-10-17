import { describe, expect, it } from '@jest/globals'
import { Beef, Transaction, Utils } from '@bsv/sdk'
import { assembleOutputEvidence, SDKEvidenceVerifier } from '../src/index.js'
import {
  aggregate,
  candidate,
  chain,
  context,
  corpus,
  resolver,
  transactions
} from './evidence-fixture.js'

const limits = { bytes: 4194304, transactions: 4096, dependencies: 16384 }
const signal = (): AbortSignal => new AbortController().signal
const verify = (name: string): ReturnType<SDKEvidenceVerifier['verify']> =>
  new SDKEvidenceVerifier(resolver).verify(candidate(name), context(), signal())

describe('targeted evidence assembly and SDK verification', () => {
  it('selects an asserted transaction before the last aggregate-wallet row', async () => {
    const input = candidate('A', aggregate('A', 'Q'))
    expect(
      Beef.fromBinaryStrict(Utils.toArray(input.evidence.beef, 'base64')).txs.at(-1)!.txid
    ).not.toBe(input.evidence.txid)
    const plan = assembleOutputEvidence(input.evidence, chain, limits)
    expect(Transaction.fromAtomicBEEF(plan.atomicBeef!).id('hex')).toBe(input.evidence.txid)
    const result = await new SDKEvidenceVerifier(resolver).verify(input, context(), signal())
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.fact.txid).toBe(input.evidence.txid)
  })

  it('rejects an Atomic BEEF assertion naming a different transaction', () => {
    const input = candidate('A')
    input.evidence.txid = corpus.transactions.P.txid
    expect(() => assembleOutputEvidence(input.evidence, chain, limits)).toThrow(
      'Atomic BEEF target'
    )
  })

  it('keeps txid-only evidence and missing predecessors unresolved', async () => {
    const bundle = new Beef()
    bundle.mergeTxidOnly(corpus.transactions.P.txid)
    const only = candidate('P', bundle.toBinary())
    const verifier = new SDKEvidenceVerifier(resolver)
    expect(await verifier.verify(only, context(), signal())).toMatchObject({
      status: 'unresolved',
      dependencies: [{ chain, txid: only.evidence.txid, outputIndex: 0 }]
    })
    bundle.mergeRawTx(Utils.toArray(corpus.transactions.A.raw, 'hex'))
    expect(
      await verifier.verify(candidate('A', bundle.toBinary()), context(), signal())
    ).toMatchObject({ status: 'unresolved', dependencies: [{ txid: only.evidence.txid }] })
  })

  it('checks Script and verifies exact-view placement, without claiming unspentness', async () => {
    expect((await verify('badSignature')).status).toBe('invalid')
    expect((await verify('N')).status).toBe('verified') // Non-final is a separate reconciliation decision.
    const included = candidate(
      corpus.inclusion.name,
      Utils.toArray(corpus.inclusion.beef, 'base64')
    )
    expect(
      await new SDKEvidenceVerifier(resolver).verify(included, context('included'), signal())
    ).toMatchObject({
      status: 'verified',
      placement: { height: expect.any(String), blockHash: expect.any(String) }
    })
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(included, context('fork'), signal())).status
    ).toBe('invalid')
  })

  it('does not poison a later valid variant after an invalid receipt', async () => {
    const verifier = new SDKEvidenceVerifier(resolver),
      bad = candidate('A')
    bad.variantId = '00'.repeat(32)
    expect((await verifier.verify(bad, context(), signal())).status).toBe('invalid')
    expect((await verifier.verify(candidate('A'), context(), signal())).status).toBe('verified')
  })

  it('classifies unavailable ancestry separately from invalid cryptographic evidence', async () => {
    const unavailable = new SDKEvidenceVerifier({
      resolve: async () => {
        throw new Error('offline')
      }
    })
    expect((await unavailable.verify(candidate('A'), context(), signal())).status).toBe('limited')
    const changed = new SDKEvidenceVerifier({
      resolve: async () => resolver.resolve(context('fork').view, signal())
    })
    expect((await changed.verify(candidate('A'), context(), signal())).status).toBe(
      'context-changed'
    )
    const foreign = candidate('A')
    foreign.chain = { ...chain, network: 'unconfigured' }
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(foreign, context(), signal())).status
    ).toBe('invalid')
  })

  it('enforces resource and deadline bounds before chain calls', async () => {
    const limited = context()
    limited.limits.bytes = 8
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(candidate('A'), limited, signal())).status
    ).toBe('limited')
    const old = context()
    old.now = '0'
    old.limits.deadline = '1'
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(candidate('A'), old, signal())).status
    ).toBe('limited')
    expect(() => new SDKEvidenceVerifier(resolver, { consumers: 0 })).toThrow('limit')
    expect(() =>
      assembleOutputEvidence(candidate('A').evidence, chain, { ...limits, transactions: 1 })
    ).toThrow('transaction limit')
  })

  it('cancels promptly and retains the slot until non-abortable work settles', async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const verifier = new SDKEvidenceVerifier(
      {
        resolve: async (view, abort) => {
          entered()
          await blocked
          return resolver.resolve(view, abort)
        }
      },
      { consumers: 1 }
    )
    const abort = new AbortController()
    const pending = verifier.verify(candidate('A'), context(), abort.signal)
    await started
    abort.abort()
    expect((await pending).status).toBe('cancelled')
    expect((await verifier.verify(candidate('A'), context(), signal())).status).toBe('limited')
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await verifier.verify(candidate('A'), context(), signal())).status).toBe('verified')
    expect((await verifier.verify(candidate('A'), context(), abort.signal)).status).toBe(
      'cancelled'
    )
  })

  it('times out a chain provider even when it ignores AbortSignal', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const verifier = new SDKEvidenceVerifier(
      {
        resolve: async (view, abort) => {
          await blocked
          return resolver.resolve(view, abort)
        }
      },
      { requestTimeoutMs: 10 }
    )
    try {
      expect((await verifier.verify(candidate('A'), context(), signal())).status).toBe('limited')
    } finally {
      release()
    }
  })

  it('rejects trailing bytes and an output index outside the asserted transaction', async () => {
    const bytes = [...transactions.get('A')!.toAtomicBEEF(), 0]
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(candidate('A', bytes), context(), signal()))
        .status
    ).toBe('invalid')
    const absent = candidate('A')
    absent.evidence.outputIndex = 0xffffffff
    expect(
      (await new SDKEvidenceVerifier(resolver).verify(absent, context(), signal())).status
    ).toBe('invalid')
  })
})
