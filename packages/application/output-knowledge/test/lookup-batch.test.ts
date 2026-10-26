import fc from 'fast-check'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalOutputJSON, outputPacketDigest, type OutputLookupOpen } from '@bsv/sdk'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { LookupBatchBuilder, type LookupBatchBoundary } from '../src/lookup/LookupBatchBuilder.js'
import { LookupLiveReader } from '../src/lookup/LookupLiveReader.js'
import { LookupWake } from '../src/lookup/LookupWake.js'
import { LookupCursorCodec } from '../src/lookup/LookupCursorCodec.js'
import {
  CollectionOutputQueryPolicy,
  collectionOutputIndexKey
} from '../src/lookup/CollectionOutputQueryPolicy.js'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import type { LookupQueryView } from '../src/lookup/LookupQueryRegistry.js'
import type { LookupIndexStorage } from '../src/lookup/LookupIndexStorage.js'
import { chain, corpus } from './evidence-fixture.js'

const directories: string[] = [],
  stores: SQLiteLookupIndex[] = []
const maximums = { maxBytes: 4194304, maxObservations: 1024, waitMs: 25000 }
const limits = { ...maximums, waitMs: 0 }
const size = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)).length
function entry(outputIndex: number, visible = true) {
  const evidence = {
    txid: corpus.transactions[corpus.anchors[0].name].txid,
    outputIndex,
    beef: corpus.anchors[0].beef
  }
  return {
    key: collectionOutputIndexKey(evidence),
    previous: null,
    next: {
      data: { collection: 'records', audience: visible ? 'public' : [], output: { evidence } },
      expiresAt: null
    }
  }
}
async function fixture(maximumScans = 128, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-batch-'))
  directories.push(directory)
  const index = SQLiteLookupIndex.create(join(directory, 'index.db'), 'records', {
    service: 'records'
  })
  stores.push(index)
  if (count > 0)
    await index.commit({
      base: '0',
      evaluatedAt: '1000',
      edits: Array.from({ length: count }, (_, i) => entry(i, i < 2)),
      event: {}
    })
  const captured = await index.advanceTime('1000', 10)
  const registry = new LookupQueryRegistry([
    { policy: new CollectionOutputQueryPolicy(), parameters: {} }
  ])
  const open: OutputLookupOpen = {
    version: 1,
    service: 'records',
    requestId: '01'.repeat(32),
    query: { collection: 'records' },
    limits
  }
  const boundary: LookupBatchBoundary = {
    session: '02'.repeat(32),
    secret: '03'.repeat(32),
    time: '1000',
    watermark: captured.head.sequence,
    expiresAt: '1300',
    replayUntil: '1900',
    scope: {
      chain,
      service: open.service,
      provider: 'https://lookup.example.test',
      epoch: 'epoch',
      access: 'public',
      rulesDigest: registry.describe()[0].rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service: open.service, query: open.query })
    }
  }
  await index.retainSnapshot('04'.repeat(32), boundary.watermark, boundary.replayUntil)
  const query = registry.prepare(open, boundary.scope, null)
  const builder = new LookupBatchBuilder(index, maximumScans)
  const cursor = new LookupCursorCodec(boundary.secret, boundary.session, boundary.scope.epoch)
  return { index, builder, boundary, query, cursor }
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('bounded provider batch construction', () => {
  it.each(['watermark', 'stationary', 'skipped-row', 'unbounded', 'premature-complete'])(
    'rejects an inconsistent storage page: %s',
    async fault => {
      const { index, boundary, query } = await fixture()
      const intercepted = new Proxy(index, {
        get(target, key) {
          if (key === 'snapshot')
            return async (...args: Parameters<LookupIndexStorage['snapshot']>) => {
              const page = await target.snapshot(...args)
              if (fault === 'watermark') page.watermark = '0'
              if (fault === 'stationary') page.after = null
              if (fault === 'skipped-row') page.after = entry(1).key
              if (fault === 'unbounded') page.scanned = 2
              if (fault === 'premature-complete') {
                page.scanned = 0
                page.complete = true
              }
              return page
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(
        new LookupBatchBuilder(intercepted).build(boundary, query, null, limits, maximums, '1')
      ).rejects.toMatchObject({ code: 'reset-required' })
    }
  )

  it('finishes the immutable snapshot before delivering a write made during its final page', async () => {
    const { index, builder, boundary, query, cursor } = await fixture()
    const one = { ...limits, maxObservations: 1 }
    const first = await builder.build(boundary, query, null, one, maximums, '1')
    expect(first.batch).toMatchObject({ phase: 'snapshot', snapshotComplete: false, through: '1' })
    expect(first.batch.groups).toHaveLength(1)
    expect(first.scanned).toBe(2) // Includes the indivisible next group that did not fit.
    await index.commit({ base: '1', evaluatedAt: '1001', edits: [entry(3)], event: {} })
    const last = await builder.build(boundary, query, first.batch.cursor, one, maximums, '2')
    expect(last.batch).toMatchObject({
      phase: 'snapshot',
      snapshotComplete: true,
      through: '1',
      highWater: '2'
    })
    expect(last.batch.groups).toHaveLength(1)
    expect(cursor.open(last.batch.cursor)).toEqual({ phase: 'live', through: '1' })
    const live = await builder.build(boundary, query, last.batch.cursor, limits, maximums, '2')
    expect(live.batch).toMatchObject({ phase: 'live', through: '2', snapshotComplete: true })
    expect(live.batch.groups).toHaveLength(1)
    expect(live.batch.groups[0].sequence).toBe('2')
    const quiet = await builder.build(boundary, query, live.batch.cursor, limits, maximums, '2')
    expect(quiet).toMatchObject({
      batch: { groups: [], cursor: live.batch.cursor, through: '2' },
      scanned: 0
    })
  })

  it('returns one complete empty snapshot boundary before an empty live poll', async () => {
    const { builder, boundary, query, cursor } = await fixture(128, 0)
    const first = await builder.build(boundary, query, null, limits, maximums, '0')
    expect(first).toMatchObject({
      batch: { phase: 'snapshot', snapshotComplete: true, groups: [], through: '0' },
      scanned: 0
    })
    expect(cursor.open(first.batch.cursor)).toEqual({ phase: 'live', through: '0' })
    const live = await builder.build(boundary, query, first.batch.cursor, limits, maximums, '0')
    expect(live.batch).toMatchObject({ phase: 'live', cursor: first.batch.cursor, groups: [] })
  })

  it('bounds scanning of irrelevant snapshot rows and live groups without claiming an unseen suffix complete', async () => {
    const { index, boundary, query, cursor } = await fixture(128, 5)
    const builder = new LookupBatchBuilder(index, 1)
    let token: string | null = null
    const batches = []
    for (let page = 0; page < 5; page++) {
      const response = await builder.build(boundary, query, token, limits, maximums, '1')
      batches.push(response)
      token = response.batch.cursor
      expect(response.scanned).toBe(1)
    }
    expect(batches.map(value => value.batch.groups.length)).toEqual([1, 1, 0, 0, 0])
    expect(batches.map(value => value.batch.snapshotComplete)).toEqual([
      false,
      false,
      false,
      false,
      true
    ])
    await index.commit({ base: '1', evaluatedAt: '1001', edits: [entry(5, false)], event: {} })
    await index.commit({ base: '2', evaluatedAt: '1002', edits: [entry(6)], event: {} })
    const sparse = await builder.build(boundary, query, token, limits, maximums, '3')
    expect(sparse).toMatchObject({
      batch: { groups: [], through: '2', highWater: '3' },
      scanned: 1
    })
    expect(cursor.open(sparse.batch.cursor)).toEqual({ phase: 'live', through: '2' })
    expect(
      (await builder.build(boundary, query, sparse.batch.cursor, limits, maximums, '3')).batch
        .groups
    ).toHaveLength(1)
  })

  it('never splits a coherent live group and preserves its identity when retry limits change', async () => {
    const { index, builder, boundary, query, cursor } = await fixture()
    await index.commit({
      base: '1',
      evaluatedAt: '1001',
      edits: [0, 1].map(i => ({ key: entry(i).key, previous: '1', next: null })),
      event: {}
    })
    const token = cursor.seal({ phase: 'live', through: '1' })
    await expect(
      builder.build(boundary, query, token, { ...limits, maxObservations: 1 }, maximums, '2')
    ).rejects.toMatchObject({
      code: 'limited',
      limit: { kind: 'group', minimumObservations: 2 }
    })
    await expect(
      builder.build(boundary, query, token, limits, { ...maximums, maxObservations: 1 }, '2')
    ).rejects.toMatchObject({
      code: 'limited',
      limit: { kind: 'permanent-group' }
    })
    const first = await builder.build(
      boundary,
      query,
      token,
      { ...limits, maxObservations: 2 },
      maximums,
      '2'
    )
    const retry = await builder.build(boundary, query, token, limits, maximums, '2')
    expect(first.batch.groups).toEqual(retry.batch.groups)
    expect(first.batch.groups).toHaveLength(1)
    expect(first.batch.groups[0].observations.map(value => value.kind)).toEqual([
      'withdraw',
      'withdraw'
    ])
  })

  it('charges the complete actual UTF-8 body and stops before a next group that cannot fit', async () => {
    const { builder, boundary, query, cursor } = await fixture()
    const whole = await builder.build(boundary, query, null, limits, maximums, '1')
    const partial = {
      ...whole.batch,
      groups: whole.batch.groups.slice(0, 1),
      snapshotComplete: false,
      cursor: cursor.seal({ phase: 'snapshot', watermark: '1', after: entry(0).key }),
      limits: { ...limits }
    }
    for (let step = 0; step < 4; step++) partial.limits.maxBytes = size(partial)
    const exact = await builder.build(boundary, query, null, partial.limits, maximums, '1')
    expect(exact.batch.groups).toEqual(partial.groups)
    expect(size(exact.batch)).toBe(exact.batch.limits.maxBytes)
    await expect(
      builder.build(boundary, query, null, { ...limits, maxBytes: 1 }, maximums, '1')
    ).rejects.toMatchObject({ code: 'limited', limit: { kind: 'envelope' } })
    await expect(
      builder.build(
        boundary,
        query,
        null,
        { ...partial.limits, maxBytes: partial.limits.maxBytes - 1 },
        maximums,
        '1'
      )
    ).rejects.toMatchObject({ code: 'limited', limit: { kind: 'group' } })
  })

  it('rejects old/wrong-session cursors and unavailable watermarks without empty success', async () => {
    const { builder, boundary, query, cursor } = await fixture()
    for (const token of [
      'corrupt',
      cursor.seal({ phase: 'live', through: '0' }),
      cursor.seal({ phase: 'live', through: '2' }),
      cursor.seal({ phase: 'snapshot', watermark: '0', after: null })
    ])
      await expect(
        builder.build(boundary, query, token, limits, maximums, '1')
      ).rejects.toMatchObject({ code: 'reset-required' })
    const token = cursor.seal({ phase: 'live', through: '1' })
    await expect(
      builder.build({ ...boundary, session: 'ff'.repeat(32) }, query, token, limits, maximums, '1')
    ).rejects.toMatchObject({ code: 'reset-required' })
    await expect(builder.build(boundary, query, null, limits, maximums, '0')).rejects.toMatchObject(
      { code: 'reset-required' }
    )
  })

  it('does not disclose a response after cancellation during a pending index read', async () => {
    const { index, boundary, query } = await fixture()
    const abort = new AbortController()
    const intercepted = new Proxy(index, {
      get(target, key) {
        if (key === 'snapshot')
          return async (...args: Parameters<LookupIndexStorage['snapshot']>) => {
            const result = await target.snapshot(...args)
            abort.abort()
            return result
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(
      new LookupBatchBuilder(intercepted).build(
        boundary,
        query,
        null,
        limits,
        maximums,
        '1',
        abort.signal
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it.each([0, 1025, NaN, 1.5])('rejects unbounded scan work %s', async maximum => {
    const { index } = await fixture()
    expect(() => new LookupBatchBuilder(index, maximum)).toThrow('scan budget')
  })
})

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('preserves ordered membership and a final snapshot boundary across generated page capacities', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 1, max: 3 }),
      async (count, pageSize) => {
        const { index, builder, boundary, query } = await fixture(128, count)
        try {
          let cursor: string | null = null
          const keys: number[] = []
          let complete = false
          for (let page = 0; page < 10; page++) {
            const result = await builder.build(
              boundary,
              query,
              cursor,
              { ...limits, maxObservations: pageSize },
              maximums,
              boundary.watermark
            )
            expect(result.batch.phase).toBe('snapshot')
            expect(result.batch.through).toBe(boundary.watermark)
            for (const group of result.batch.groups)
              for (const observation of group.observations)
                if (observation.kind === 'output')
                  keys.push(observation.payload.evidence.outputIndex)
            cursor = result.batch.cursor
            if (result.batch.snapshotComplete) {
              complete = true
              break
            }
          }
          expect(complete).toBe(true)
          expect(keys).toEqual(Array.from({ length: Math.min(count, 2) }, (_, i) => i))
          const live = await builder.build(
            boundary,
            query,
            cursor,
            limits,
            maximums,
            boundary.watermark
          )
          expect(live.batch.phase).toBe('live')
          expect(live.batch.groups).toEqual([])
        } finally {
          await index.close()
        }
      }
    )
  )
}, 120000)

function changedIndex(
  index: LookupIndexStorage,
  overrides: Partial<LookupIndexStorage>
): LookupIndexStorage {
  return new Proxy(index, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('batch construction boundary and backend fault checks', () => {
  it('does not call a group permanent when a 64 KiB immediate read can hold it exactly', async () => {
    const { index, boundary, query } = await fixture(128, 1)
    let padding = ''
    const selected: LookupQueryView = {
      live: query.live.bind(query),
      snapshot(...args: Parameters<LookupQueryView['snapshot']>) {
        const group = query.snapshot(...args)!
        group.observations[0].extensions = { 'urn:example:padding': padding }
        return group
      }
    }
    const maximum = { ...maximums, maxBytes: 65536 }
    const requested = { ...limits, maxBytes: 65536, maxObservations: 1 }
    const builder = new LookupBatchBuilder(index)
    const before = await builder.build(boundary, selected, null, requested, maximum, '1')
    padding = 'x'.repeat(65536 - size(before.batch))
    const exact = await builder.build(boundary, selected, null, requested, maximum, '1')
    expect(size(exact.batch)).toBe(65536)
    await expect(
      builder.build(boundary, selected, null, { ...requested, maxBytes: 65535 }, maximum, '1')
    ).rejects.toMatchObject({
      code: 'limited',
      limit: { kind: 'group', minimumBytes: 65536, minimumObservations: 1 }
    })
    padding += 'x'
    await expect(
      builder.build(boundary, selected, null, requested, maximum, '1')
    ).rejects.toMatchObject({ code: 'limited', limit: { kind: 'permanent-group' } })
  })

  it('validates deadline equality, replay ordering and the maximum legal scan budget', async () => {
    const { index, boundary, query } = await fixture(128, 0)
    const builder = new LookupBatchBuilder(index, 1024)
    for (const changed of [{ expiresAt: boundary.time }, { replayUntil: '1299' }])
      await expect(
        builder.build({ ...boundary, ...changed }, query, null, limits, maximums, '0')
      ).rejects.toMatchObject({
        code: 'invalid',
        message: 'Invalid lookup response boundary deadlines'
      })
    expect(
      (
        await builder.build(
          { ...boundary, replayUntil: boundary.expiresAt },
          query,
          null,
          limits,
          maximums,
          '0'
        )
      ).batch.snapshotComplete
    ).toBe(true)
  })

  it('rejects stationary, reversed, overfull and malformed backend snapshot scans', async () => {
    const { index, boundary, query, cursor } = await fixture()
    const one = await index.row(entry(0).key, '1'),
      two = await index.row(entry(1).key, '1')
    const after = entry(0).key
    const base = { watermark: '1', scanned: 0, complete: true, after, rows: [] }
    const token = cursor.seal({ phase: 'snapshot', watermark: '1', after })
    for (const page of [
      { ...base, complete: false },
      { ...base, after: entry(1).key },
      { ...base, rows: [one!] },
      { ...base, scanned: 1, after: null },
      { ...base, scanned: 1 },
      { ...base, scanned: 1, after: '00' },
      { ...base, scanned: 1, after: entry(1).key, rows: [one!, two!] },
      { ...base, scanned: 1, after: entry(1).key, rows: [one!] },
      { ...base, complete: 1 as unknown as boolean }
    ]) {
      const altered = changedIndex(index, { snapshot: async () => page })
      await expect(
        new LookupBatchBuilder(altered).build(boundary, query, token, limits, maximums, '1')
      ).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup snapshot scan lost its bounded position'
      })
    }
  })

  it('rejects a skipped domain log sequence and stops after a final empty snapshot', async () => {
    const { index, boundary, query, cursor } = await fixture(128, 0)
    await index.commit({ base: '0', evaluatedAt: '1000', edits: [entry(0)], event: {} })
    const altered = changedIndex(index, {
      group: async () => ({ ...(await index.group('1')), sequence: '2' })
    })
    await expect(
      new LookupBatchBuilder(altered).build(
        boundary,
        query,
        cursor.seal({ phase: 'live', through: '0' }),
        limits,
        maximums,
        '1'
      )
    ).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup log lost its contiguous sequence'
    })
    const snapshot = jest.fn(index.snapshot.bind(index))
    const result = await new LookupBatchBuilder(changedIndex(index, { snapshot })).build(
      boundary,
      query,
      null,
      limits,
      maximums,
      '1'
    )
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(result.batch).toMatchObject({
      phase: 'snapshot',
      snapshotComplete: true,
      groups: [],
      through: '0'
    })
  })
})

describe('live reader work and current clock boundaries', () => {
  it('validates each independent read work budget including exact lower and upper bounds', async () => {
    const { index } = await fixture(128, 0)
    const wake = new LookupWake()
    for (const budgets of [
      { maximumScans: 0 },
      { maximumScans: 1.5 },
      { maximumScans: 1025 },
      { maximumExpirations: 0 },
      { maximumExpirations: NaN },
      { maximumExpirations: 1025 },
      { pollMs: 0 },
      { pollMs: 1001 }
    ])
      expect(() => new LookupLiveReader(index, wake, () => '1000', budgets)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Invalid lookup read work budget' })
      )
    expect(
      new LookupLiveReader(index, wake, () => '1000', {
        maximumScans: 1,
        maximumExpirations: 1,
        pollMs: 1
      }).budgets.maximumScans
    ).toBe(1)
    expect(
      new LookupLiveReader(index, wake, () => '1000', {
        maximumScans: 1024,
        maximumExpirations: 1024,
        pollMs: 1000
      }).budgets.pollMs
    ).toBe(1000)
  })

  it('refuses incomplete or stale timer boundaries before returning successful capture/read bytes', async () => {
    const { index, boundary, query, cursor } = await fixture(128, 0)
    const complete = await index.advanceTime('1000', 1)
    for (const captured of [
      { ...complete, complete: false },
      { ...complete, head: { ...complete.head, processedThrough: '999' } }
    ]) {
      const reader = new LookupLiveReader(
        changedIndex(index, { advanceTime: async () => captured }),
        new LookupWake(),
        () => '1000'
      )
      await expect(reader.capture('1000', new AbortController().signal)).rejects.toMatchObject({
        code: captured.complete ? 'reset-required' : 'limited'
      })
      await expect(
        reader.read(
          boundary,
          query,
          cursor.seal({ phase: 'live', through: '0' }),
          limits,
          maximums,
          performance.now(),
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        code: 'limited',
        retryable: true,
        message: 'Lookup timer work exceeds this read budget'
      })
    }
    const reader = new LookupLiveReader(index, new LookupWake(), () => boundary.expiresAt)
    await expect(
      reader.read(
        boundary,
        query,
        cursor.seal({ phase: 'live', through: '0' }),
        limits,
        maximums,
        performance.now(),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup session expired while waiting'
    })
  })

  it.each(['scan', 'expiration'])(
    'returns when its %s budget is exhausted and releases the watch',
    async budget => {
      const { index, boundary, query, cursor } = await fixture(128, 0)
      const original = entry(0, false)
      const write = {
        ...original,
        next: { ...original.next, expiresAt: budget === 'expiration' ? '1001' : null }
      }
      await index.commit({ base: '0', evaluatedAt: '1000', edits: [write], event: {} })
      const wake = new LookupWake(1),
        close = jest.fn()
      jest.spyOn(wake, 'watch').mockReturnValue({
        close,
        wait: async () => {
          throw new Error('Exhausted work must return before sleeping')
        }
      })
      const reader = new LookupLiveReader(
        index,
        wake,
        () => (budget === 'expiration' ? '1001' : '1000'),
        {
          maximumScans: budget === 'scan' ? 1 : 128,
          maximumExpirations: 1
        }
      )
      const result = await reader.read(
        boundary,
        query,
        cursor.seal({ phase: 'live', through: '0' }),
        { ...limits, waitMs: 1000 },
        maximums,
        performance.now(),
        new AbortController().signal
      )
      expect(result.groups).toEqual([])
      expect(result.through).toBe(budget === 'expiration' ? '2' : '1')
      expect(close).toHaveBeenCalledTimes(1)
    }
  )
})

it('bounds empty database checks even when notifications continuously arrive', async () => {
  const { index, boundary, query, cursor } = await fixture(128, 0)
  const wake = new LookupWake(),
    advance = jest.fn(index.advanceTime.bind(index))
  jest.spyOn(wake, 'watch').mockImplementation(() => {
    const inner = new LookupWake(),
      watch = inner.watch()
    inner.notify()
    return watch
  })
  const reader = new LookupLiveReader(
    changedIndex(index, { advanceTime: advance }),
    wake,
    () => '1000'
  )
  const result = await reader.read(
    boundary,
    query,
    cursor.seal({ phase: 'live', through: '0' }),
    { ...limits, waitMs: 25000 },
    maximums,
    performance.now(),
    new AbortController().signal
  )
  expect(advance).toHaveBeenCalledTimes(128)
  expect(result).toMatchObject({ phase: 'live', groups: [], through: '0', highWater: '0' })
})
