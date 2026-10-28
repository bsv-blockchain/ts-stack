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
import {
  DEFAULT_JOURNAL_LIMITS,
  journalEntryBytes,
  journalPayload
} from '../src/storage/Journal.js'

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
  it.each(['committed', 'replayed'] as const)(
    'wakes an installed watcher immediately after durable append reports %s',
    async status => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      const store = new KnowledgeStore(
          wrapper(storage, {
            async append(expected, mutation, local) {
              if (status === 'replayed') await storage.append(expected, mutation, local)
              return storage.append(expected, mutation, local)
            }
          }),
          reducer(),
          { partition, pollMs: 1000 }
        ),
        controller = new AbortController(),
        watcher = store.watch('1', controller.signal)[Symbol.asyncIterator]()
      let delivered = false
      const waiting = watcher.next().then(value => {
        delivered = true
        return value
      })
      void waiting.catch(() => undefined)
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(delivered).toBe(false)
        expect((await store.commit('1', invalidation())).status).toBe(status)
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(delivered).toBe(true)
        expect((await waiting).value?.revision).toEqual({ received: '2', accepted: '2' })
      } finally {
        controller.abort()
        await jest.advanceTimersByTimeAsync(1000)
        await waiting.catch(() => undefined)
        await watcher.return?.()
        await store.close()
        jest.useRealTimers()
      }
    }
  )

  it('advances receipt and accepted frontiers independently for an unaccepted source batch', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition })
    try {
      await store.commit('0', initial())
      const scope = {
        chain: context().view.chain,
        provider: 'source',
        service: 'records',
        queryDigest: '11'.repeat(32),
        rulesDigest: '22'.repeat(32),
        access: 'public',
        epoch: 'one'
      }
      const receipt = knowledgeMutation({
        kind: 'receive',
        batch: {
          provenance: {
            partition,
            generation: '0',
            adapter: 'test',
            scope,
            authentication: 'configured-transport',
            peer: 'source',
            receivedAt: '1'
          },
          groups: [],
          coverage: { scope, phase: 'finite', status: 'complete' }
        }
      })
      expect(await store.commit('1', receipt)).toMatchObject({
        status: 'committed',
        revision: { received: '2', accepted: '1' }
      })
      expect((await store.read()).revision).toEqual({ received: '2', accepted: '1' })
      expect(await store.commit('2', invalidation())).toMatchObject({
        status: 'committed',
        revision: { received: '3', accepted: '2' }
      })
    } finally {
      await store.close()
    }
  })

  it.each(['digest', 'receipt gap', 'head bytes', 'empty page', 'future page'] as const)(
    'rejects a journal %s fault before invoking the reducer',
    async fault => {
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      await storage.append('1', invalidation())
      const entries = await storage.read('0', 2),
        head = await storage.head()
      if (fault === 'digest' && entries[1].body.kind === 'invalidate') {
        entries[1].body.reason = 'modified without a matching digest'
        head.bytes = entries.reduce((bytes, entry) => bytes + journalEntryBytes(entry), 0)
      }
      if (fault === 'receipt gap') {
        entries[1].revision.received = '3'
        head.received = '3'
      }
      if (fault === 'head bytes') head.bytes++
      const reduce = jest.fn(reducer().reduce),
        read = jest.fn(async () =>
          fault === 'empty page'
            ? []
            : fault === 'future page'
              ? [{ ...entries[0], revision: { received: '3', accepted: '1' } }]
              : entries
        ),
        store = new KnowledgeStore(
          wrapper(storage, { head: async () => head, read }),
          { reduce },
          { partition }
        )
      try {
        const reason =
          fault === 'empty page'
            ? 'history is incomplete'
            : fault === 'future page'
              ? 'no contiguous progress'
              : fault === 'head bytes'
                ? 'head does not match'
                : 'integrity or revision continuity'
        await expect(store.read()).rejects.toMatchObject({
          code: 'reset-required',
          message: expect.stringContaining(reason)
        })
        expect(reduce).not.toHaveBeenCalled()
        expect(read).toHaveBeenCalledTimes(1)
        expect(await storage.head()).toMatchObject({ received: '2', accepted: '2', entries: 2 })
      } finally {
        await store.close()
      }
    }
  )

  it.each(['read', 'revision'] as const)(
    'rejects %s before its retained resume checkpoint',
    async operation => {
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      const read = jest.fn(storage.read.bind(storage)),
        store = new KnowledgeStore(wrapper(storage, { read }), reducer(), {
          partition,
          minimumReceived: '2'
        })
      try {
        await expect(store[operation]()).rejects.toMatchObject({
          code: 'reset-required',
          message: expect.stringContaining('retained resume checkpoint')
        })
        expect(read).not.toHaveBeenCalled()
      } finally {
        await store.close()
      }
    }
  )

  it('rejects a noncanonical requested revision before storage I/O', async () => {
    const storage = new MemoryJournal('test'),
      head = jest.fn(storage.head.bind(storage)),
      store = new KnowledgeStore(wrapper(storage, { head }), reducer(), { partition })
    try {
      await expect(store.read('01')).rejects.toMatchObject({ code: 'invalid' })
      expect(head).not.toHaveBeenCalled()
    } finally {
      await store.close()
    }
  })

  it('holds operation capacity until cancelled storage work actually drains', async () => {
    const storage = new MemoryJournal('test')
    await storage.append('0', initial())
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => {
        release = resolve
      }),
      started = new Promise<void>(resolve => {
        entered = resolve
      }),
      head = jest.fn(async () => {
        entered()
        await blocked
        return storage.head()
      }),
      store = new KnowledgeStore(wrapper(storage, { head }), reducer(), {
        partition,
        maximumReaders: 1
      }),
      controller = new AbortController(),
      first = store.read(undefined, controller.signal)
    try {
      await started
      await expect(store.read()).rejects.toMatchObject({
        code: 'limited',
        message: expect.stringContaining('operation capacity')
      })
      controller.abort()
      await expect(first).rejects.toMatchObject({
        code: 'cancelled',
        message: expect.stringContaining('operation interrupted')
      })
      await expect(store.read()).rejects.toMatchObject({ code: 'limited' })
      expect(head).toHaveBeenCalledTimes(1)
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect((await store.read()).revision).toEqual({ received: '1', accepted: '1' })
      expect(head).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await first.catch(() => undefined)
      await store.close()
    }
  })

  it.each(['entries', 'bytes'] as const)(
    'rejects a retained %s overflow before requesting a journal page',
    async bound => {
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      await storage.append('1', invalidation())
      const head = await storage.head(),
        read = jest.fn(storage.read.bind(storage)),
        store = new KnowledgeStore(wrapper(storage, { read }), reducer(), {
          partition,
          ...(bound === 'entries' ? { maximumEntries: 1 } : { maximumBytes: head.bytes - 1 })
        })
      try {
        await expect(store.read()).rejects.toMatchObject({
          code: 'limited',
          message: expect.stringContaining('replay retention bound')
        })
        expect(read).not.toHaveBeenCalled()
        expect(await storage.head()).toEqual(head)
      } finally {
        await store.close()
      }
    }
  )

  it.each([1, 200])(
    'bounds storage page requests with a retention limit of %i',
    async maximumEntries => {
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      const read = jest.fn(storage.read.bind(storage)),
        store = new KnowledgeStore(wrapper(storage, { read }), reducer(), {
          partition,
          maximumEntries
        })
      try {
        expect((await store.read()).revision.accepted).toBe('1')
        expect(read).toHaveBeenCalledWith('0', Math.min(128, maximumEntries))
      } finally {
        await store.close()
      }
    }
  )

  it('rejects a mismatched mutation digest and a stale CAS before durable append', async () => {
    const storage = new MemoryJournal('test'),
      append = jest.fn(storage.append.bind(storage)),
      store = new KnowledgeStore(wrapper(storage, { append }), reducer(), { partition })
    try {
      await expect(store.commit('0', { ...initial(), key: 'ff'.repeat(32) })).rejects.toMatchObject(
        {
          code: 'invalid',
          message: expect.stringContaining('digest mismatch')
        }
      )
      expect(append).not.toHaveBeenCalled()
      expect(await store.commit('1', initial())).toMatchObject({
        status: 'conflict',
        reason: expect.stringContaining('revision changed')
      })
      expect(append).not.toHaveBeenCalled()
      expect((await store.commit('0', initial())).status).toBe('committed')
      expect(append).toHaveBeenCalledTimes(1)
    } finally {
      await store.close()
    }
  })

  it.each([-1, 0, 1])(
    'enforces the cumulative retention byte boundary with %i bytes of headroom',
    async headroom => {
      const first = initial(),
        second = invalidation(),
        bytes =
          journalPayload(first, DEFAULT_JOURNAL_LIMITS).bytes +
          journalPayload(second, DEFAULT_JOURNAL_LIMITS).bytes,
        storage = new MemoryJournal('test'),
        store = new KnowledgeStore(storage, reducer(), {
          partition,
          maximumBytes: bytes + headroom
        })
      try {
        expect((await store.commit('0', first)).status).toBe('committed')
        const result = await store.commit('1', second)
        expect(result.status).toBe(headroom < 0 ? 'limited' : 'committed')
        if (headroom < 0)
          expect(result).toMatchObject({
            reason: expect.stringContaining('Knowledge retention bound')
          })
        expect((await store.read()).revision).toEqual(
          headroom < 0 ? { received: '1', accepted: '1' } : { received: '2', accepted: '2' }
        )
        expect(await storage.head()).toMatchObject({
          bytes: headroom < 0 ? journalPayload(first, DEFAULT_JOURNAL_LIMITS).bytes : bytes
        })
      } finally {
        await store.close()
      }
    }
  )

  it.each(['accepted revision', 'duplicate key', 'underreported entries'] as const)(
    'fails closed on retained journal %s without publishing a snapshot',
    async fault => {
      const storage = new MemoryJournal('test')
      await storage.append('0', initial())
      await storage.append('1', invalidation())
      const entries = await storage.read('0', 2),
        head = await storage.head()
      if (fault === 'accepted revision') entries[1].revision.accepted = '1'
      if (fault === 'duplicate key') {
        entries[1] = { ...structuredClone(entries[0]), revision: { received: '2', accepted: '2' } }
        head.bytes = entries.reduce((bytes, entry) => bytes + journalEntryBytes(entry), 0)
      }
      if (fault === 'underreported entries') head.entries = 1
      const store = new KnowledgeStore(
        wrapper(storage, {
          head: async () => head,
          read: async () => structuredClone(entries)
        }),
        reducer(),
        { partition, ...(fault === 'underreported entries' ? { maximumEntries: 1 } : {}) }
      )
      try {
        await expect(store.read()).rejects.toMatchObject({
          code: fault === 'underreported entries' ? 'limited' : 'reset-required',
          message: expect.stringContaining(
            fault === 'underreported entries'
              ? 'replay retention bound'
              : 'integrity or revision continuity'
          )
        })
        expect(await storage.head()).toMatchObject({ received: '2', accepted: '2', entries: 2 })
      } finally {
        await store.close()
      }
    }
  )

  it.each<[string, (input: AcceptedInput) => void]>([
    [
      'partition',
      input => {
        input.partition = { ...partition, account: 'other' }
      }
    ],
    [
      'context partition',
      input => {
        input.context.partition = { ...partition, account: 'other' }
      }
    ],
    [
      'generation',
      input => {
        input.generation = '1'
      }
    ],
    [
      'received revision',
      input => {
        input.revision.received = '2'
      }
    ],
    [
      'accepted revision',
      input => {
        input.revision.accepted = '2'
      }
    ],
    [
      'context identity',
      input => {
        input.reconciled.contextId = 'other'
      }
    ],
    [
      'journal identity',
      input => {
        input.reconciled.journalId = 'other'
      }
    ],
    [
      'reconciliation frontier',
      input => {
        input.reconciled.through = '2'
      }
    ]
  ])('rejects a reducer with an inconsistent %s before appending', async (_, corrupt) => {
    const storage = new MemoryJournal('test'),
      honest = reducer(),
      store = new KnowledgeStore(
        storage,
        {
          async reduce(entries, signal) {
            // A reducer is an installed port, not authority to change the journal identity.
            const input = JSON.parse(
              JSON.stringify(await honest.reduce(entries, signal))
            ) as AcceptedInput
            corrupt(input)
            return input
          }
        },
        { partition }
      )
    try {
      await expect(store.commit('0', initial())).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('inconsistent knowledge snapshot')
      })
      expect(await storage.head()).toMatchObject({ received: '0', accepted: '0', entries: 0 })
    } finally {
      await store.close()
    }
  })

  it('distinguishes receipt revisions from accepted revisions in retained history', async () => {
    const storage = new MemoryJournal('test'),
      store = new KnowledgeStore(storage, reducer(), { partition })
    try {
      expect(await store.commit('0', initial())).toMatchObject({
        status: 'committed',
        revision: { received: '1', accepted: '1' }
      })
      // The store owns revision assignment even for a reducer that accepts empty receipts.
      const receipt = knowledgeMutation({
        kind: 'receive',
        batch: {
          provenance: {
            partition,
            generation: '0',
            adapter: 'fixture',
            scope: {
              chain: context().view.chain,
              provider: 'fixture',
              service: 'records',
              queryDigest: '03'.repeat(32),
              rulesDigest: '04'.repeat(32),
              access: 'public',
              epoch: 'one'
            },
            authentication: 'configured-transport',
            peer: 'fixture',
            receivedAt: '1'
          },
          groups: [],
          coverage: {
            scope: {
              chain: context().view.chain,
              provider: 'fixture',
              service: 'records',
              queryDigest: '03'.repeat(32),
              rulesDigest: '04'.repeat(32),
              access: 'public',
              epoch: 'one'
            },
            phase: 'finite',
            status: 'complete'
          }
        }
      })
      expect(await store.commit('1', receipt)).toMatchObject({
        status: 'committed',
        revision: { received: '2', accepted: '1' }
      })
      expect(await store.commit('2', invalidation())).toMatchObject({
        status: 'committed',
        revision: { received: '3', accepted: '2' }
      })
      expect((await store.read('1')).revision).toEqual({ received: '2', accepted: '1' })
      expect((await store.read()).revision).toEqual({ received: '3', accepted: '2' })
      expect(await store.commit('0', receipt)).toMatchObject({
        status: 'replayed',
        revision: { received: '2', accepted: '1' }
      })
      expect(await storage.head()).toMatchObject({ received: '3', accepted: '2', entries: 3 })
    } finally {
      await store.close()
    }
  })

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
      abort = new AbortController(),
      first = new KnowledgeStore(
        wrapper(storage, {
          head: () => {
            // Cancellation must prevent another journal read from starting.
            expect(abort.signal.aborted).toBe(false)
            return storage.head()
          }
        }),
        reducer(),
        { partition, pollMs: 5 }
      ),
      second = new KnowledgeStore(storage, reducer(), { partition })
    await first.commit('0', initial())
    const iterator = first.watch('0', abort.signal)[Symbol.asyncIterator]()
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
  const storage = new MemoryJournal('test')
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
  const store = new KnowledgeStore(
    wrapper(storage, {
      head: () => {
        expect(abort.signal.aborted).toBe(false)
        return storage.head()
      }
    }),
    reducer(),
    { partition, pollMs: 1000 }
  )
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
