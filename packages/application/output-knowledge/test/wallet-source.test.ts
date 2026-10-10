import {
  WalletOutputSource,
  WALLET_OUTPUT_CONTEXT_SCHEMA,
  walletOutputQueryDigest
} from '../src/sources/index.js'
import { describe, expect, it, jest } from '@jest/globals'
import { Utils, type ListOutputsArgs, type ListOutputsResult } from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  MemoryJournal,
  OutputKnowledge,
  SDKEvidenceVerifier,
  runtimeLimits,
  type SourceRequest,
  type SourceBatch
} from '../src/index.js'
import {
  aggregate,
  chain,
  context,
  corpus,
  partition,
  resolver,
  transactions
} from './evidence-fixture.js'

const query = { basket: 'records', includeTags: true, includeCustomInstructions: true },
  scope = {
    chain,
    provider: 'selected-wallet',
    service: 'wallet-basket',
    queryDigest: walletOutputQueryDigest('wallet-basket', query),
    rulesDigest: '04'.repeat(32),
    access: 'public',
    epoch: 'wallet-session-1'
  }
const request = (): SourceRequest => ({
  partition,
  generation: '0',
  scope,
  limits: runtimeLimits()
})
function page(...names: string[]): ListOutputsResult {
  return {
    totalOutputs: names.length,
    BEEF: aggregate(...names),
    outputs: names.map(name => ({
      outpoint: `${corpus.transactions[name].txid}.0`,
      satoshis: transactions.get(name)!.outputs[0].satoshis!,
      spendable: true,
      tags: ['visible'],
      customInstructions: 'Private application metadata'
    }))
  }
}
async function collect(source: WalletOutputSource, input = request()) {
  const result: SourceBatch[] = []
  for await (const batch of source.open(input, new AbortController().signal)) result.push(batch)
  return result
}
function source(
  listOutputs: (args: ListOutputsArgs) => Promise<ListOutputsResult>,
  pageSize = 100,
  maximumPages = 32
) {
  return new WalletOutputSource({
    id: 'wallet',
    scope,
    query,
    wallet: { listOutputs },
    pageSize,
    maximumPages
  })
}

describe('finite wallet output source', () => {
  it('retains exact aggregate targets and opaque metadata, and requests no wallet actions', async () => {
    const calls: ListOutputsArgs[] = [],
      output = source(async args => {
        calls.push(args)
        return page('Q', 'A')
      }),
      batches = await collect(output),
      observations = batches[0].groups[0].observations
    expect(calls).toEqual([{ ...query, include: 'entire transactions', limit: 100, offset: 0 }])
    expect(observations.map(row => row.kind === 'output' && row.payload.evidence.txid)).toEqual([
      corpus.transactions.Q.txid,
      corpus.transactions.A.txid
    ])
    if (observations[0].kind !== 'output') throw new Error('Expected output')
    expect(observations[0].payload.context?.schema).toBe(WALLET_OUTPUT_CONTEXT_SCHEMA)
    expect(
      JSON.parse(Utils.toUTF8(Utils.toArray(observations[0].payload.context!.bytes, 'base64')))
    ).toMatchObject({ tags: ['visible'] })
    expect(batches[1].coverage).toEqual({ scope, phase: 'finite', status: 'complete' })
    expect(batches.every(batch => batch.checkpoint === undefined)).toBe(true)
  })

  it('pages progressively only when the preceding batch has been consumed', async () => {
    const calls: number[] = [],
      output = source(async args => {
        calls.push(args.offset!)
        return { ...page(args.offset === 0 ? 'Q' : 'A'), totalOutputs: 2 }
      }, 1),
      iterator = output.open(request(), new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(calls).toEqual([0])
    expect((await iterator.next()).done).toBe(false)
    expect(calls).toEqual([0, 1])
    expect((await iterator.next()).value.coverage.status).toBe('complete')
    expect((await iterator.next()).done).toBe(true)
  })

  it('preserves received evidence while declaring a bounded incomplete scan', async () => {
    const batches = await collect(source(async () => ({ ...page('Q'), totalOutputs: 200 }), 1, 1))
    expect(batches[0].groups[0].observations).toHaveLength(1)
    expect(batches.at(-1)?.coverage.status).toBe('limited')
  })

  it('rejects a changed scope or replay cursor before wallet I/O', async () => {
    const call = jest.fn(async () => page('Q')),
      output = source(call)
    await expect(
      collect(output, { ...request(), scope: { ...scope, provider: 'different' } })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      collect(output, {
        ...request(),
        checkpoint: { session: 'a', cursor: 'b', expiresAt: '1', replayUntil: '2' }
      })
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(call).not.toHaveBeenCalled()
    expect(
      () =>
        new WalletOutputSource({
          id: 'wallet',
          scope,
          query: { basket: 'different' },
          wallet: { listOutputs: call }
        })
    ).toThrow('digest')
  })

  it('checks the wallet result amount and named target before publishing the page', async () => {
    const wrong = page('Q')
    wrong.outputs[0].satoshis++
    await expect(collect(source(async () => wrong))).rejects.toThrow()
    const missing = page('Q')
    missing.BEEF = aggregate('A')
    await expect(collect(source(async () => missing))).rejects.toThrow()
  })

  it('keeps late non-cancellable wallet I/O bounded after cancellation', async () => {
    let resolve!: (value: ListOutputsResult) => void
    const call = jest.fn(
        () =>
          new Promise<ListOutputsResult>(done => {
            resolve = done
          })
      ),
      output = source(call),
      abort = new AbortController(),
      iterator = output.open(request(), abort.signal)[Symbol.asyncIterator](),
      pending = iterator.next()
    await Promise.resolve()
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await expect(collect(output)).rejects.toMatchObject({ code: 'limited' })
    expect(call).toHaveBeenCalledTimes(1)
    resolve(page('Q'))
    await Promise.resolve()
    const closed = new AbortController()
    closed.abort()
    await expect(
      output.open(request(), closed.signal)[Symbol.asyncIterator]().next()
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not equate a later empty basket scan with a verified spend', async () => {
    const journal = new MemoryJournal('wallet-knowledge'),
      worker = new BitcoinKnowledge({
        journalId: journal.namespace,
        partition,
        nonFinal: false,
        verifier: new SDKEvidenceVerifier(resolver)
      }),
      store = new KnowledgeStore(journal, worker, { partition }),
      runtime = new OutputKnowledge({ store, worker })
    try {
      await runtime.setContext(context())
      await runtime.attach(
        source(async () => page('Q', 'A')),
        request()
      ).done
      await runtime.flush()
      const first = await store.read()
      expect(first.reconciled.memberships).toHaveLength(2)
      expect(
        first.reconciled.transactions.find(row => row.txid === corpus.transactions.Q.txid)?.status
      ).toBe('selected-final')
      await runtime.attach(
        source(async () => ({ totalOutputs: 0, outputs: [] })),
        { ...request(), generation: '1' }
      ).done
      await runtime.flush()
      const refreshed = await store.read()
      expect(refreshed.reconciled.memberships).toEqual([])
      expect(refreshed.facts).toEqual(first.facts)
      expect(
        refreshed.assessments
          .filter(row => row.outpoint.txid === corpus.transactions.Q.txid)
          .every(row => row.state === 'unknown')
      ).toBe(true)
    } finally {
      await runtime.close()
    }
  })
})
