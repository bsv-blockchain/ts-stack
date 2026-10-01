import { describe, expect, it, jest } from '@jest/globals'
import { OutputProtocolError } from '@bsv/sdk'
import {
  KnowledgeStore,
  type KnowledgeReducer,
  type KnowledgeStoreOptions
} from '../src/KnowledgeStore.js'
import {
  MemoryJournal,
  knowledgeMutation,
  type AcceptedInput,
  type Currentness,
  type JournalStorage
} from '../src/index.js'
import { context, partition } from './evidence-fixture.js'

import { emptyReducer as reducer } from './empty-reducer.js'

const initial = () => knowledgeMutation({ kind: 'context', context: context() })
const invalidation = (reason = 'local expiry') =>
  knowledgeMutation({ kind: 'invalidate', generation: '0', assessmentIds: [], reason })
function wrapper(storage: JournalStorage, overrides: Partial<JournalStorage>): JournalStorage {
  return {
    namespace: storage.namespace,
    durability: storage.durability,
    head: storage.head.bind(storage),
    read: storage.read.bind(storage),
    getMutation: storage.getMutation.bind(storage),
    append: storage.append.bind(storage),
    close: storage.close.bind(storage),
    ...overrides
  }
}

describe('knowledge store journal port', () => {
  it.each<[keyof KnowledgeStoreOptions, number]>([
    ['maximumEntries', 0],
    ['maximumEntries', 4097],
    ['maximumBytes', 64 * 1024 * 1024 + 1],
    ['deadlineMs', 60001],
    ['maximumReaders', 65],
    ['pollMs', 1001],
    ['pollMs', 1.5],
    ['maximumEntries', Number.NaN]
  ])('rejects invalid %s configuration before using its journal', (key, value) => {
    expect(
      () => new KnowledgeStore(new MemoryJournal('test'), reducer(), { partition, [key]: value })
    ).toThrow('store bound')
  })

  it('fails closed when stable mutation lookup is unavailable and allows an exact retry after recovery', async () => {
    const storage = new MemoryJournal('test')
    let available = false
    const store = new KnowledgeStore(
      wrapper(storage, {
        getMutation: key =>
          available
            ? storage.getMutation(key)
            : Promise.resolve({ status: 'unavailable', reason: 'Journal temporarily unreachable' })
      }),
      reducer(),
      { partition }
    )
    try {
      await expect(store.commit('0', initial())).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true
      })
      expect((await storage.head()).received).toBe('0')
      available = true
      expect((await store.commit('0', initial())).status).toBe('committed')
      expect((await store.commit('0', initial())).status).toBe('replayed')
    } finally {
      await store.close()
    }
  })

  it('rejects an unrecognized mutation digest and unavailable historical revision without appending', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition })
    try {
      await expect(store.read()).rejects.toMatchObject({ code: 'revision-unavailable' })
      await expect(store.commit('0', { ...initial(), key: 'ff'.repeat(32) })).rejects.toMatchObject(
        { code: 'invalid' }
      )
      expect((await storage.head()).received).toBe('0')
      await store.commit('0', initial())
      await expect(store.read('0')).rejects.toMatchObject({ code: 'revision-unavailable' })
      expect((await storage.head()).received).toBe('1')
    } finally {
      await store.close()
    }
  })

  it('bounds concurrent watches independently of operations and rejects a future watch checkpoint', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition, maximumReaders: 1 })
    const abort = new AbortController()
    try {
      await store.commit('0', initial())
      const future = store.watch('2')[Symbol.asyncIterator]()
      await expect(future.next()).rejects.toMatchObject({ code: 'reset-required' })
      const first = store.watch('0', abort.signal)[Symbol.asyncIterator]()
      expect((await first.next()).value?.revision.accepted).toBe('1')
      const second = store.watch('1')[Symbol.asyncIterator]()
      await expect(second.next()).rejects.toMatchObject({ code: 'limited' })
      abort.abort()
      await first.return?.()
      const recovered = store.watch('0')[Symbol.asyncIterator]()
      expect((await recovered.next()).value?.revision.accepted).toBe('1')
      await recovered.return?.()
    } finally {
      abort.abort()
      await store.close()
    }
  })
  it('persists protocol-generated validation material with its mutation and reconstructs it after reopening the store port', async () => {
    const storage = new MemoryJournal('test'),
      simple = reducer()
    let prepared = 0
    const validating: KnowledgeReducer = {
      reduce: simple.reduce,
      async prepare(entries, signal) {
        prepared++
        return {
          input: await simple.reduce(entries, signal),
          local: {
            profile: 'urn:example:local-verification',
            version: 1,
            evidence: ['receipt-one']
          }
        }
      }
    }
    const first = new KnowledgeStore(storage, validating, { partition }),
      initialMutation = initial()
    expect((await first.commit('0', initialMutation)).status).toBe('committed')
    expect(prepared).toBe(1)
    const recovered = new KnowledgeStore(
      storage,
      {
        async reduce(entries, signal) {
          expect(entries[0].local?.evidence).toEqual(['receipt-one'])
          return simple.reduce(entries, signal)
        }
      },
      { partition, minimumReceived: '1' }
    )
    expect((await recovered.read()).revision.received).toBe('1')
    expect((await recovered.inspect()).entries[0].local?.profile).toBe(
      'urn:example:local-verification'
    )
    expect((await recovered.commit('0', initialMutation)).status).toBe('replayed')
    expect(prepared).toBe(1)
    await first.close()
    await recovered.close()
  })
  it('validates prospective state before commit and resolves duplicate keys before CAS or reducer replay', async () => {
    let count = 0
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(
        storage,
        reducer({
          before: async entries => {
            count++
            if (entries.at(-1)!.body.kind === 'invalidate')
              throw new OutputProtocolError('invalid', 'Rejected transition')
          }
        }),
        { partition }
      )
    const first = initial()
    expect(await store.getMutation(first.key)).toEqual({ status: 'absent' })
    expect((await store.commit('0', first)).status).toBe('committed')
    expect(await store.getMutation(first.key)).toMatchObject({
      status: 'committed',
      entry: { key: first.key, body: first.body, revision: { received: '1', accepted: '1' } }
    })
    expect((await store.commit('999', first)).status).toBe('replayed')
    expect(count).toBe(1)
    await expect(store.commit('1', invalidation())).rejects.toThrow('Rejected transition')
    expect((await storage.head()).received).toBe('1')
    expect((await store.read()).revision).toEqual({ received: '1', accepted: '1' })
    await expect(store.read('2')).rejects.toMatchObject({ code: 'revision-unavailable' })
    const changed = { key: first.key, body: invalidation().body }
    expect((await store.commit('1', changed)).status).toBe('equivocation')
    await store.close()
    await expect(store.getMutation(first.key)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('admits one of two racing CAS commits and never publishes the losing prospective state', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition })
    await store.commit('0', initial())
    const results = await Promise.all([
      store.commit('1', invalidation('one')),
      store.commit('1', invalidation('two'))
    ])
    expect(results.map(result => result.status).sort()).toEqual(['committed', 'conflict'])
    expect((await store.read()).revision).toEqual({ received: '2', accepted: '2' })
    await store.close()
  })

  it('recovers an uncertain commit by exact key without rerunning the reducer', async () => {
    const storage = new MemoryJournal('test')
    let count = 0
    const uncertain = wrapper(storage, {
      async append(expected, mutation) {
        await storage.append(expected, mutation)
        throw new Error('connection lost after commit')
      }
    })
    const store = new KnowledgeStore(
      uncertain,
      reducer({
        before: async () => {
          count++
        }
      }),
      { partition }
    )
    expect((await store.commit('0', initial())).status).toBe('replayed')
    expect(count).toBe(1)
    expect((await store.read()).revision.received).toBe('1')
    await store.close()
  })

  it('rejects a lost namespace, altered journal bytes, and revision gaps', async () => {
    const empty = new KnowledgeStore(new MemoryJournal('test'), reducer(), {
      partition,
      minimumReceived: '1'
    })
    await expect(empty.read()).rejects.toMatchObject({ code: 'reset-required' })
    await empty.close()
    const storage = new MemoryJournal('test')
    await storage.append('0', initial())
    const corrupt = new KnowledgeStore(
      wrapper(storage, {
        async read(after, maximum) {
          const entries = await storage.read(after, maximum)
          entries[0].body = invalidation().body
          return entries
        }
      }),
      reducer(),
      { partition }
    )
    await expect(corrupt.read()).rejects.toMatchObject({ code: 'reset-required' })
    const gap = new KnowledgeStore(
      wrapper(storage, {
        async read(after, maximum) {
          const entries = await storage.read(after, maximum)
          entries[0].revision.received = '2'
          return entries
        }
      }),
      reducer(),
      { partition }
    )
    await expect(gap.read()).rejects.toMatchObject({ code: 'reset-required' })
    await corrupt.close()
    await gap.close()
  })

  it('watches every accepted revision and wakes across independent store instances', async () => {
    const storage = new MemoryJournal('test'),
      first = new KnowledgeStore(storage, reducer(), { partition, pollMs: 5 }),
      second = new KnowledgeStore(storage, reducer(), { partition })
    await first.commit('0', initial())
    const abort = new AbortController(),
      iterator = first.watch('0', abort.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.revision.accepted).toBe('1')
    const waiting = iterator.next()
    await second.commit('1', invalidation())
    expect((await waiting).value?.revision.accepted).toBe('2')
    const cancelled = iterator.next()
    abort.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    await first.close()
    await second.close()
  })

  it('closes pending watches, refuses cross-partition state, and bounds retention', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition, maximumEntries: 1 })
    await store.commit('0', initial())
    expect((await store.commit('1', invalidation())).status).toBe('limited')
    const watch = store.watch('1')[Symbol.asyncIterator]().next()
    await store.close()
    await expect(watch).rejects.toMatchObject({ code: 'cancelled' })
    const other = new KnowledgeStore(new MemoryJournal('test'), reducer(), {
      partition: { ...partition, account: 'bob' }
    })
    await expect(other.commit('0', initial())).rejects.toThrow('inconsistent')
    await other.close()
  })

  it('bounds non-abortable reducer work and prevents a late preparation from committing', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(
        storage,
        reducer({
          before: async () => {
            await blocked
          }
        }),
        { partition, deadlineMs: 10, maximumReaders: 1 }
      )
    await expect(store.commit('0', initial())).rejects.toMatchObject({ code: 'limited' })
    await expect(store.commit('0', initial())).rejects.toMatchObject({ code: 'limited' })
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await storage.head()).received).toBe('0')
    await store.close()
  })

  it('does not expose expired assessments when an expiry timer is delayed', async () => {
    const assessment = {
      id: '01'.repeat(32),
      state: 'reported-unspent',
      expiresAt: '1'
    } as Currentness
    const store = new KnowledgeStore(
      new MemoryJournal('test'),
      reducer({ assessments: [assessment] }),
      { partition, now: () => 2000 }
    )
    await store.commit('0', initial())
    await expect(store.read()).rejects.toMatchObject({ code: 'expired' })
    await store.close()
  })

  it('returns owned coherent snapshots even when callers change their copy', async () => {
    const store = new KnowledgeStore(new MemoryJournal('test'), reducer(), { partition })
    await store.commit('0', initial())
    const snapshot: AcceptedInput = await store.read()
    snapshot.context.partition.account = 'changed'
    snapshot.revision.received = '999'
    expect((await store.read()).context.partition).toEqual(partition)
    expect((await store.read()).revision.received).toBe('1')
    await store.close()
  })
  it('requires complete contiguous pages and a head matching every retained byte and revision', async () => {
    const storage = new MemoryJournal('test')
    await storage.append('0', initial())
    const head = await storage.head()
    const overrides: Partial<JournalStorage>[] = [
      { read: async () => [] },
      { head: async () => ({ ...head, accepted: '0' }) },
      { head: async () => ({ ...head, entries: 2 }) },
      { head: async () => ({ ...head, bytes: head.bytes + 1 }) },
      {
        read: async () =>
          (await storage.read('0', 1)).map(row => ({
            ...row,
            revision: { received: '2', accepted: '1' }
          }))
      }
    ]
    for (const override of overrides) {
      const store = new KnowledgeStore(
        wrapper(storage, { ...override, close: async () => {} }),
        reducer(),
        { partition }
      )
      await expect(store.inspect()).rejects.toMatchObject({ code: 'reset-required' })
      await store.close()
    }
    await storage.close()
  })

  it('replays one coherent head while ignoring a later concurrently appended page entry', async () => {
    const storage = new MemoryJournal('test')
    await storage.append('0', initial())
    const head = await storage.head()
    await storage.append('1', invalidation())
    const store = new KnowledgeStore(wrapper(storage, { head: async () => head }), reducer(), {
      partition
    })
    expect((await store.inspect()).revision).toEqual({ received: '1', accepted: '1' })
    expect((await store.read()).revision).toEqual({ received: '1', accepted: '1' })
    await store.close()
  })

  it('rejects lost checkpoints and replay growth exceeding configured entries or bytes', async () => {
    const storage = new MemoryJournal('test')
    await storage.append('0', initial())
    await storage.append('1', invalidation())
    const controls = [{ maximumEntries: 1 }, { maximumBytes: 1 }, { minimumReceived: '3' }]
    for (const control of controls) {
      const store = new KnowledgeStore(wrapper(storage, { close: async () => {} }), reducer(), {
        partition,
        ...control
      })
      await expect(store.inspect()).rejects.toMatchObject({
        code: 'minimumReceived' in control ? 'reset-required' : 'limited'
      })
      if ('minimumReceived' in control)
        await expect(store.revision()).rejects.toMatchObject({ code: 'reset-required' })
      await store.close()
    }
    const head = await storage.head()
    const underreported = new KnowledgeStore(
      wrapper(storage, { head: async () => ({ ...head, bytes: 1 }), close: async () => {} }),
      reducer(),
      { partition, maximumBytes: 2 }
    )
    await expect(underreported.inspect()).rejects.toMatchObject({ code: 'limited' })
    await underreported.close()
    await storage.close()
  })
})

it('cancels a watch that has entered its wait and releases its polling timer on close', async () => {
  jest.useFakeTimers()
  const store = new KnowledgeStore(new MemoryJournal('test'), reducer(), {
    partition,
    pollMs: 1000
  })
  try {
    await store.commit('0', initial())
    const waiting = store.watch('1')[Symbol.asyncIterator]().next()
    const cancelled = expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    await jest.advanceTimersByTimeAsync(0)
    expect(jest.getTimerCount()).toBe(1)
    await store.close()
    await cancelled
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    await store.close()
    jest.useRealTimers()
  }
})

it('handles a signal cancelled during listener registration without waiting for the poll interval', async () => {
  jest.useFakeTimers()
  const abort = new AbortController()
  const add = abort.signal.addEventListener.bind(abort.signal)
  let registrations = 0
  // Model a caller-provided signal whose registration hook triggers cancellation
  // before the native listener is installed; its already-aborted flag must win.
  const registration = jest
    .spyOn(abort.signal, 'addEventListener')
    .mockImplementation((...args) => {
      if (++registrations === 2) abort.abort()
      add(...args)
    })
  const store = new KnowledgeStore(new MemoryJournal('test'), reducer(), {
    partition,
    pollMs: 1000
  })
  try {
    await store.commit('0', initial())
    await expect(
      store.watch('1', abort.signal)[Symbol.asyncIterator]().next()
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(registrations).toBe(2)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    registration.mockRestore()
    await store.close()
    jest.useRealTimers()
  }
})
