import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalOutputJSON,
  OutputProtocolError,
  outputServiceErrorHTTPStatus,
  type OutputJSONObject
} from '@bsv/sdk'
import { context } from './evidence-fixture.js'
import { LiveLookupSource, type LiveLookupSourceOptions } from '../src/sources/LiveLookupSource.js'
import {
  prepareLiveLookupSource,
  liveLookupSourceBinding
} from '../src/sources/LiveLookupConfiguration.js'
import { MemoryOperationStateStore } from '../src/operations/MemoryOperationStateStore.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import type { SourceBatch } from '../src/ports.js'
import { liveFixture, liveStores } from './live-lookup-fixture.js'

const directories: string[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map(close => close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function resumeLookupSource(
  input: LiveLookupSource | LiveLookupSourceOptions,
  signal?: AbortSignal
) {
  const source = input instanceof LiveLookupSource ? input : new LiveLookupSource(input)
  return { source, request: await source.connect(signal) }
}
async function harness(configuration: Parameters<typeof liveFixture>[0] = {}) {
  const path = await mkdtemp(join(tmpdir(), 'live-lookup-'))
  directories.push(path)
  const fixture = liveFixture(configuration)
  const stores = await liveStores(path, fixture)
  cleanup.push(
    () => stores.core.close(),
    () => stores.control.close()
  )
  const fetch = jest
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(fixture.response()))
  const options: LiveLookupSourceOptions = {
    configuration: fixture.config,
    ...stores,
    trust: fixture.selection,
    fetch,
    now: () => 1000000
  }
  return { path, fixture, stores, fetch, options, source: new LiveLookupSource(options) }
}
async function receive(h: Awaited<ReturnType<typeof harness>>, batch: SourceBatch) {
  const revision = await h.stores.core.revision()
  return h.stores.core.commit(revision.received, knowledgeMutation({ kind: 'receive', batch }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function liveResponses(h: Awaited<ReturnType<typeof harness>>) {
  h.fetch.mockImplementation((_url, init) => {
    const body = JSON.parse(String(init?.body)) as OutputJSONObject
    return Promise.resolve(
      h.fixture.response(
        body.requestId
          ? h.fixture.packet
          : {
              ...h.fixture.packet,
              phase: 'live',
              cursor: 'cursor-live'
            }
      )
    )
  })
}

describe('durable live lookup source', () => {
  it('binds private lookup recovery to the authenticated provider identity', () => {
    const f = liveFixture({}, undefined, 'brc103')
    expect(f.config.scope.provider).toBe(f.selection.identity)
    expect(f.prepared.binding.scope).toEqual(f.config.scope)
    expect(() =>
      prepareLiveLookupSource({
        ...f.options,
        configuration: {
          ...f.config,
          scope: {
            ...f.config.scope,
            provider: new URL(f.selection.baseURL).origin
          }
        }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('local binding')
      })
    )
  })

  it('permits one pull at a time and permanently closes an iterator after return', async () => {
    const h = await harness()
    const request = await h.source.connect()
    const iterator = h.source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const read = iterator.next()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'limited' })
    expect((await read).done).toBe(false)
    expect(await iterator.return!()).toEqual({ done: true, value: undefined })
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(await iterator.return!()).toEqual({ done: true, value: undefined })
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([0, 75, 200, -100])(
    'paces a live-head read after a clock change of %i ms',
    async elapsed => {
      const h = await harness({ minimumPollMs: 100 })
      let now = 1000000
      const source = new LiveLookupSource({ ...h.options, now: () => now })
      liveResponses(h)
      const request = await source.connect()
      const abort = new AbortController()
      const iterator = source.open(request, abort.signal)[Symbol.asyncIterator]()
      await receive(h, (await iterator.next()).value as SourceBatch)
      await receive(h, (await iterator.next()).value as SourceBatch)
      jest.useFakeTimers()
      now += elapsed
      const next = iterator.next().then(
        value => ({ value }),
        (error: unknown) => ({ error })
      )
      try {
        const delay = Math.min(100, Math.max(0, 100 - elapsed))
        await jest.advanceTimersByTimeAsync(0)
        if (delay > 0) {
          await jest.advanceTimersByTimeAsync(delay - 1)
          expect(h.fetch).toHaveBeenCalledTimes(2)
          await jest.advanceTimersByTimeAsync(1)
        }
        expect(await next).toMatchObject({ value: { done: false } })
        expect(h.fetch).toHaveBeenCalledTimes(3)
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        abort.abort()
        await next
        await iterator.return!()
      }
    }
  )

  it('prepares a bounded original opening before I/O and reconstructs stable recovery binding', () => {
    const f = liveFixture()
    expect(f.open.requestId).toMatch(/^[a-f0-9]{64}$/)
    expect(f.open.limits.maxBytes).toBeLessThan(f.options.limits.maxBytes)
    expect(f.open.limits.maxBytes).toBeGreaterThan(65536)
    expect(f.prepared.binding).toEqual(liveLookupSourceBinding(f.config))
    expect(prepareLiveLookupSource(f.options).initial.original).not.toEqual(
      f.prepared.initial.original
    )
    expect(() =>
      prepareLiveLookupSource({ ...f.options, controlLimits: { stateBytes: 1000 } })
    ).toThrow()
    expect(() =>
      prepareLiveLookupSource({ ...f.options, query: { collection: 'changed' } })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('local binding')
      })
    )
    expect(() => liveFixture({ minimumPollMs: 20, operationTimeoutMs: 20 })).toThrow(
      expect.objectContaining({ code: 'invalid', message: expect.stringContaining('polling') })
    )
    expect(() =>
      prepareLiveLookupSource({
        ...f.options,
        configuration: { ...f.config, operationTimeoutMs: 20 },
        limits: { ...f.open.limits, waitMs: 19 }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('operation deadline')
      })
    )
    expect(() =>
      prepareLiveLookupSource({
        ...f.options,
        selection: { ...f.selection, supportedExtensions: ['https://example.test/extension'] }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('no critical')
      })
    )
    for (const invalid of [0, -1, 1.5, Number.NaN, 30001])
      expect(() => liveFixture({ minimumPollMs: invalid })).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: expect.stringContaining('timing bound')
        })
      )
  })

  it('rejects recovery under another profile or a stored allowance larger than local framing capacity', async () => {
    const h = await harness()
    const changed = new LiveLookupSource({
      ...h.options,
      trust: { ...h.options.trust, profile: 'https://example.test/other-profile' }
    })
    await expect(changed.connect()).rejects.toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('BRC-193 lookup profile')
      })
    )
    const saved = await h.stores.control.read()
    const original = saved.value.original as OutputJSONObject
    const open = original.open as OutputJSONObject
    await h.stores.control.compareAndSwap(saved.revision, {
      ...saved.value,
      original: {
        ...original,
        open: { ...open, limits: { ...(open.limits as OutputJSONObject), maxBytes: 4194304 } }
      }
    })
    await expect(h.source.connect()).rejects.toThrow(
      expect.objectContaining({
        code: 'limited',
        message: expect.stringContaining('framing capacity')
      })
    )
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('captures before yielding and refuses cursor advancement without the exact core receipt', async () => {
    const h = await harness()
    const { source, request } = await resumeLookupSource(h.source)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    const saved = await h.stores.control.read()
    expect(saved.value.pending).not.toBeNull()
    expect(saved.value.job).toBe('0')
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as SourceBatch
    expect(canonicalOutputJSON(first)).toBe(canonicalOutputJSON(saved.value.pending))
    await expect(iterator.next()).rejects.toMatchObject({ code: 'conflict' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect((await h.stores.control.read()).value.job).toBe('0')
    expect((await h.stores.core.revision()).received).toBe('1')
  })

  it('commits snapshot/live boundaries and accepts repeated empty polls with an existing receipt key', async () => {
    const h = await harness()
    h.fetch.mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body)) as OutputJSONObject
      return Promise.resolve(
        h.fixture.response(
          body.requestId
            ? h.fixture.packet
            : {
                ...h.fixture.packet,
                phase: 'live',
                cursor: 'cursor-2'
              }
        )
      )
    })
    const { source, request } = await resumeLookupSource(h.source)
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const snapshot = (await iterator.next()).value as SourceBatch
    expect((await receive(h, snapshot)).status).toBe('committed')
    const live = (await iterator.next()).value as SourceBatch
    expect(live.coverage.phase).toBe('live')
    expect((await receive(h, live)).status).toBe('committed')
    const repeated = (await iterator.next()).value as SourceBatch
    expect(repeated).toEqual(live)
    expect((await receive(h, repeated)).status).toBe('replayed')
    expect((await iterator.next()).value).toEqual(live)
    expect((await h.stores.control.read()).value.job).toBe('3')
    expect((await h.stores.control.read()).value.minimumReceived).toBe('3')
    await iterator.return!()
    expect(h.fetch.mock.calls.every(([url]) => !String(url).endsWith('/close'))).toBe(true)
  })

  it('recovers the captured receipt and original timestamp after SQLite close and capability expiry', async () => {
    const h = await harness()
    await resumeLookupSource(h.source)
    const original = await h.stores.control.read()
    await h.stores.control.close()
    await h.stores.core.close()
    cleanup.length = 0
    const stores = await liveStores(h.path, h.fixture, false)
    cleanup.push(
      () => stores.control.close(),
      () => stores.core.close()
    )
    const fetch = jest.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected HTTP'))
    const { source, request } = await resumeLookupSource({
      ...h.options,
      ...stores,
      fetch,
      now: () => 2000000
    })
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(original.value.pending)
    expect(fetch).not.toHaveBeenCalled()
    expect((await stores.control.read()).value.original).toEqual(original.value.original)
    await iterator.return!()
  })

  it('retries a dropped opening with its saved ID instead of reserving another session', async () => {
    const h = await harness()
    h.fetch.mockRejectedValueOnce(new Error('Response lost'))
    await expect(resumeLookupSource(h.source)).rejects.toThrow('Response lost')
    const retained = await h.stores.control.read()
    expect(retained.value.pending).toBeNull()
    await resumeLookupSource(h.source)
    const bodies = h.fetch.mock.calls.map(([, init]) => String(init?.body))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
    expect(JSON.parse(bodies[1]).requestId).toBe(h.fixture.open.requestId)
  })

  it('rejects volatile or changed bindings and arbitrary caller checkpoints before HTTP', async () => {
    const h = await harness()
    const memory = new MemoryOperationStateStore(
      h.fixture.prepared.namespace,
      h.fixture.prepared.binding,
      h.fixture.prepared.initial,
      h.fixture.prepared.limits
    )
    await expect(resumeLookupSource({ ...h.options, control: memory })).rejects.toMatchObject({
      code: 'unsupported'
    })
    await expect(
      resumeLookupSource({
        ...h.options,
        configuration: { ...h.fixture.config, generation: '4' }
      })
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect(h.fetch).not.toHaveBeenCalled()
    const { source, request } = await resumeLookupSource(h.source)
    expect(() =>
      source.open(
        { ...request, checkpoint: { ...request.checkpoint!, cursor: 'arbitrary' } },
        new AbortController().signal
      )
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('recovered binding')
      })
    )
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
  it('lets the first durable capture win across independent SQLite workers', async () => {
    const h = await harness()
    const second = await liveStores(h.path, h.fixture, false)
    cleanup.push(
      () => second.core.close(),
      () => second.control.close()
    )
    const entered = deferred<void>(),
      response = deferred<Response>()
    h.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return response.promise
    })
    const first = resumeLookupSource(h.source).then(
      value => ({ value }),
      error => ({ error })
    )
    await entered.promise
    try {
      const winner = await resumeLookupSource({
        ...h.options,
        ...second,
        now: () => 1001000,
        fetch: () => Promise.resolve(h.fixture.response({ ...h.fixture.packet, cursor: 'winner' }))
      })
      response.resolve(h.fixture.response({ ...h.fixture.packet, cursor: 'late' }))
      const recovered = await first
      if (!('value' in recovered)) throw recovered.error
      expect(recovered.value.request).toEqual(winner.request)
      const saved = await h.stores.control.read()
      const batch = saved.value.pending as unknown as SourceBatch
      expect(batch.checkpoint!.cursor).toBe('winner')
      expect(batch.provenance.receivedAt).toBe('1001')
      expect(saved.value.job).toBe('0')
    } finally {
      response.resolve(h.fixture.response())
      await first
    }
  })

  it('discards an old opening response after another worker has committed and advanced', async () => {
    const h = await harness()
    const second = await liveStores(h.path, h.fixture, false)
    cleanup.push(
      () => second.core.close(),
      () => second.control.close()
    )
    const entered = deferred<void>(),
      response = deferred<Response>()
    h.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return response.promise
    })
    const first = resumeLookupSource(h.source).then(
      value => ({ value }),
      error => ({ error })
    )
    await entered.promise
    try {
      const fetch = jest.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
        const body = JSON.parse(String(init?.body)) as OutputJSONObject
        return Promise.resolve(
          h.fixture.response(
            body.requestId
              ? h.fixture.packet
              : {
                  ...h.fixture.packet,
                  phase: 'live',
                  cursor: 'advanced'
                }
          )
        )
      })
      const winner = await resumeLookupSource({ ...h.options, ...second, fetch })
      const iterator = winner.source
        .open(winner.request, new AbortController().signal)
        [Symbol.asyncIterator]()
      const snapshot = (await iterator.next()).value as SourceBatch
      expect((await receive(h, snapshot)).status).toBe('committed')
      const live = (await iterator.next()).value as SourceBatch
      expect(live.checkpoint!.cursor).toBe('advanced')
      response.resolve(h.fixture.response())
      const recovered = await first
      if (!('value' in recovered)) throw recovered.error
      expect(recovered.value.request.checkpoint!.cursor).toBe('advanced')
      expect((await h.stores.control.read()).value.job).toBe('1')
      await iterator.return!()
    } finally {
      response.resolve(h.fixture.response())
      await first
    }
  })

  it('holds connection capacity through timed-out, noncancellable control reads on the same source', async () => {
    const h = await harness({ operationTimeoutMs: 20 })
    const before = await h.stores.control.read()
    const held = deferred<typeof before>()
    const read = jest.spyOn(h.stores.control, 'read').mockImplementationOnce(() => held.promise)
    try {
      await expect(resumeLookupSource(h.source)).rejects.toMatchObject({ code: 'limited' })
      await expect(resumeLookupSource(h.source)).rejects.toThrow('still active')
      expect(read).toHaveBeenCalledTimes(1)
      expect(h.fetch).not.toHaveBeenCalled()
    } finally {
      held.resolve(before)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await expect(resumeLookupSource(h.source)).resolves.toHaveProperty('source')
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('recovers a late successful capture after cancellation without yielding or reopening', async () => {
    const h = await harness()
    const original = h.stores.control.compareAndSwap.bind(h.stores.control)
    const entered = deferred<void>(),
      release = deferred<void>(),
      finished = deferred<void>()
    jest.spyOn(h.stores.control, 'compareAndSwap').mockImplementation(async (revision, value) => {
      if (value.pending !== null) {
        entered.resolve()
        await release.promise
      }
      const result = await original(revision, value)
      finished.resolve()
      return result
    })
    const abort = new AbortController()
    const opening = resumeLookupSource(h.source, abort.signal).then(
      value => ({ value }),
      error => ({ error })
    )
    await entered.promise
    abort.abort()
    await expect(opening).resolves.toMatchObject({ error: { code: 'cancelled' } })
    expect((await h.stores.control.read()).value.pending).toBeNull()
    release.resolve()
    await finished.promise
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const recovered = await resumeLookupSource(h.source)
    expect(recovered.request.checkpoint!.cursor).toBe('cursor-1')
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['capture', 'advance'] as const)(
    'recovers a lost %s CAS acknowledgement',
    async phase => {
      const h = await harness()
      liveResponses(h)
      const original = h.stores.control.compareAndSwap.bind(h.stores.control)
      let lost = false
      jest.spyOn(h.stores.control, 'compareAndSwap').mockImplementation(async (revision, value) => {
        const result = await original(revision, value)
        if (!lost && (phase === 'capture' ? value.pending !== null : value.job === '1')) {
          lost = true
          throw new OutputProtocolError('unavailable', 'CAS acknowledgement lost')
        }
        return result
      })
      if (phase === 'capture') {
        await expect(resumeLookupSource(h.source)).rejects.toThrow('acknowledgement lost')
      } else {
        const { source, request } = await resumeLookupSource(h.source)
        const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
        const first = (await iterator.next()).value as SourceBatch
        await receive(h, first)
        await expect(iterator.next()).rejects.toThrow('acknowledgement lost')
      }
      const recovered = await resumeLookupSource(h.source)
      expect(recovered.request.checkpoint!.cursor).toBe(
        phase === 'capture' ? 'cursor-1' : 'cursor-live'
      )
      const openings = h.fetch.mock.calls.filter(([, init]) =>
        Boolean(JSON.parse(String(init?.body)).requestId)
      )
      expect(openings).toHaveLength(1)
      expect(lost).toBe(true)
    }
  )

  it('keeps a source refresh generation independent of verification-context generation', async () => {
    const h = await harness()
    liveResponses(h)
    const { source, request } = await resumeLookupSource(h.source)
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as SourceBatch
    await receive(h, first)
    const next = { ...context(), id: 'another-context', generation: '8' }
    const revision = await h.stores.core.revision()
    expect(
      (
        await h.stores.core.commit(
          revision.received,
          knowledgeMutation({ kind: 'context', context: next })
        )
      ).status
    ).toBe('committed')
    expect(((await iterator.next()).value as SourceBatch).provenance.generation).toBe('3')
    await iterator.return!()
  })

  it('rejects a retired source generation before the next HTTP read', async () => {
    const h = await harness()
    liveResponses(h)
    const { source, request } = await resumeLookupSource(h.source)
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as SourceBatch
    await receive(h, first)
    const next = structuredClone(first)
    next.provenance.generation = '4'
    next.provenance.scope.epoch = 'epoch-2'
    next.coverage.scope.epoch = 'epoch-2'
    next.checkpoint!.session = 'new-session'
    expect((await receive(h, next)).status).toBe('committed')
    await expect(iterator.next()).rejects.toMatchObject({ code: 'context-changed' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['before-http', 'capture', 'receipt', 'advance', 'live-capture'] as const)(
    'recovers after actual process exit at %s',
    async stage => {
      const h = await harness()
      await h.stores.control.close()
      await h.stores.core.close()
      cleanup.length = 0
      const headers = Object.fromEntries(h.fixture.response().headers)
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/live-lookup-process.mjs', import.meta.url))],
        {
          input: JSON.stringify({
            configuration: h.fixture.config,
            prepared: h.fixture.prepared,
            packet: h.fixture.packet,
            selection: h.fixture.selection,
            path: h.path,
            stage,
            rulesId: h.fixture.options.manifest.body.services[0].rules.id,
            headers
          }),
          encoding: 'utf8',
          timeout: 10000
        }
      )
      expect({
        status: child.status,
        signal: child.signal,
        error: child.error,
        stderr: child.stderr
      }).toMatchObject({ status: 42, signal: null, error: undefined })
      const stores = await liveStores(h.path, h.fixture, false)
      cleanup.push(
        () => stores.control.close(),
        () => stores.core.close()
      )
      liveResponses(h)
      const recovered = await resumeLookupSource({ ...h.options, ...stores })
      const saved = await stores.control.read()
      expect(saved.value.original).toEqual(h.fixture.prepared.initial.original)
      const networkNeeded = stage === 'before-http' || stage === 'advance'
      expect(h.fetch).toHaveBeenCalledTimes(networkNeeded ? 1 : 0)
      if (stage === 'advance') {
        const body = JSON.parse(String(h.fetch.mock.calls[0][1]?.body))
        expect(body).toHaveProperty('cursor', 'cursor-1')
        expect(body).not.toHaveProperty('requestId')
      }
      const iterator = recovered.source
        .open(recovered.request, new AbortController().signal)
        [Symbol.asyncIterator]()
      const batch = (await iterator.next()).value as SourceBatch
      expect(batch).toEqual(saved.value.pending)
      const receipt = await stores.core.getMutation(
        knowledgeMutation({ kind: 'receive', batch }).key
      )
      expect(receipt.status).toBe(stage === 'receipt' ? 'committed' : 'absent')
      await iterator.return!()
    }
  )

  it('does not let repeated closure of an old iterator release a newer subscription', async () => {
    const h = await harness()
    const { source, request } = await resumeLookupSource(h.source)
    const first = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await first.return!()
    const second = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await first.return!()
    expect(() => source.open(request, new AbortController().signal)).toThrow('already active')
    await second.return!()
  })
  it('retains the transport fence across a cancelled connection and late fetch completion', async () => {
    const h = await harness({ operationTimeoutMs: 20 })
    const entered = deferred<void>(),
      late = deferred<Response>()
    h.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    const first = resumeLookupSource(h.source).then(
      value => ({ value }),
      error => ({ error })
    )
    await entered.promise
    try {
      await expect(first).resolves.toMatchObject({ error: { code: 'limited' } })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await expect(resumeLookupSource(h.source)).rejects.toMatchObject({ code: 'limited' })
      expect(h.fetch).toHaveBeenCalledTimes(1)
    } finally {
      late.resolve(h.fixture.response())
      await first
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await expect(resumeLookupSource(h.source)).resolves.toHaveProperty('source')
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.fetch.mock.calls[0][1]?.body).toBe(h.fetch.mock.calls[1][1]?.body)
  })

  it('prevents opening or reconnecting while an earlier connection is pending', async () => {
    const h = await harness()
    const { request } = await resumeLookupSource(h.source)
    const held = deferred<Awaited<ReturnType<typeof h.stores.control.read>>>()
    const saved = await h.stores.control.read()
    jest.spyOn(h.stores.control, 'read').mockImplementationOnce(() => held.promise)
    const connecting = h.source.connect()
    try {
      expect(() => h.source.open(request, new AbortController().signal)).toThrow('still active')
      await expect(h.source.connect()).rejects.toThrow('connection or subscription')
    } finally {
      held.resolve(saved)
      await connecting
    }
    const iterator = h.source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(h.source.connect()).rejects.toThrow('connection or subscription')
    await iterator.return!()
  })

  it('bounds control contention before another HTTP request', async () => {
    const h = await harness()
    await h.stores.core.commit(
      '1',
      knowledgeMutation({ kind: 'context', context: { ...context(), id: 'second' } })
    )
    const cas = jest
      .spyOn(h.stores.control, 'compareAndSwap')
      .mockResolvedValue({ status: 'conflict', revision: '1' })
    await expect(h.source.connect()).rejects.toMatchObject({ code: 'limited', retryable: true })
    expect(cas).toHaveBeenCalledTimes(8)
    expect(h.fetch).not.toHaveBeenCalled()
    expect((await h.stores.control.read()).value.minimumReceived).toBe('1')
  })

  it.each(['unavailable', 'key', 'body', 'position'] as const)(
    'refuses an uncertain or inconsistent %s acknowledgement without issuing another read',
    async fault => {
      const h = await harness()
      const { source, request } = await resumeLookupSource(h.source)
      const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
      const batch = (await iterator.next()).value as SourceBatch
      await receive(h, batch)
      const lookup = await h.stores.core.getMutation(
        knowledgeMutation({ kind: 'receive', batch }).key
      )
      if (lookup.status !== 'committed') throw new Error('Missing fixture receipt')
      if (fault === 'key') lookup.entry.key = '00'.repeat(32)
      if (fault === 'body') lookup.entry.body = { kind: 'context', context: context() }
      if (fault === 'position') lookup.entry.revision.received = '0'
      jest
        .spyOn(h.stores.core, 'getMutation')
        .mockResolvedValueOnce(
          fault === 'unavailable' ? { status: 'unavailable', reason: 'Offline' } : lookup
        )
      await expect(iterator.next()).rejects.toMatchObject({
        code: fault === 'unavailable' ? 'unavailable' : 'equivocation'
      })
      expect(h.fetch).toHaveBeenCalledTimes(1)
      expect((await h.stores.control.read()).value.job).toBe('0')
    }
  )

  it('rejects a bad host clock and a clock jump between response validation and capture', async () => {
    const h = await harness()
    const invalid = new LiveLookupSource({ ...h.options, now: () => -1 })
    await expect(invalid.connect()).rejects.toThrow('source clock')
    const now = jest.fn<() => number>().mockReturnValueOnce(1000000).mockReturnValue(1300000)
    const jumped = new LiveLookupSource({ ...h.options, now })
    await expect(jumped.connect()).rejects.toThrow('expired before capture')
    expect((await h.stores.control.read()).value.pending).toBeNull()
  })

  it('retains a local expiry reset until receipt, replays it after restart and never advances its cursor', async () => {
    const h = await harness()
    let now = 1000000
    const source = new LiveLookupSource({ ...h.options, now: () => now })
    const request = await source.connect()
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    const snapshot = (await iterator.next()).value as SourceBatch
    await receive(h, snapshot)
    now = 1300000
    const reset = (await iterator.next()).value as SourceBatch
    expect(reset.coverage).toEqual({ ...snapshot.coverage, status: 'reset-required' })
    expect(reset.groups).toEqual([])
    expect(reset.checkpoint).toBeUndefined()
    expect(reset.provenance.receivedAt).toBe('1300')
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await expect(iterator.next()).rejects.toMatchObject({ code: 'conflict' })
    expect((await receive(h, reset)).status).toBe('committed')
    const saved = await h.stores.control.read()
    expect(saved.value.job).toBe('1')
    expect(saved.value.previous).toHaveProperty('cursor', 'cursor-1')
    await h.stores.core.close()
    await h.stores.control.close()
    cleanup.length = 0
    const stores = await liveStores(h.path, h.fixture, false)
    cleanup.push(
      () => stores.core.close(),
      () => stores.control.close()
    )
    const resumed = await resumeLookupSource({ ...h.options, ...stores, now: () => 2000000 })
    expect(resumed.request.checkpoint).toBeUndefined()
    const replay = resumed.source
      .open(resumed.request, new AbortController().signal)
      [Symbol.asyncIterator]()
    expect((await replay.next()).value).toEqual(reset)
    await expect(replay.next()).rejects.toMatchObject({ code: 'reset-required' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect((await stores.control.read()).value.previous).toEqual(saved.value.previous)
    expect((await stores.control.read()).value.original).toEqual(saved.value.original)
    const changed = structuredClone(snapshot)
    changed.provenance.receivedAt = '2000'
    const revision = await stores.core.revision()
    await expect(
      stores.core.commit(revision.received, knowledgeMutation({ kind: 'receive', batch: changed }))
    ).rejects.toMatchObject({ code: 'reset-required' })
  })

  it.each(['reset-required', 'expired', 'unauthorized', 'context-changed', 'not-found'] as const)(
    'captures a selected service %s as a durable continuity loss',
    async code => {
      const h = await harness()
      const { source, request } = await resumeLookupSource(h.source)
      const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
      const snapshot = (await iterator.next()).value as SourceBatch
      await receive(h, snapshot)
      h.fetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 1,
              error: { code, message: 'Session cannot continue', retryable: false }
            }),
            { status: outputServiceErrorHTTPStatus(code), headers: h.fixture.response().headers }
          )
        )
      )
      const reset = (await iterator.next()).value as SourceBatch
      expect(reset.coverage.status).toBe('reset-required')
      expect((await h.stores.control.read()).value.pending).toEqual(reset)
      expect((await receive(h, reset)).status).toBe('committed')
      await expect(iterator.next()).rejects.toMatchObject({ code: 'reset-required' })
      expect(h.fetch).toHaveBeenCalledTimes(2)
    }
  )

  it('does not treat a transport error or unselected response as an authenticated service reset', async () => {
    const h = await harness()
    const { source, request } = await resumeLookupSource(h.source)
    const first = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await receive(h, (await first.next()).value as SourceBatch)
    h.fetch.mockRejectedValueOnce(
      new OutputProtocolError('unauthorized', 'Transport authentication failed')
    )
    await expect(first.next()).rejects.toThrow('Transport authentication failed')
    expect((await h.stores.control.read()).value.pending).toBeNull()
    h.fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            error: { code: 'reset-required', message: 'Unselected error', retryable: false }
          }),
          { status: 409 }
        )
      )
    )
    await expect(source.connect()).rejects.toThrow('selected contract')
    expect((await h.stores.control.read()).value.pending).toBeNull()
    liveResponses(h)
    const recovered = await source.connect()
    expect(recovered.checkpoint?.cursor).toBe('cursor-live')
  })

  it.each(['rolled-back', 'different-history'] as const)(
    'refuses a %s core even when the control still contains a complete pending receipt',
    async mode => {
      const h = await harness()
      liveResponses(h)
      const { source, request } = await resumeLookupSource(h.source)
      const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
      await receive(h, (await iterator.next()).value as SourceBatch)
      await iterator.next()
      await iterator.return!()
      const path = await mkdtemp(join(tmpdir(), 'lookup-replaced-core-'))
      directories.push(path)
      const replaced = await liveStores(path, h.fixture)
      cleanup.push(
        () => replaced.core.close(),
        () => replaced.control.close()
      )
      if (mode === 'different-history')
        await replaced.core.commit(
          '1',
          knowledgeMutation({ kind: 'context', context: { ...context(), id: 'different-history' } })
        )
      const pending = await h.stores.control.read()
      expect(pending.value.pending).not.toBeNull()
      expect((await replaced.core.revision()).received).toBe(mode === 'rolled-back' ? '1' : '2')
      const recovering = new LiveLookupSource({ ...h.options, core: replaced.core })
      await expect(recovering.connect()).rejects.toMatchObject({ code: 'reset-required' })
      expect(h.fetch).toHaveBeenCalledTimes(2)
      expect((await h.stores.control.read()).value).toEqual(pending.value)
    }
  )

  it('rejects an in-place predecessor substitution while HTTP is pending', async () => {
    const h = await harness()
    const { source, request } = await resumeLookupSource(h.source)
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await receive(h, (await iterator.next()).value as SourceBatch)
    const started = deferred<void>(),
      response = deferred<Response>()
    h.fetch.mockImplementationOnce(() => {
      started.resolve()
      return response.promise
    })
    const next = iterator.next().then(
      value => ({ value }),
      error => ({ error })
    )
    try {
      await started.promise
      const before = await h.stores.control.read()
      await h.stores.control.compareAndSwap(before.revision, {
        ...before.value,
        previousReceipt: { key: '00'.repeat(32), received: '2' }
      })
      response.resolve(h.fixture.response({ ...h.fixture.packet, phase: 'live' }))
      await expect(next).resolves.toMatchObject({ error: { code: 'reset-required' } })
      expect((await h.stores.control.read()).value.pending).toBeNull()
    } finally {
      response.resolve(h.fixture.response({ ...h.fixture.packet, phase: 'live' }))
      await next
    }
  })

  it('does not overwrite a newer core minimum committed after the HTTP guard read', async () => {
    const h = await harness()
    const { source, request } = await resumeLookupSource(h.source)
    const iterator = source.open(request, new AbortController().signal)[Symbol.asyncIterator]()
    await receive(h, (await iterator.next()).value as SourceBatch)
    const second = await liveStores(h.path, h.fixture, false)
    cleanup.push(
      () => second.core.close(),
      () => second.control.close()
    )
    const originalRead = h.stores.control.read.bind(h.stores.control)
    let interleave = false
    jest.spyOn(h.stores.control, 'read').mockImplementation(async () => {
      if (interleave) {
        interleave = false
        await second.core.commit(
          '2',
          knowledgeMutation({ kind: 'context', context: { ...context(), id: 'newer-core-head' } })
        )
        const saved = await second.control.read()
        await second.control.compareAndSwap(saved.revision, {
          ...saved.value,
          minimumReceived: '3'
        })
      }
      return originalRead()
    })
    h.fetch
      .mockImplementationOnce(() => {
        interleave = true
        return Promise.resolve(
          h.fixture.response({ ...h.fixture.packet, phase: 'live', cursor: 'superseded-read' })
        )
      })
      .mockImplementation(() =>
        Promise.resolve(
          h.fixture.response({ ...h.fixture.packet, phase: 'live', cursor: 'fresh-read' })
        )
      )
    const next = (await iterator.next()).value as SourceBatch
    expect(next.checkpoint?.cursor).toBe('fresh-read')
    expect((await originalRead()).value.minimumReceived).toBe('3')
    expect(h.fetch).toHaveBeenCalledTimes(3)
    await iterator.return!()
  })

  it('yields to cancellation between immediate partial snapshot responses', async () => {
    const h = await harness()
    h.fetch.mockImplementation(() =>
      Promise.resolve(
        h.fixture.response({
          ...h.fixture.packet,
          snapshotComplete: false
        })
      )
    )
    const { source, request } = await resumeLookupSource(h.source)
    const abort = new AbortController()
    const iterator = source.open(request, abort.signal)[Symbol.asyncIterator]()
    await receive(h, (await iterator.next()).value as SourceBatch)
    const timer = setTimeout(() => abort.abort(), 0)
    try {
      await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' })
      expect(h.fetch).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(timer)
      await iterator.return!()
    }
  })
})
