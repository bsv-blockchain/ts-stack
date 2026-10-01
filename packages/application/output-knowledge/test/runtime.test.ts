import { knowledgeMutation } from '../src/storage/Journal.js'
import { describe, expect, it, jest } from '@jest/globals'
import { Utils, OutputProtocolError } from '@bsv/sdk'
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
  it('does not return a retained projection after its publication gate changes during an asynchronous read', async () => {
    const fixture = await open(noWork, {
      policyDigest: 'ff'.repeat(32),
      project: async input => projection(input)
    })
    const entered = deferred(),
      release = deferred(),
      commitEntered = deferred(),
      commitRelease = deferred()
    const read = fixture.store.read.bind(fixture.store)
    const commit = fixture.store.commit.bind(fixture.store)
    const readSpy = jest.spyOn(fixture.store, 'read').mockImplementationOnce(async (...args) => {
      const saved = await read(...args)
      entered.resolve()
      await release.promise
      return saved
    })
    const commitSpy = jest
      .spyOn(fixture.store, 'commit')
      .mockImplementationOnce(async (...args) => {
        commitEntered.resolve()
        await commitRelease.promise
        return commit(...args)
      })
    let changed: Promise<void> | undefined
    try {
      const pending = fixture.runtime.readProjection()
      await entered.promise
      changed = fixture.runtime.setContext({ ...context(), id: 'context-after-held-read' })
      await commitEntered.promise
      release.resolve()
      expect(await pending).toBeUndefined()
      commitRelease.resolve()
      await changed
      await fixture.runtime.flush()
      expect((await fixture.runtime.readProjection())?.contextId).toBe('context-after-held-read')
    } finally {
      release.resolve()
      commitRelease.resolve()
      await changed
      readSpy.mockRestore()
      commitSpy.mockRestore()
      await fixture.runtime.close()
    }
  })

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
  it('delivers owned knowledge and projection events and reports a source error without private details', async () => {
    const { runtime } = await open(noWork, {
      policyDigest: 'ab'.repeat(32),
      project: async input => projection(input)
    })
    const events = runtime.events()[Symbol.asyncIterator]()
    await runtime.flush()
    const knowledge = await events.next(),
      projected = await events.next()
    expect(knowledge.value?.kind).toBe('knowledge')
    expect(projected.value?.kind).toBe('projection')
    if (projected.value?.kind !== 'projection') throw new Error('Projection event missing')
    projected.value.projection.records[0].value = 'AQ=='
    expect((await runtime.readProjection())?.records[0].value).not.toBe('AQ==')
    const failed: Source = {
      id: 'source',
      open() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error('private transport diagnostics')
              }
            }
          }
        }
      }
    }
    await expect(runtime.attach(failed, request()).done).rejects.toThrow(
      'private transport diagnostics'
    )
    expect((await events.next()).value).toEqual({
      kind: 'error',
      source: 'source',
      code: 'unavailable',
      message: 'Output runtime unavailable',
      retryable: true
    })
    await events.return?.()
    await runtime.close()
  })

  it('rejects duplicate source attachments, excessive requested bounds and policy changes', async () => {
    const release = deferred(),
      entered = deferred()
    let policy = 'ab'.repeat(32)
    const projector: DomainProjector = {
      get policyDigest() {
        return policy
      },
      project: async input => projection(input)
    }
    const { runtime } = await open(noWork, projector, { observations: 1 })
    const source: Source = {
      id: 'source',
      async *open() {
        entered.resolve()
        await release.promise
        yield batch()
      }
    }
    expect(() => runtime.attach(source, request())).toThrow('exceeds runtime')
    const selected = { ...request(), limits: { ...runtime.limits } }
    const attached = runtime.attach(source, selected)
    await entered.promise
    expect(() => runtime.attach(source, selected)).toThrow('already attached')
    attached.close()
    release.resolve()
    await attached.done
    policy = 'cd'.repeat(32)
    expect(await runtime.readProjection()).toBeUndefined()
    await expect(runtime.flush()).rejects.toMatchObject({ code: 'context-changed' })
    await expect(
      runtime.setContext({ ...context(), partition: { ...partition, access: 'private' } })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await runtime.close()
  })

  it('rejects a projector checkpoint change and reports protocol errors with their retry policy', async () => {
    const store = new KnowledgeStore(new MemoryJournal('test'), emptyReducer(), { partition })
    const runtime = new OutputKnowledge({
      store,
      worker: noWork,
      projector: {
        policyDigest: 'ab'.repeat(32),
        project: async input => ({ ...projection(input), acceptedRevision: '999' })
      }
    })
    await runtime.setContext(context())
    await expect(runtime.flush()).rejects.toMatchObject({ code: 'invalid' })
    expect(await runtime.readProjection()).toBeUndefined()
    const events = runtime.events()[Symbol.asyncIterator]()
    const source: Source = {
      id: 'source',
      open() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new OutputProtocolError('unauthorized', 'private access data')
              }
            }
          }
        }
      }
    }
    await expect(runtime.attach(source, request()).done).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect((await events.next()).value).toMatchObject({
      kind: 'error',
      code: 'unauthorized',
      retryable: false,
      message: 'Output runtime unauthorized'
    })
    await runtime.close()
  })

  it('serializes observer reads, delivers pending events, and disposes cancellation once', async () => {
    const abort = new AbortController()
    let disposed = 0
    const queue = new RuntimeEvents(abort.signal, () => {
      disposed++
    })
    expect(queue[Symbol.asyncIterator]()).toBe(queue)
    const waiting = queue.next()
    await expect(queue.next()).rejects.toMatchObject({ code: 'conflict' })
    const event = { kind: 'error', code: 'unavailable', message: 'offline', retryable: true }
    queue.push(JSON.stringify(event))
    expect(await waiting).toEqual({ done: false, value: event })
    const next = queue.next()
    abort.abort()
    await expect(next).rejects.toMatchObject({ code: 'cancelled' })
    queue.push(JSON.stringify(event))
    queue.close()
    expect(disposed).toBe(1)
    const closed = new RuntimeEvents(new AbortController().signal, () => {})
    await closed.return()
    expect(await closed.next()).toEqual({ done: true, value: undefined })
    const already = new AbortController()
    already.abort()
    const cancelled = new RuntimeEvents(already.signal, () => {})
    await expect(cancelled.next()).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('exclusive projection publication windows', () => {
  async function timed(companion: boolean, options: { hold?: () => Promise<void> } = {}) {
    let clock = 1000
    const original = context()
    const journal = new MemoryJournal('test')
    const base = emptyReducer()
    const store = new KnowledgeStore(
      journal,
      {
        async reduce(entries, signal) {
          const value = await base.reduce(entries, signal)
          if (!companion && value.context.id === original.id)
            value.assessments = [
              {
                id: 'ab'.repeat(32),
                outpoint: { chain, txid: 'cd'.repeat(32), outputIndex: 0 },
                state: 'unknown',
                contextId: original.id,
                generation: original.generation,
                policyDigest: original.policyDigest,
                origin: { kind: 'local' },
                evidenceIds: [],
                expiresAt: '2'
              }
            ]
          return value
        }
      },
      { partition, now: () => clock }
    )
    const worker: OutputKnowledgeWorker = {
      ...noWork,
      ...(companion
        ? {
            nextInvalidation(input: AcceptedInput) {
              // The runtime supplies an owned copy to this installed local hook.
              const deadline = input.context.id === original.id ? '2' : undefined
              input.context.id = 'attempt-to-change-owned-copy'
              return deadline
            }
          }
        : {}),
      async advance() {
        const input = await base.reduce(
          (await store.inspect()).entries,
          new AbortController().signal
        )
        if (clock < 2000 || input.context.id !== original.id) return
        const next = { ...original, id: 'expired-state-revision' }
        const result = await store.commit(
          input.revision.received,
          knowledgeMutation({ kind: 'context', context: next })
        )
        expect(result.status).toBe('committed')
      }
    }
    const runtime = new OutputKnowledge({
      store,
      worker,
      now: () => clock,
      projector: {
        policyDigest: 'ff'.repeat(32),
        async project(input) {
          await options.hold?.()
          return projection(input)
        }
      }
    })
    await runtime.setContext(original)
    await runtime.flush()
    return {
      runtime,
      journal,
      store,
      original,
      setClock: (value: number) => {
        clock = value
      }
    }
  }

  it.each([false, true])(
    'closes a saved projection at exclusive expiry before a delayed timer, companion=%s',
    async companion => {
      const fixture = await timed(companion)
      try {
        fixture.setClock(1999)
        expect((await fixture.runtime.readProjection())?.contextId).toBe(fixture.original.id)
        fixture.setClock(2000)
        if (companion) expect(await fixture.runtime.readProjection()).toBeUndefined()
        else
          await expect(fixture.runtime.readProjection()).rejects.toMatchObject({ code: 'expired' })
        await fixture.runtime.flush()
        expect((await fixture.runtime.readProjection())?.contextId).toBe('expired-state-revision')
        expect((await fixture.store.read()).revision.accepted).toBe('2')
        expect((await fixture.journal.read('0', 10)).at(-1)?.body.kind).toBe('context')
      } finally {
        await fixture.runtime.close()
      }
    }
  )

  it('does not publish work that crosses a companion deadline during an asynchronous projector', async () => {
    const entered = deferred(),
      release = deferred()
    let hold = false
    const fixture = await timed(true, {
      hold: async () => {
        if (hold) {
          hold = false
          entered.resolve()
          await release.promise
        }
      }
    })
    try {
      hold = true
      const outcome = fixture.runtime.flush().then(
        () => undefined,
        error => error
      )
      await entered.promise
      fixture.setClock(2000)
      release.resolve()
      expect(await outcome).toMatchObject({ code: 'expired' })
      expect(await fixture.runtime.readProjection()).toBeUndefined()
      await fixture.runtime.flush()
      expect((await fixture.runtime.readProjection())?.contextId).toBe('expired-state-revision')
    } finally {
      release.resolve()
      await fixture.runtime.close()
    }
  })

  it('does not spin a worker that leaves expired state unresolved', async () => {
    let calls = 0
    const store = new KnowledgeStore(new MemoryJournal('test'), emptyReducer(), { partition })
    const runtime = new OutputKnowledge({
      store,
      worker: {
        ...noWork,
        nextInvalidation: () => '1',
        advance: async () => {
          calls++
        }
      },
      now: () => 1000,
      projector: { policyDigest: 'ff'.repeat(32), project: async input => projection(input) }
    })
    try {
      await runtime.setContext(context())
      await expect(runtime.flush()).rejects.toMatchObject({ code: 'expired' })
      expect(await runtime.readProjection()).toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      await runtime.close()
    }
  })

  it('uses its timer to commit invalidation without a new source message', async () => {
    jest.useFakeTimers()
    const fixture = await timed(true)
    try {
      // A wake before the installed clock reaches expiry cannot invalidate state.
      await jest.advanceTimersByTimeAsync(1000)
      expect((await fixture.journal.head()).accepted).toBe('1')
      fixture.setClock(2000)
      await jest.advanceTimersByTimeAsync(1000)
      await fixture.runtime.flush()
      expect((await fixture.runtime.readProjection())?.contextId).toBe('expired-state-revision')
      expect((await fixture.journal.head()).accepted).toBe('2')
    } finally {
      await fixture.runtime.close()
      jest.useRealTimers()
    }
  })

  it('closes publication and emits a bounded error when the timer clock becomes invalid', async () => {
    jest.useFakeTimers()
    const fixture = await timed(true)
    const events = fixture.runtime.events()[Symbol.asyncIterator]()
    try {
      fixture.setClock(Number.NaN)
      await jest.advanceTimersByTimeAsync(1000)
      expect((await events.next()).value).toEqual({
        kind: 'error',
        code: 'invalid',
        message: 'Output runtime invalid',
        retryable: false
      })
      expect(await fixture.runtime.readProjection()).toBeUndefined()
      expect((await fixture.journal.head()).accepted).toBe('1')
    } finally {
      await events.return?.()
      await fixture.runtime.close()
      jest.useRealTimers()
    }
  })

  it.each(['-1', '01', '18446744073709551616', 'x', ''])(
    'rejects an invalid installed deadline %s',
    async deadline => {
      const store = new KnowledgeStore(new MemoryJournal('test'), emptyReducer(), { partition })
      const runtime = new OutputKnowledge({
        store,
        now: () => 0,
        worker: { ...noWork, nextInvalidation: () => deadline },
        projector: { policyDigest: 'ff'.repeat(32), project: async input => projection(input) }
      })
      try {
        await runtime.setContext(context())
        await expect(runtime.flush()).rejects.toMatchObject({ code: 'invalid' })
        expect(await runtime.readProjection()).toBeUndefined()
      } finally {
        await runtime.close()
      }
    }
  )

  it('accepts the full U64 deadline without converting it to an unsafe timer delay', async () => {
    jest.useFakeTimers()
    const store = new KnowledgeStore(new MemoryJournal('test'), emptyReducer(), { partition })
    const runtime = new OutputKnowledge({
      store,
      now: () => 1,
      worker: { ...noWork, nextInvalidation: () => '18446744073709551615' },
      projector: { policyDigest: 'ff'.repeat(32), project: async input => projection(input) }
    })
    try {
      await runtime.setContext(context())
      await runtime.flush()
      await jest.advanceTimersByTimeAsync(120000)
      expect((await runtime.readProjection())?.contextId).toBe(context().id)
      expect(jest.getTimerCount()).toBe(1)
    } finally {
      await runtime.close()
      jest.useRealTimers()
    }
  })
})

describe('bounded runtime intake and lifecycle recovery', () => {
  const once: Source = {
    id: 'source',
    async *open() {
      yield batch()
    }
  }

  it.each([0, -1, 17, 1.5])(
    'rejects invalid source concurrency %s before opening work',
    maximumSources => {
      const store = new KnowledgeStore(new MemoryJournal('test'), emptyReducer(), { partition })
      expect(() => new OutputKnowledge({ store, worker: noWork, maximumSources })).toThrow(
        'concurrency'
      )
    }
  )

  it('requires durable receipt storage when an adapter acknowledges durable work', async () => {
    const { runtime } = await open()
    try {
      expect(() => runtime.attach({ ...once, requiredDurability: 'durable' }, request())).toThrow(
        'durable'
      )
    } finally {
      await runtime.close()
    }
  })

  it('bounds concurrently attached sources without opening another adapter', async () => {
    const { runtime } = await open()
    const release = deferred()
    const sources = Array.from({ length: 4 }, (_, index) =>
      runtime.attach(
        {
          id: 'held-' + index,
          async *open() {
            await release.promise
            const value = batch('held-' + index)
            value.provenance.adapter = 'held-' + index
            yield value
          }
        },
        request()
      )
    )
    try {
      expect(() => runtime.attach(once, request())).toThrow('Source concurrency')
    } finally {
      release.resolve()
      await Promise.all(sources.map(source => source.done))
      await runtime.close()
    }
  })

  it('retries receipt CAS on the same mutation and fails explicitly at its contention bound', async () => {
    const f = await open()
    const commit = jest.spyOn(f.store, 'commit')
    try {
      commit.mockResolvedValueOnce({ status: 'conflict', reason: 'synthetic competing writer' })
      await f.runtime.attach(once, request()).done
      expect(commit).toHaveBeenCalledTimes(2)
      expect(commit.mock.calls[0][1]).toEqual(commit.mock.calls[1][1])
      expect((await f.journal.head()).received).toBe('2')
      commit.mockClear().mockResolvedValue({ status: 'conflict', reason: 'synthetic contention' })
      await expect(
        f.runtime.attach(
          {
            ...once,
            async *open() {
              yield batch('next')
            }
          },
          request()
        ).done
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(commit).toHaveBeenCalledTimes(8)
      expect((await f.journal.head()).received).toBe('2')
      commit.mockResolvedValue({ status: 'limited', reason: 'synthetic storage bound' })
      await expect(f.runtime.attach(once, request()).done).rejects.toMatchObject({
        code: 'limited'
      })
    } finally {
      commit.mockRestore()
      await f.runtime.close()
    }
  })

  it('bounds context CAS and preserves the old journal on a failed transition', async () => {
    const f = await open()
    const commit = jest.spyOn(f.store, 'commit')
    const next = { ...context(), id: 'next-context' }
    try {
      commit.mockResolvedValueOnce({ status: 'conflict', reason: 'synthetic competing writer' })
      await f.runtime.setContext(next)
      await f.runtime.flush()
      expect(commit).toHaveBeenCalledTimes(2)
      expect(commit.mock.calls[0][1]).toEqual(commit.mock.calls[1][1])
      commit.mockClear().mockResolvedValue({ status: 'conflict', reason: 'synthetic contention' })
      await expect(f.runtime.setContext({ ...next, id: 'never-committed' })).rejects.toMatchObject({
        code: 'conflict'
      })
      expect(commit).toHaveBeenCalledTimes(8)
      expect((await f.store.read()).context.id).toBe('next-context')
      commit.mockResolvedValue({ status: 'limited', reason: 'synthetic storage bound' })
      await expect(f.runtime.setContext({ ...next, id: 'limited-context' })).rejects.toMatchObject({
        code: 'limited'
      })
      expect((await f.store.read()).context.id).toBe('next-context')
    } finally {
      commit.mockRestore()
      await f.runtime.close()
    }
  })

  it('does not commit a source cancelled while its pending-work check awaits', async () => {
    const entered = deferred(),
      release = deferred()
    const f = await open({
      ...noWork,
      pendingBytes: async () => {
        entered.resolve()
        await release.promise
        return 0
      }
    })
    const subscription = f.runtime.attach(once, request())
    const outcome = subscription.done.then(
      () => undefined,
      error => error
    )
    try {
      await entered.promise
      subscription.close()
      release.resolve()
      expect(await outcome).toMatchObject({ code: 'cancelled' })
      expect((await f.journal.head()).received).toBe('1')
    } finally {
      release.resolve()
      await f.runtime.close()
    }
  })

  it('removes a cancelled queued source without acknowledging its yield', async () => {
    const entered = deferred(),
      release = deferred(),
      queued = deferred()
    let calls = 0,
      acknowledged = false
    const f = await open({
      ...noWork,
      pendingBytes: async () => {
        if (++calls === 1) {
          entered.resolve()
          await release.promise
        }
        return 0
      }
    })
    const first = f.runtime.attach(once, request())
    await entered.promise
    const second = f.runtime.attach(
      {
        id: 'second',
        async *open() {
          queued.resolve()
          const next = batch('second')
          next.provenance.adapter = 'second'
          yield next
          acknowledged = true
        }
      },
      request()
    )
    const outcome = second.done.then(
      () => undefined,
      error => error
    )
    try {
      await queued.promise
      // The first pending-work check owns the serialized receipt queue.
      await Promise.resolve()
      second.close()
      release.resolve()
      await first.done
      expect(await outcome).toMatchObject({ code: 'cancelled' })
      expect(acknowledged).toBe(false)
      expect(calls).toBe(1)
      expect((await f.journal.head()).received).toBe('2')
    } finally {
      release.resolve()
      await f.runtime.close()
    }
  })

  it('keeps physical worker capacity occupied through cancellation and closes observers', async () => {
    const entered = deferred(),
      release = deferred()
    let hold = false
    const f = await open(
      {
        ...noWork,
        advance: async () => {
          if (hold) {
            entered.resolve()
            await release.promise
          }
        }
      },
      undefined,
      { verificationConcurrency: 1 }
    )
    const observer = f.runtime.events(new AbortController().signal)[Symbol.asyncIterator]()
    hold = true
    const work = f.runtime.flush().then(
      () => undefined,
      error => error
    )
    try {
      await entered.promise
      await expect(
        f.runtime.attach(once, { ...request(), limits: { ...f.runtime.limits } }).done
      ).rejects.toMatchObject({
        code: 'limited'
      })
      expect((await f.journal.head()).received).toBe('1')
      expect((await observer.next()).value).toMatchObject({ kind: 'error', code: 'limited' })
      await f.runtime.close()
      expect(await work).toMatchObject({ code: 'cancelled' })
      release.resolve()
      expect((await observer.next()).done).toBe(true)
    } finally {
      release.resolve()
      await observer.return?.()
      await f.runtime.close()
    }
  })
})
