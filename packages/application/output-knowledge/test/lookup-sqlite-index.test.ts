import { SQLiteTransactionDomain } from '../src/storage/SQLiteTransactionDomain.js'
import {
  lookupIndexDefinition,
  SQLiteLookupIndexStore,
  sqliteLookupComposition
} from '../src/lookup/SQLiteLookupIndexStore.js'
import type { LookupIndexCompactionLimits } from '../src/lookup/LookupIndexStorage.js'
import fc from 'fast-check'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import {
  SQLiteLookupIndex,
  type SQLiteLookupIndexOptions
} from '../src/lookup/SQLiteLookupIndex.js'
import type { LookupIndexMutation } from '../src/lookup/LookupIndexCodec.js'

const binding = { service: 'records', epoch: 'test-epoch-one', rules: 'test-rules' }
const paths: string[] = []
const stores: SQLiteLookupIndex[] = []
const mutation = (key = '01', base = '0'): LookupIndexMutation => ({
  base,
  evaluatedAt: '100',
  edits: [{ key, previous: null, next: { data: { label: key }, expiresAt: '1000' } }],
  event: { reason: 'created' }
})
async function fixture(options: SQLiteLookupIndexOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-index-'))
  paths.push(directory)
  const path = join(directory, 'index.db')
  const store = SQLiteLookupIndex.create(path, 'index', binding, options)
  stores.push(store)
  return { path, store, options }
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('durable SQLite lookup index', () => {
  it('records due timers before claiming a time floor, retaining the original snapshot', async () => {
    const { path, store } = await fixture()
    await store.commit({
      ...mutation(),
      edits: ['01', '02', '03'].map(key => mutation(key).edits[0])
    })
    const original = await store.snapshot('1', null, { records: 10, bytes: 65536 })
    const first = await store.advanceTime('1000', 2)
    expect(first).toMatchObject({
      expired: 2,
      complete: false,
      head: {
        sequence: '3',
        recordedAt: '1000',
        processedThrough: '100'
      }
    })
    await store.close()
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect(await recovered.advanceTime('1000', 2)).toMatchObject({
      expired: 1,
      complete: true,
      head: { sequence: '4', processedThrough: '1000' }
    })
    expect(await recovered.snapshot('1', null, { records: 10, bytes: 65536 })).toEqual(original)
    expect((await recovered.snapshot('4', null, { records: 10, bytes: 65536 })).rows).toEqual([])
    const live = await recovered.changes('1', { records: 10, bytes: 65536 })
    expect(live.groups.map(group => group.changes[0].before?.key)).toEqual(['01', '02', '03'])
    expect(
      live.groups.every(
        group =>
          group.changes.length === 1 &&
          group.changes[0].after === null &&
          group.event.type === 'output-lookup-row-expired/1'
      )
    ).toBe(true)
    expect(await recovered.advanceTime('1000', 2)).toMatchObject({
      expired: 0,
      complete: true,
      head: { sequence: '4' }
    })
  })

  it('does not let a later write erase a due expiry or install data behind the processed clock', async () => {
    const { store } = await fixture()
    const original = mutation()
    const committed = await store.commit(original)
    const replacement: LookupIndexMutation = {
      base: '1',
      evaluatedAt: '1000',
      edits: [{ key: '01', previous: '1', next: { data: { label: 'new' }, expiresAt: null } }],
      event: { reason: 'replaced' }
    }
    await expect(store.commit(replacement)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await store.head()).sequence).toBe('1')
    await store.advanceTime('1100', 1)
    await expect(store.commit(replacement)).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      store.commit({ ...replacement, base: '2', evaluatedAt: '1099' })
    ).rejects.toMatchObject({ code: 'context-changed' })
    await store.commit({
      ...replacement,
      base: '2',
      evaluatedAt: '1100',
      edits: [{ ...replacement.edits[0], previous: null }]
    })
    // Exact prior commit recovery remains possible even after its timers fired.
    expect(await store.commit(original)).toEqual(committed)
    expect(await store.advanceTime('1200', 1)).toMatchObject({
      expired: 0,
      complete: true,
      head: { sequence: '3', processedThrough: '1200' }
    })
    await expect(
      store.commit({
        ...mutation('02', '3'),
        evaluatedAt: '1199',
        edits: [{ key: '02', previous: null, next: { data: {}, expiresAt: null } }]
      })
    ).rejects.toMatchObject({ code: 'context-changed' })
  })

  it('updates and removes indexed timers together with replacements and tombstones', async () => {
    const { store } = await fixture()
    await store.commit(mutation())
    await store.commit({
      ...mutation('01', '1'),
      evaluatedAt: '200',
      edits: [{ key: '01', previous: '1', next: { data: {}, expiresAt: '2000' } }]
    })
    expect(await store.advanceTime('1000', 1)).toMatchObject({ expired: 0, complete: true })
    await store.commit({
      ...mutation('01', '2'),
      evaluatedAt: '1500',
      edits: [{ key: '01', previous: '2', next: null }]
    })
    expect(await store.advanceTime('2000', 1)).toMatchObject({
      expired: 0,
      complete: true,
      head: { sequence: '3' }
    })
  })

  it('rolls back a bounded expiry transaction if its retained capacity runs out', async () => {
    const { store } = await fixture({ capacity: { groups: 2 } })
    await store.commit({ ...mutation(), edits: [mutation('01').edits[0], mutation('02').edits[0]] })
    const before = await store.head()
    await expect(store.advanceTime('1000', 2)).rejects.toMatchObject({ code: 'limited' })
    expect(await store.head()).toEqual(before)
    expect((await store.row('01', '1'))?.key).toBe('01')
    expect(await store.advanceTime('1000', 1)).toMatchObject({
      expired: 1,
      complete: false,
      head: { processedThrough: '100' }
    })
  })

  it.each([0, 1025, 1.5, Number.NaN])('bounds timer work (%s)', async maximum => {
    const { store } = await fixture()
    await expect(store.advanceTime('1000', maximum)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('recovers lost expiry commit acknowledgement without another withdrawal', async () => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    const actual = DatabaseSync.prototype.exec
    let injected = false
    jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      actual.call(this, sql)
      if (sql === 'COMMIT' && !injected) {
        injected = true
        throw new Error('lost expiry acknowledgement')
      }
    })
    await expect(store.advanceTime('1000', 1)).rejects.toThrow('lost expiry acknowledgement')
    jest.restoreAllMocks()
    await store.close()
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect(await recovered.advanceTime('1000', 1)).toMatchObject({
      expired: 0,
      complete: true,
      head: { sequence: '2' }
    })
    expect((await recovered.changes('1', { records: 10, bytes: 65536 })).groups).toHaveLength(1)
  })

  it('owns its sealed configuration and keeps namespaces independent', async () => {
    const { path, store } = await fixture()
    const exposed = store.configuration
    exposed.binding.epoch = 'changed by caller'
    exposed.records.rowBytes = 1
    exposed.capacity.groups = 1
    expect(store.configuration.binding).toEqual(binding)
    expect(store.configuration.records.rowBytes).toBe(1048576)
    expect(store.configuration.capacity.groups).toBe(65536)
    const peer = SQLiteLookupIndex.create(path, 'other', binding)
    stores.push(peer)
    await store.commit(mutation('01'))
    await peer.commit(mutation('02'))
    expect(await peer.row('01', '1')).toBeNull()
    expect(await store.row('02', '1')).toBeNull()
    expect((await store.group('1')).changes[0].key).toBe('01')
    expect((await peer.group('1')).changes[0].key).toBe('02')
  })

  it('budgets Unicode and escaped row data in UTF-8 bytes, returning owned pages', async () => {
    const { store } = await fixture()
    const input = mutation()
    input.edits[0].next!.data.label = '💬"\n'.repeat(30)
    await store.commit(input)
    const page = await store.snapshot('1', null, { records: 1, bytes: 65536 })
    // The builder reserves false, one byte longer than the final true boundary.
    const bound = new TextEncoder().encode(canonicalOutputJSON({ ...page, complete: false })).length
    const bounded = await store.snapshot('1', null, { records: 1, bytes: bound })
    expect(bounded).toEqual(page)
    await expect(store.snapshot('1', null, { records: 1, bytes: bound - 1 })).rejects.toMatchObject(
      { code: 'limited' }
    )
    bounded.rows[0].value.data.label = 'local presentation edit'
    expect(await store.row('01', '1')).toEqual(page.rows[0])
  })
  it('keeps snapshot pages stable across a later insertion, removal and restart', async () => {
    const { path, store } = await fixture()
    await store.commit({ ...mutation(), edits: [mutation('02').edits[0], mutation('04').edits[0]] })
    const limits = { records: 1, bytes: 65536 }
    const first = await store.snapshot('1', null, limits)
    expect(first).toMatchObject({ watermark: '1', after: '02', scanned: 1, complete: false })
    expect(first.rows.map(row => row.key)).toEqual(['02'])
    await store.commit({
      ...mutation('03', '1'),
      edits: [{ key: '04', previous: '1', next: null }, mutation('03').edits[0]]
    })
    expect(await store.snapshot('1', null, limits)).toEqual(first)
    await store.close()
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    const last = await recovered.snapshot('1', first.after, limits)
    expect(last).toMatchObject({ watermark: '1', after: '04', scanned: 1, complete: true })
    expect(last.rows.map(row => row.key)).toEqual(['04'])
    const live = await recovered.changes('1', limits)
    expect(live).toMatchObject({ through: '2', highWater: '2' })
    expect(live.groups).toHaveLength(1)
    expect(live.groups[0].changes.map(change => change.key)).toEqual(['04', '03'])
  })

  it('advances a bounded scan over tombstones without presenting deleted rows as current', async () => {
    const { store } = await fixture()
    await store.commit(mutation())
    await store.commit({
      ...mutation('02', '1'),
      edits: [{ key: '01', previous: '1', next: null }, mutation('02').edits[0]]
    })
    const limits = { records: 1, bytes: 65536 }
    const tombstone = await store.snapshot('2', null, limits)
    expect(tombstone).toEqual({
      watermark: '2',
      rows: [],
      after: '01',
      scanned: 1,
      complete: false
    })
    const next = await store.snapshot('2', tombstone.after, limits)
    expect(next.rows.map(row => row.key)).toEqual(['02'])
    expect(next.complete).toBe(true)
    expect(await store.snapshot('0', null, limits)).toEqual({
      watermark: '0',
      rows: [],
      after: null,
      scanned: 0,
      complete: true
    })
    expect(await store.changes('2', limits)).toEqual({ groups: [], through: '2', highWater: '2' })
  })

  it('charges complete page bytes and stops before a whole row or group that does not fit', async () => {
    const { store } = await fixture()
    await store.commit(mutation('01'))
    await store.commit(mutation('02', '1'))
    const length = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)).length
    const first = await store.snapshot('2', null, { records: 1, bytes: 65536 })
    const page = await store.snapshot('2', null, { records: 10, bytes: length(first) })
    expect(page).toEqual(first)
    await expect(
      store.snapshot('2', null, { records: 10, bytes: length(first) - 1 })
    ).rejects.toMatchObject({ code: 'limited' })
    const firstGroup = await store.changes('0', { records: 1, bytes: 65536 })
    expect(await store.changes('0', { records: 10, bytes: length(firstGroup) })).toEqual(firstGroup)
    await expect(
      store.changes('0', { records: 10, bytes: length(firstGroup) - 1 })
    ).rejects.toMatchObject({ code: 'limited' })
    await expect(store.snapshot('0', null, { records: 1, bytes: 1 })).rejects.toMatchObject({
      code: 'limited'
    })
    await expect(store.changes('2', { records: 1, bytes: 1 })).rejects.toMatchObject({
      code: 'limited'
    })
    expect((await store.head()).sequence).toBe('2')
  })

  it.each([
    { records: 0, bytes: 65536 },
    { records: 1025, bytes: 65536 },
    { records: 1, bytes: 0 },
    { records: 1, bytes: 4194305 },
    { records: 1.5, bytes: 65536 },
    { records: 1, bytes: 65536, extra: true }
  ])('rejects unbounded or malformed page requests (%j)', async limits => {
    const { store } = await fixture()
    await expect(store.snapshot('0', null, limits)).rejects.toMatchObject({ code: 'invalid' })
    await expect(store.changes('0', limits)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('detects a missing live interval instead of returning an empty successful page', async () => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    const sql = new DatabaseSync(path)
    try {
      sql.exec('DELETE FROM output_lookup_groups')
    } finally {
      sql.close()
    }
    await expect(store.changes('0', { records: 1, bytes: 65536 })).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(store.snapshot('2', null, { records: 1, bytes: 65536 })).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
    await expect(store.changes('2', { records: 1, bytes: 65536 })).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
  })
  it('retains complete versions, tombstones and a coherent domain group across reopen', async () => {
    const { path, store } = await fixture()
    const first = await store.commit(mutation())
    const replacement: LookupIndexMutation = {
      base: '1',
      evaluatedAt: '200',
      edits: [
        { key: '01', previous: '1', next: null },
        { key: '02', previous: null, next: { data: { label: 'replacement' }, expiresAt: null } }
      ],
      event: { reason: 'replacement' }
    }
    const second = await store.commit(replacement)
    expect(
      second.changes.map(change => [change.before?.key ?? null, change.after?.key ?? null])
    ).toEqual([
      ['01', null],
      [null, '02']
    ])
    expect(await store.row('01', '0')).toBeNull()
    expect(await store.row('01', '1')).toEqual(first.changes[0].after)
    expect(await store.row('01', '2')).toBeNull()
    expect(await store.row('02', '1')).toBeNull()
    expect(await store.row('02', '2')).toEqual(second.changes[1].after)
    await store.close()
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect(await recovered.group('1')).toEqual(first)
    expect(await recovered.group('2')).toEqual(second)
    expect(await recovered.head()).toMatchObject({
      sequence: '2',
      recordedAt: '200',
      retained: { keys: 2, versions: 3, groups: 2 }
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('chooses one concurrent writer and replays an exact retry without applying it twice', async () => {
    const { path, store } = await fixture()
    const peer = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(peer)
    const writes = [mutation('01'), mutation('02')]
    const results = await Promise.allSettled([store.commit(writes[0]), peer.commit(writes[1])])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const winner = results.findIndex(result => result.status === 'fulfilled')
    const saved = await peer.group('1')
    expect(await peer.commit(writes[winner])).toEqual(saved)
    expect(await store.head()).toMatchObject({
      sequence: '1',
      retained: { keys: 1, versions: 1, groups: 1 }
    })
    await expect(peer.commit(writes[1 - winner])).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recovers an exact commit whose acknowledgement was lost', async () => {
    const { path, store } = await fixture()
    const execute = DatabaseSync.prototype.exec
    const lost = new Error('simulated lost commit acknowledgement')
    let armed = true
    jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      const result = execute.call(this, sql)
      if (sql === 'COMMIT' && armed) {
        armed = false
        throw lost
      }
      return result
    })
    await expect(store.commit(mutation())).rejects.toBe(lost)
    jest.restoreAllMocks()
    await store.close()
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect((await recovered.commit(mutation())).sequence).toBe('1')
    expect((await recovered.head()).retained.groups).toBe(1)
  })

  it('rolls every row and the head back when appending the domain group fails', async () => {
    const { path, store } = await fixture()
    const sql = new DatabaseSync(path)
    try {
      sql.exec(`CREATE TRIGGER test_abort_group BEFORE INSERT ON output_lookup_groups BEGIN
        SELECT RAISE(ABORT,'simulated group append failure'); END;`)
      await expect(store.commit(mutation())).rejects.toThrow('simulated group append failure')
      expect(await store.head()).toEqual({
        sequence: '0',
        recordedAt: '0',
        processedThrough: '0',
        retention: { floor: '0', checkedAt: '0' },
        retained: { keys: 0, versions: 0, groups: 0, pins: 0, bytes: 0 }
      })
      expect(
        sql
          .prepare(
            `SELECT
        (SELECT count(*) FROM output_lookup_keys) AS keys,
        (SELECT count(*) FROM output_lookup_versions) AS versions,
        (SELECT count(*) FROM output_lookup_groups) AS groups`
          )
          .get()
      ).toEqual({ keys: 0, versions: 0, groups: 0 })
      sql.exec('DROP TRIGGER test_abort_group')
      expect((await store.commit(mutation())).sequence).toBe('1')
    } finally {
      sql.close()
    }
  })

  it.each([
    { capacity: { bytes: 1 } },
    { capacity: { keys: 1 } },
    { capacity: { versions: 1 } },
    { capacity: { groups: 1 } }
  ])('preflights retained limits without a partial second group (%j)', async options => {
    const { store } = await fixture(options)
    if (options.capacity.bytes === 1) {
      await expect(store.commit(mutation())).rejects.toMatchObject({ code: 'limited' })
      expect((await store.head()).sequence).toBe('0')
    } else {
      const first = await store.commit(mutation())
      const before = await store.head()
      await expect(store.commit(mutation('02', '1'))).rejects.toMatchObject({ code: 'limited' })
      expect(await store.head()).toEqual(before)
      expect(await store.group('1')).toEqual(first)
      expect(await store.row('02', '1')).toBeNull()
    }
  })

  it('does not reinterpret missing storage or changed configuration as a fresh index', async () => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    const retry = SQLiteLookupIndex.create(path, 'index', binding)
    stores.push(retry)
    expect((await retry.head()).sequence).toBe('1')
    expect(() => SQLiteLookupIndex.open(path, 'other', binding)).toThrow(
      expect.objectContaining({ code: 'reset-required' })
    )
    expect(() => SQLiteLookupIndex.open(path, 'index', { ...binding, epoch: 'new' })).toThrow(
      expect.objectContaining({ code: 'context-changed' })
    )
    expect(() =>
      SQLiteLookupIndex.open(path, 'index', binding, { capacity: { groups: 1 } })
    ).toThrow(expect.objectContaining({ code: 'context-changed' }))
    expect(() => SQLiteLookupIndex.open(path + '.missing', 'index', binding)).toThrow()
    await expect(stat(path + '.missing')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => SQLiteLookupIndex.create(':memory:', 'index', binding)).toThrow(
      'ordinary file path'
    )
    expect(() => SQLiteLookupIndex.create('file:temp', 'index', binding)).toThrow(
      'ordinary file path'
    )
  })

  it('rejects corrupt records, missing historical versions and incomplete restart inventory', async () => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    const sql = new DatabaseSync(path)
    try {
      sql.prepare('UPDATE output_lookup_groups SET digest=?').run('0'.repeat(64))
      await expect(store.group('1')).rejects.toMatchObject({ code: 'reset-required' })
      sql.exec('DELETE FROM output_lookup_versions')
      await expect(store.row('01', '1')).rejects.toMatchObject({ code: 'reset-required' })
      await store.close()
      expect(() => SQLiteLookupIndex.open(path, 'index', binding)).toThrow(
        'inventory is incomplete'
      )
    } finally {
      sql.close()
    }
  })

  it('rejects future watermarks, stale time, changed predicates and closed storage', async () => {
    const { store } = await fixture()
    await store.commit(mutation())
    await expect(store.row('01', '2')).rejects.toMatchObject({ code: 'revision-unavailable' })
    await expect(store.group('0')).rejects.toMatchObject({ code: 'revision-unavailable' })
    await expect(store.group('2')).rejects.toMatchObject({ code: 'revision-unavailable' })
    await expect(store.commit({ ...mutation('02', '1'), evaluatedAt: '99' })).rejects.toMatchObject(
      { code: 'context-changed' }
    )
    await expect(store.commit(mutation('01', '1'))).rejects.toMatchObject({ code: 'conflict' })
    await store.close()
    await expect(store.head()).rejects.toMatchObject({ code: 'unavailable' })
    await store.close()
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

it('matches a row-map model across generated updates, deletions and exact lost-ack retries', async () => {
  const { store } = await fixture()
  const expected = new Map<string, { revision: string; label: string }>()
  let sequence = 0n
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 7 }),
      fc.boolean(),
      fc.string({ maxLength: 40 }),
      async (number, remove, label) => {
        const key = number.toString(16).padStart(2, '0'),
          before = expected.get(key)
        const change: LookupIndexMutation = {
          base: sequence.toString(),
          evaluatedAt: '100',
          event: { reason: 'model' },
          edits: [
            {
              key,
              previous: before?.revision ?? null,
              next: remove ? null : { data: { label }, expiresAt: null }
            }
          ]
        }
        const committed = await store.commit(change)
        sequence++
        expect(committed.sequence).toBe(sequence.toString())
        expect(await store.commit(change)).toEqual(committed)
        if (remove) expected.delete(key)
        else expected.set(key, { revision: sequence.toString(), label })
        const page = await store.snapshot(sequence.toString(), null, { records: 128, bytes: 65536 })
        expect(page.complete).toBe(true)
        expect(
          page.rows.map(row => ({
            key: row.key,
            revision: row.revision,
            label: row.value.data.label
          }))
        ).toEqual(
          [...expected]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => ({ key, ...value }))
        )
        expect((await store.head()).sequence).toBe(sequence.toString())
      }
    )
  )
}, 120000)

it('validates every capacity and binding before opening a durable file', async () => {
  const { path, store } = await fixture()
  for (const capacity of [
    { keys: 0 },
    { versions: 1.5 },
    { groups: 65537 },
    { pins: NaN },
    { bytes: 268435457 },
    { unknown: 1 }
  ])
    expect(() => SQLiteLookupIndex.create(path, 'invalid', binding, { capacity })).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid lookup storage capacity' })
    )
  for (const invalid of [null, [], 'binding', 1])
    expect(() =>
      SQLiteLookupIndex.create(path, 'invalid', invalid as unknown as OutputJSONObject)
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Lookup index binding must be a JSON object'
      })
    )
  expect(() => SQLiteLookupIndex.create(path, 'invalid', { oversized: 'x'.repeat(65536) })).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect((await store.head()).sequence).toBe('0')
  expect((await store.snapshot('0', null, { records: 1024, bytes: 4194304 })).complete).toBe(true)
  expect((await store.advanceTime('0', 1024)).complete).toBe(true)
})

it('fails closed on invalid retained counters and inconsistent log head metadata', async () => {
  const { path, store } = await fixture()
  const sql = new DatabaseSync(path)
  try {
    for (const count of [-1, 65537]) {
      sql.prepare('UPDATE output_lookup_meta SET keys=?').run(count)
      await expect(store.head()).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Invalid lookup index retained counts'
      })
    }
    sql.exec('UPDATE output_lookup_meta SET keys=0,groups=1')
    await expect(store.head()).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup index lost its contiguous log head'
    })
  } finally {
    sql.close()
  }
})

it.each(['keys', 'versions', 'pins', 'payload_bytes', 'groups'])(
  'does not reopen an incomplete retained inventory: %s',
  async field => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    await store.close()
    const sql = new DatabaseSync(path)
    try {
      if (field === 'groups') sql.exec('DELETE FROM output_lookup_groups')
      else sql.exec('UPDATE output_lookup_meta SET ' + field + '=' + field + '+1')
      expect(() => SQLiteLookupIndex.open(path, 'index', binding)).toThrow(
        expect.objectContaining({
          code: 'reset-required',
          message: 'Lookup index retained inventory is incomplete'
        })
      )
    } finally {
      sql.close()
    }
  }
)

it('enforces the complete old-row read-set budget before any multi-row mutation', async () => {
  const { store } = await fixture({ records: { groupBytes: 4096 } })
  for (let i = 0; i < 2; i++) {
    const change = mutation('0' + (i + 1), String(i))
    change.edits[0].next!.data.label = 'x'.repeat(3000)
    await store.commit(change)
  }
  const before = await store.head()
  await expect(
    store.commit({
      base: '2',
      evaluatedAt: '100',
      edits: [
        { key: '01', previous: '1', next: null },
        { key: '02', previous: '2', next: null }
      ],
      event: {}
    })
  ).rejects.toMatchObject({ code: 'limited', message: 'Lookup mutation read-set byte limit' })
  expect(await store.head()).toEqual(before)
})

it('does not turn a tombstone with a corrupted live timer into an expiry success', async () => {
  const { path, store } = await fixture()
  await store.commit({ ...mutation(), edits: [{ key: '01', previous: null, next: null }] })
  const sql = new DatabaseSync(path)
  try {
    const state = { first: '1', current: '1', expiresAt: '1000' }
    const digest = createHash('sha256')
      .update(
        canonicalOutputJSON({
          format: 'output-lookup-record/1',
          namespace: 'index',
          kind: 'key',
          identity: '01'
        }) +
          '\0' +
          canonicalOutputJSON(state)
      )
      .digest('hex')
    sql
      .prepare('UPDATE output_lookup_keys SET expires_at=?,head_digest=?')
      .run('00000000000003e8', digest)
    await expect(store.advanceTime('1000', 1)).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup timer lost its current row binding'
    })
    expect((await store.head()).sequence).toBe('1')
  } finally {
    sql.close()
  }
})

it('counts separators and accepts exactly bounded empty and two-record pages', async () => {
  const { store } = await fixture()
  const size = (value: unknown) => Buffer.byteLength(canonicalOutputJSON(value))
  const empty = await store.snapshot('0', null, { records: 1, bytes: 65536 })
  expect(
    await store.snapshot('0', null, { records: 1, bytes: size({ ...empty, complete: false }) })
  ).toEqual(empty)
  const quiet = await store.changes('0', { records: 1, bytes: 65536 })
  expect(await store.changes('0', { records: 1, bytes: size(quiet) })).toEqual(quiet)
  await store.commit(mutation('01'))
  await store.commit(mutation('02', '1'))
  const rows = await store.snapshot('2', null, { records: 2, bytes: 65536 })
  const budget = size({ ...rows, complete: false })
  expect((await store.snapshot('2', null, { records: 2, bytes: budget })).rows).toHaveLength(2)
  expect((await store.snapshot('2', null, { records: 2, bytes: budget - 1 })).rows).toHaveLength(1)
  const groups = await store.changes('0', { records: 2, bytes: 65536 })
  expect(await store.changes('0', { records: 2, bytes: size(groups) })).toEqual(groups)
  expect((await store.changes('0', { records: 2, bytes: size(groups) - 1 })).groups).toHaveLength(1)
})

it('binds the compound format and exact immutable owner configuration independently of legacy indexes', () => {
  const composition = { owner: 'proposal-owner', privacy: 'current-access/1' }
  const ordinary = lookupIndexDefinition('index', binding, {})
  const compound = lookupIndexDefinition('index', binding, {}, composition)
  expect(JSON.parse(ordinary.configurationJSON)).toMatchObject({ format: 'output-lookup-index/1' })
  expect(JSON.parse(ordinary.configurationJSON)).not.toHaveProperty('composition')
  expect(JSON.parse(compound.configurationJSON)).toMatchObject({
    format: 'proposal-current-channel-index/1',
    composition
  })
  expect(compound.configurationJSON).not.toEqual(ordinary.configurationJSON)
  composition.owner = 'changed'
  expect(JSON.parse(compound.configurationJSON).composition.owner).toBe('proposal-owner')
})
it('keeps compound lookup writes, head and row reads under one native write transaction', () => {
  const database = new DatabaseSync(':memory:')
  const domain = new SQLiteTransactionDomain(database)
  const definition = lookupIndexDefinition('compound', binding, {}, { owner: 'test-owner' })
  const store = new SQLiteLookupIndexStore(domain, definition)
  const companion = store[sqliteLookupComposition]
  try {
    expect(() => companion.initialize(true)).toThrow('requires a write transaction')
    domain.transaction(() => companion.initialize(true))
    expect(() => companion.append(mutation())).toThrow('requires a write transaction')
    expect(() => companion.head()).toThrow('requires a write transaction')
    expect(() => companion.row('01')).toThrow('requires a write transaction')
    domain.transaction(
      () => {
        expect(() => companion.append(mutation())).toThrow('requires a write transaction')
        expect(() => companion.head()).toThrow('requires a write transaction')
        expect(() => companion.row('01')).toThrow('requires a write transaction')
        companion.initialize(false)
      },
      { write: false }
    )
    expect(() =>
      domain.transaction(() => {
        expect(companion.append(mutation()).sequence).toBe('1')
        expect(companion.head().sequence).toBe('1')
        expect(companion.row('01')).toMatchObject({ key: '01', value: { data: { label: '01' } } })
        expect(() => companion.row('invalid-key')).toThrow()
        throw new Error('Rollback compound publication')
      })
    ).toThrow('Rollback compound publication')
    domain.transaction(() => {
      expect(companion.head().sequence).toBe('0')
      expect(companion.row('01')).toBeNull()
      const result = companion.append(mutation())
      expect(result.sequence).toBe('1')
      expect(companion.append(mutation())).toEqual(result)
      expect(companion.row('01')).toMatchObject({ key: '01', revision: '1' })
    })
    expect(() => new SQLiteLookupIndexStore(domain, definition)).toThrow(
      'already owns this namespace'
    )
    expect(
      () => new SQLiteLookupIndexStore(domain, lookupIndexDefinition('independent', binding, {}))
    ).not.toThrow()
  } finally {
    domain.close()
  }
})
it('rejects incomplete or extended compaction shapes rather than silently ignoring a caller bound', async () => {
  const { store } = await fixture()
  for (const limits of [
    { groups: 1, versions: 1 },
    { groups: 1, versions: 1, pins: 1, extra: 1 }
  ])
    await expect(
      store.compact('100', limits as unknown as LookupIndexCompactionLimits)
    ).rejects.toMatchObject({ code: 'invalid' })
})
