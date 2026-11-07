import { LookupOutputSource, lookupOutputQueryDigest } from '../src/sources/index.js'
import { describe, expect, it } from '@jest/globals'
import {
  Utils,
  type LookupAnswer,
  type LookupFacilitatorAnswer,
  type OverlayLookupFacilitator
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  KnowledgeStore,
  MemoryJournal,
  OutputKnowledge,
  SDKEvidenceVerifier,
  runtimeLimits,
  type SourceBatch,
  type SourceRequest
} from '../src/index.js'
import { candidate, chain, context, corpus, partition, resolver } from './evidence-fixture.js'

const question = { service: 'ls_records', query: { visible: true } },
  queryDigest = lookupOutputQueryDigest(question)
function binding(host = 'https://one.example') {
  return {
    chain,
    provider: host,
    service: question.service,
    queryDigest,
    rulesDigest: '04'.repeat(32),
    access: 'public',
    epoch: 'lookup-1'
  }
}
function request(host = 'https://one.example'): SourceRequest {
  return { partition, generation: '0', scope: binding(host), limits: runtimeLimits() }
}
function answer(name = 'Q'): LookupAnswer {
  return {
    type: 'output-list',
    outputs: [
      {
        beef: Utils.toArray(candidate(name).evidence.beef, 'base64'),
        outputIndex: 0,
        txid: corpus.transactions[name].txid,
        context: [0, 1, 255]
      }
    ]
  }
}
function source(facilitator: OverlayLookupFacilitator, host = 'https://one.example') {
  return new LookupOutputSource({ id: host, scope: binding(host), host, question, facilitator })
}
async function collect(output: LookupOutputSource, input = request()) {
  const batches: SourceBatch[] = []
  for await (const batch of output.open(input, new AbortController().signal)) batches.push(batch)
  return batches
}

describe('legacy lookup source with provider-scoped receipts', () => {
  it('retains receipts before legacy deduplication and encodes legacy context as opaque JSON', async () => {
    const supplied = answer(),
      calls: string[] = []
    supplied.outputs.push({ ...supplied.outputs[0], context: [2, 3] })
    const batches = await collect(
        source({
          async lookup(host) {
            calls.push(host)
            return supplied
          }
        })
      ),
      observations = batches.flatMap(batch => batch.groups.flatMap(group => group.observations))
    expect(calls).toEqual(['https://one.example'])
    expect(observations).toHaveLength(2)
    expect(observations[0].id).not.toBe(observations[1].id)
    if (observations[0].kind !== 'output') throw new Error('Expected output')
    expect(
      JSON.parse(Utils.toUTF8(Utils.toArray(observations[0].payload.context!.bytes, 'base64')))
    ).toEqual([0, 1, 255])
    expect(batches.at(-1)?.coverage.status).toBe('complete')
    expect(
      batches.every(batch => batch.coverage.phase === 'finite' && batch.checkpoint === undefined)
    ).toBe(true)
  })

  it('uses legacy BRC-24 target selection when a response has no txid hint', async () => {
    const supplied = answer()
    delete supplied.outputs[0].txid
    const batches = await collect(
        source({
          async lookup() {
            return supplied
          }
        })
      ),
      row = batches[0].groups[0].observations[0]
    expect(row.kind === 'output' && row.payload.evidence.txid).toBe(corpus.transactions.Q.txid)
  })

  it('distinguishes an empty successful source from an unavailable or freeform source', async () => {
    const empty = await collect(
      source({
        async lookup() {
          return { type: 'output-list', outputs: [] }
        }
      })
    )
    expect(empty).toHaveLength(1)
    expect(empty[0].coverage.status).toBe('complete')
    const failed = await collect(
      source({
        async lookup() {
          throw new Error('No response')
        }
      })
    )
    expect(failed.at(-1)?.coverage.status).toBe('unavailable')
    const freeform = await collect(
      source({
        async lookup() {
          return { type: 'freeform', result: {} }
        }
      })
    )
    expect(freeform.at(-1)?.coverage.status).toBe('unavailable')
  })

  it('bounds callback intake and never marks truncated coverage complete', async () => {
    const supplied = answer()
    supplied.outputs.push(...answer('A').outputs)
    const input = request()
    input.limits.observations = 1
    const batches = await collect(
      source({
        async lookup() {
          return supplied
        }
      }),
      input
    )
    expect(batches.flatMap(batch => batch.groups)).toHaveLength(1)
    expect(batches.at(-1)?.coverage.status).toBe('limited')
  })

  it('cancels a slow source without producing a terminal empty answer', async () => {
    let release!: (answer: LookupFacilitatorAnswer) => void
    const output = source({
        lookup: async () =>
          new Promise<LookupFacilitatorAnswer>(resolve => {
            release = resolve
          })
      }),
      abort = new AbortController(),
      iterator = output.open(request(), abort.signal)[Symbol.asyncIterator](),
      result = iterator.next()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    abort.abort()
    await expect(result).rejects.toMatchObject({ code: 'cancelled' })
    release(answer())
    expect((await iterator.next()).done).toBe(true)
  })

  it('binds each host separately and publishes the fast source before the slow source settles', async () => {
    const journal = new MemoryJournal('federated'),
      worker = new BitcoinKnowledge({
        journalId: journal.namespace,
        partition,
        nonFinal: false,
        verifier: new SDKEvidenceVerifier(resolver)
      }),
      store = new KnowledgeStore(journal, worker, { partition }),
      runtime = new OutputKnowledge({ store, worker })
    let release!: (answer: LookupFacilitatorAnswer) => void
    const slow = source(
      {
        lookup: async () =>
          new Promise<LookupFacilitatorAnswer>(resolve => {
            release = resolve
          })
      },
      'https://two.example'
    )
    try {
      await runtime.setContext(context())
      const slowSubscription = runtime.attach(slow, request('https://two.example')),
        fastSubscription = runtime.attach(
          source({
            async lookup() {
              return answer()
            }
          }),
          request()
        )
      await fastSubscription.done
      await runtime.flush()
      const early = await store.read()
      expect(early.reconciled.memberships.map(row => row.scope.provider)).toEqual([
        'https://one.example'
      ])
      release(answer())
      await slowSubscription.done
      await runtime.flush()
      const combined = await store.read()
      expect(combined.reconciled.memberships.map(row => row.scope.provider)).toEqual([
        'https://one.example',
        'https://two.example'
      ])
      expect(combined.facts.filter(row => row.txid === corpus.transactions.Q.txid)).toHaveLength(1)
      await runtime.attach(
        source({
          async lookup() {
            return { type: 'output-list', outputs: [] }
          }
        }),
        { ...request(), generation: '1' }
      ).done
      await runtime.flush()
      expect((await store.read()).reconciled.memberships.map(row => row.scope.provider)).toEqual([
        'https://two.example'
      ])
    } finally {
      await runtime.close()
    }
  })
})
