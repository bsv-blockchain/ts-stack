import { describe, expect, it } from '@jest/globals'
import { Utils } from '@bsv/sdk'
import {
  OutputKnowledge,
  KnowledgeStore,
  MemoryJournal,
  runtimeLimits,
  type AcceptedInput,
  type DomainProjector,
  type OutputKnowledgeWorker,
  type Projection,
  type Source,
  type SourceBatch,
  type SourceRequest
} from '../src/index.js'
import { RuntimeEvents } from '../src/RuntimeEvents.js'
import { emptyReducer } from './empty-reducer.js'
import { candidate, chain, context, partition } from './evidence-fixture.js'

const scope = {
  chain,
  provider: 'test-source',
  service: 'test-records',
  queryDigest: '01'.repeat(32),
  rulesDigest: '02'.repeat(32),
  access: 'public',
  epoch: 'epoch-0'
}
function request(): SourceRequest {
  return { partition, generation: '0', scope, limits: runtimeLimits() }
}
function batch(id = 'one'): SourceBatch {
  return {
    provenance: {
      partition,
      generation: '0',
      adapter: 'source',
      scope,
      authentication: 'configured-transport',
      peer: scope.provider,
      receivedAt: '1'
    },
    groups: [
      {
        id,
        sequence: '0',
        observations: [
          { id, scope, kind: 'output', payload: { evidence: candidate('A').evidence } }
        ]
      }
    ],
    coverage: { scope, phase: 'finite', status: 'complete' }
  }
}
function projection(input: AcceptedInput): Projection {
  return {
    acceptedRevision: input.revision.accepted,
    generation: input.generation,
    contextId: input.context.id,
    records: [
      {
        id: 'record',
        schema: 'urn:example:test-record',
        value: Utils.toBase64(Utils.toArray(input.context.id, 'utf8'))
      }
    ],
    conflicts: [],
    unresolved: []
  }
}
const noWork: OutputKnowledgeWorker = { advance: async () => {}, pendingBytes: async () => 0 }
async function open(
  worker = noWork,
  projector?: DomainProjector,
  limits?: Parameters<typeof runtimeLimits>[0]
): Promise<{ runtime: OutputKnowledge; journal: MemoryJournal; store: KnowledgeStore }> {
  const journal = new MemoryJournal('test'),
    store = new KnowledgeStore(journal, emptyReducer(), { partition })
  const runtime = new OutputKnowledge({ store, worker, projector, limits })
  await runtime.setContext(context())
  await runtime.flush()
  return { runtime, journal, store }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('runtime orchestration and publication ports', () => {
  it('acknowledges a source yield only after a durable receipt, independently of verification completion', async () => {
    const { runtime, journal } = await open()
    let acknowledged = false
    const source: Source = {
      id: 'source',
      async *open() {
        yield batch()
        const entries = await journal.read('1', 10)
        expect(entries[0].body.kind).toBe('receive')
        expect(entries[0].revision).toEqual({ received: '2', accepted: '1' })
        acknowledged = true
      }
    }
    await runtime.attach(source, request()).done
    expect(acknowledged).toBe(true)
    await runtime.flush()
    await runtime.close()
  })

  it('does not acknowledge malformed scope or advance a cursor beyond pending capacity', async () => {
    const { runtime, journal } = await open({
      ...noWork,
      pendingBytes: async () => 16 * 1024 * 1024
    })
    let afterYield = false
    const source: Source = {
      id: 'source',
      async *open() {
        yield batch()
        afterYield = true
      }
    }
    await expect(runtime.attach(source, request()).done).rejects.toMatchObject({ code: 'limited' })
    expect(afterYield).toBe(false)
    expect((await journal.head()).received).toBe('1')
    await runtime.close()
    const next = await open()
    const wrong = batch()
    wrong.groups[0].observations[0].scope = { ...scope, epoch: 'other' }
    await expect(
      next.runtime.attach(
        {
          id: 'source',
          async *open() {
            yield wrong
          }
        },
        request()
      ).done
    ).rejects.toThrow('scope')
    expect((await next.journal.head()).received).toBe('1')
    await next.runtime.close()
  })

  it('discards a late projection after a context change and rebuilds under the new context', async () => {
    const entered = deferred(),
      release = deferred()
    let hold = false
    const projector: DomainProjector = {
      policyDigest: 'ff'.repeat(32),
      async project(input) {
        if (hold) {
          hold = false
          entered.resolve()
          await release.promise
        }
        return projection(input)
      }
    }
    const { runtime } = await open(noWork, projector)
    hold = true
    const flushing = runtime.flush()
    await entered.promise
    const next = context()
    next.id = 'verification-new'
    next.generation = '1'
    await runtime.setContext(next)
    expect(await runtime.readProjection()).toBeUndefined()
    release.resolve()
    await flushing
    expect(await runtime.readProjection()).toMatchObject({
      generation: '1',
      contextId: 'verification-new'
    })
    await runtime.close()
  })

  it('does not mark a failed projection current and can rebuild it idempotently', async () => {
    let fail = false
    const projector: DomainProjector = {
      policyDigest: 'ff'.repeat(32),
      async project(input) {
        if (fail) throw new Error('application parser failed')
        return projection(input)
      }
    }
    const { runtime } = await open(noWork, projector)
    fail = true
    const next = context()
    next.id = 'changed'
    await runtime.setContext(next)
    await expect(runtime.flush()).rejects.toThrow('application parser failed')
    expect(await runtime.readProjection()).toBeUndefined()
    fail = false
    await runtime.flush()
    expect((await runtime.readProjection())?.contextId).toBe('changed')
    await runtime.close()
  })

  it('closes an account partition before late source or projection work can publish', async () => {
    const entered = deferred(),
      release = deferred()
    const { runtime, journal } = await open()
    const source: Source = {
      id: 'source',
      async *open() {
        entered.resolve()
        await release.promise
        yield batch()
      }
    }
    const subscription = runtime.attach(source, request())
    await entered.promise
    await runtime.close()
    release.resolve()
    await subscription.done
    await expect(runtime.readProjection()).rejects.toMatchObject({ code: 'cancelled' })
    await expect(journal.head()).rejects.toThrow('closed')
    const other = await open()
    expect(() =>
      other.runtime.attach(source, { ...request(), partition: { ...partition, account: 'bob' } })
    ).toThrow('partition')
    await other.runtime.close()
  })

  it('validates source requests before I/O and rejects malformed nested projections', async () => {
    const { runtime } = await open()
    let opened = false
    const source: Source = {
      id: 'source',
      async *open() {
        opened = true
        yield batch()
      }
    }
    expect(() => runtime.attach(source, { ...request(), generation: '-1' })).toThrow()
    expect(opened).toBe(false)
    const altered: Source = {
      id: 'source',
      async *open(selected) {
        selected.scope.epoch = 'unselected-epoch'
        const result = batch()
        result.provenance.scope = selected.scope
        result.coverage.scope = selected.scope
        result.groups[0].observations[0].scope = selected.scope
        yield result
      }
    }
    await expect(runtime.attach(altered, request()).done).rejects.toThrow('scope')
    await runtime.close()
    const journal = new MemoryJournal('test'),
      store = new KnowledgeStore(journal, emptyReducer(), { partition })
    const malformed = new OutputKnowledge({
      store,
      worker: noWork,
      projector: {
        policyDigest: 'aa'.repeat(32),
        async project(input) {
          const result = projection(input)
          result.records[0].value = 'not base64'
          return result
        }
      }
    })
    await malformed.setContext(context())
    await expect(malformed.flush()).rejects.toMatchObject({ code: 'invalid' })
    expect(await malformed.readProjection()).toBeUndefined()
    await malformed.close()
  })

  it('bounds projector time and suppresses a non-abortable late result', async () => {
    const release = deferred()
    const journal = new MemoryJournal('test'),
      store = new KnowledgeStore(journal, emptyReducer(), { partition })
    const runtime = new OutputKnowledge({
      store,
      worker: noWork,
      limits: { deadlineMs: 10 },
      projector: {
        policyDigest: 'aa'.repeat(32),
        async project(input) {
          await release.promise
          return projection(input)
        }
      }
    })
    await runtime.setContext(context())
    await expect(runtime.flush()).rejects.toMatchObject({ code: 'limited' })
    release.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await runtime.readProjection()).toBeUndefined()
    await runtime.close()
  })

  it('bounds event observers, closes slow consumers explicitly, and releases cancelled subscriptions', async () => {
    const { runtime } = await open()
    const aborts = Array.from({ length: 8 }, () => new AbortController())
    for (const abort of aborts) runtime.events(abort.signal)
    expect(() => runtime.events()).toThrow('capacity')
    for (const abort of aborts) abort.abort()
    const iterator = runtime.events()[Symbol.asyncIterator]()
    await iterator.return?.()
    const aborted = new AbortController()
    aborted.abort()
    expect(() => runtime.events(aborted.signal)).toThrow('cancelled')
    await runtime.close()
    let disposed = 0
    const queue = new RuntimeEvents(new AbortController().signal, () => {
      disposed++
    })
    for (let i = 0; i < 9; i++)
      queue.push(
        JSON.stringify({
          kind: 'error',
          code: 'unavailable',
          message: 'source offline',
          retryable: true
        })
      )
    await expect(queue.next()).rejects.toMatchObject({ code: 'reset-required' })
    expect(disposed).toBe(1)
    const waiting = new RuntimeEvents(new AbortController().signal, () => {})
    const pending = waiting.next()
    await waiting.return()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})
