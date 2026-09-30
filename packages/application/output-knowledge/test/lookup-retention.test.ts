import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { sqliteLookupBridge } from '../src/lookup/SQLiteLookupBridge.js'
import { canonicalOutputJSON } from '@bsv/sdk'
import { LookupIndexCodec } from '../src/lookup/LookupIndexCodec.js'
import {
  decimal,
  position,
  bytes,
  prepareLookupStatement
} from '../src/lookup/SQLiteLookupEncoding.js'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  SQLiteLookupIndex,
  type SQLiteLookupIndexOptions
} from '../src/lookup/SQLiteLookupIndex.js'
import type { LookupIndexMutation } from '../src/lookup/LookupIndexCodec.js'

const binding = { service: 'records', epoch: 'retention-tests' }
const stores: SQLiteLookupIndex[] = []
const paths: string[] = []
const limits = { groups: 1024, versions: 1024, pins: 1024 }
const pages = { records: 10, bytes: 65536 }
const firstPin = '01'.repeat(32),
  secondPin = '02'.repeat(32)
async function fixture(options: SQLiteLookupIndexOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-retention-'))
  paths.push(directory)
  const path = join(directory, 'index.db')
  const store = SQLiteLookupIndex.create(path, 'index', binding, options)
  stores.push(store)
  return { path, store }
}
const update = (base: number, time = 100 + base): LookupIndexMutation => ({
  base: String(base),
  evaluatedAt: String(time),
  edits: [
    {
      key: '01',
      previous: base === 0 ? null : String(base),
      next: { data: { value: base }, expiresAt: null }
    }
  ],
  event: { type: 'updated' }
})
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('lookup retained history', () => {
  it('refuses to compact after a retained pin disappears without its atomic count change', async () => {
    const { path, store } = await fixture()
    await store.commit(update(0))
    await store.retainSnapshot(firstPin, '0', '1000')
    const sql = new DatabaseSync(path)
    try {
      sql.exec('DELETE FROM output_lookup_pins')
      await expect(store.compact('500', limits)).rejects.toMatchObject({ code: 'reset-required' })
      expect((await store.group('1')).sequence).toBe('1')
      expect((await store.head()).retention.floor).toBe('0')
    } finally {
      sql.close()
    }
  })
  it.each(['1', '2', '3'])(
    'does not fall back to an older row after retained version %s is lost',
    async removed => {
      const { path, store } = await fixture()
      for (let base = 0; base < 3; base++) await store.commit(update(base))
      const sql = new DatabaseSync(path)
      try {
        sql
          .prepare('DELETE FROM output_lookup_versions WHERE sequence=?')
          .run(BigInt(removed).toString(16).padStart(16, '0'))
        await expect(store.row('01', removed)).rejects.toMatchObject({ code: 'reset-required' })
        await expect(store.snapshot(removed, null, pages)).rejects.toMatchObject({
          code: 'reset-required'
        })
      } finally {
        sql.close()
      }
    }
  )

  it('detects a lost tombstone instead of resurrecting a withdrawn output', async () => {
    const { path, store } = await fixture()
    await store.commit(update(0))
    await store.commit({ ...update(1), edits: [{ key: '01', previous: '1', next: null }] })
    const sql = new DatabaseSync(path)
    try {
      sql.prepare('DELETE FROM output_lookup_versions WHERE sequence=?').run('0000000000000002')
      await expect(store.row('01', '2')).rejects.toMatchObject({ code: 'reset-required' })
      expect((await store.row('01', '1'))?.revision).toBe('1')
    } finally {
      sql.close()
    }
  })

  it('detects damaged key metadata and version links before returning a row', async () => {
    const { path, store } = await fixture()
    await store.commit(update(0))
    await store.commit(update(1))
    const sql = new DatabaseSync(path)
    try {
      sql.exec(
        "UPDATE output_lookup_versions SET next_sequence=NULL WHERE sequence='0000000000000001'"
      )
      await expect(store.row('01', '1')).rejects.toMatchObject({ code: 'reset-required' })
      sql.exec("UPDATE output_lookup_keys SET expires_at='0000000000000001'")
      await expect(store.row('01', '2')).rejects.toMatchObject({ code: 'reset-required' })
    } finally {
      sql.close()
    }
  })

  it('preserves every pinned snapshot baseline and following log through fixed deadlines', async () => {
    const { path, store } = await fixture()
    await store.commit(update(0))
    const first = await store.snapshot('1', null, pages)
    await store.retainSnapshot(firstPin, '1', '1000')
    await store.commit(update(1))
    const second = await store.snapshot('2', null, pages)
    await store.retainSnapshot(secondPin, '2', '1500')
    await store.commit(update(2))
    expect(await store.compact('500', limits)).toMatchObject({
      head: {
        retention: { floor: '1', checkedAt: '500' },
        retained: { groups: 2, versions: 3, pins: 2 }
      },
      removed: { groups: 1, versions: 0, pins: 0 }
    })
    expect(await store.snapshot('1', null, pages)).toEqual(first)
    expect((await store.changes('1', pages)).groups.map(group => group.sequence)).toEqual([
      '2',
      '3'
    ])
    await store.close()
    const reopened = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(reopened)
    expect(await reopened.compact('1000', limits)).toMatchObject({
      head: { retention: { floor: '2' }, retained: { groups: 1, versions: 2, pins: 1 } },
      removed: { groups: 1, versions: 1, pins: 1 }
    })
    expect(await reopened.snapshot('2', null, pages)).toEqual(second)
    await expect(reopened.snapshot('1', null, pages)).rejects.toMatchObject({
      code: 'reset-required'
    })
    expect(await reopened.compact('1500', limits)).toMatchObject({
      head: { retention: { floor: '3' }, retained: { groups: 0, versions: 1, pins: 0 } },
      removed: { groups: 1, versions: 1, pins: 1 }
    })
    expect((await reopened.row('01', '3'))?.value.data.value).toBe(2)
    expect(await reopened.changes('3', pages)).toEqual({ groups: [], through: '3', highWater: '3' })
  })

  it('bounds each compaction and permits new mutations without recycling log positions', async () => {
    const { path, store } = await fixture({ capacity: { groups: 3 } })
    for (let base = 0; base < 3; base++) await store.commit(update(base))
    await expect(store.commit(update(3))).rejects.toMatchObject({ code: 'limited' })
    expect(await store.compact('500', { groups: 1, versions: 1, pins: 1 })).toMatchObject({
      head: { sequence: '3', retention: { floor: '1' } },
      removed: { groups: 1, versions: 0, pins: 0 }
    })
    await store.commit(update(3, 500))
    expect((await store.head()).sequence).toBe('4')
    await expect(store.commit(update(0))).rejects.toMatchObject({ code: 'reset-required' })
    await expect(store.retainSnapshot(firstPin, '0', '1000')).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(store.row('01', '0')).rejects.toMatchObject({ code: 'reset-required' })
    await expect(store.group('1')).rejects.toMatchObject({ code: 'reset-required' })
    await expect(store.changes('0', pages)).rejects.toMatchObject({ code: 'reset-required' })
    await store.compact('500', limits)
    const stable = await store.head()
    await store.close()
    const reopened = SQLiteLookupIndex.open(path, 'index', binding, { capacity: { groups: 3 } })
    stores.push(reopened)
    expect(await reopened.head()).toEqual(stable)
    expect((await reopened.row('01', '4'))?.revision).toBe('4')
  })

  it('seals exact pin deadlines and fails capacity or stale/future pin requests explicitly', async () => {
    const { store } = await fixture({ capacity: { pins: 1 } })
    await store.retainSnapshot(firstPin, '0', '1000')
    await store.retainSnapshot(firstPin, '0', '1000')
    await expect(store.retainSnapshot(firstPin, '0', '1001')).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(store.retainSnapshot(secondPin, '0', '1000')).rejects.toMatchObject({
      code: 'limited'
    })
    await expect(store.retainSnapshot(secondPin, '1', '1000')).rejects.toMatchObject({
      code: 'revision-unavailable'
    })
    await store.compact('1000', limits)
    await expect(store.retainSnapshot(firstPin, '0', '1000')).rejects.toMatchObject({
      code: 'expired'
    })
    await store.retainSnapshot(secondPin, '0', '1100')
    await expect(store.compact('999', limits)).rejects.toMatchObject({ code: 'context-changed' })
    await expect(store.commit(update(0, 999))).rejects.toMatchObject({ code: 'context-changed' })
    await expect(store.advanceTime('999', 1)).rejects.toMatchObject({ code: 'context-changed' })
  })

  it('arbitrates retention against compaction across independent connections', async () => {
    const { path, store } = await fixture()
    const peer = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(peer)
    await store.commit(update(0))
    await peer.retainSnapshot(firstPin, '0', '1000')
    expect((await store.compact('500', limits)).head.retention.floor).toBe('0')
    await store.compact('1000', limits)
    await expect(peer.retainSnapshot(secondPin, '0', '1500')).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('rolls back log, row and floor deletion together after a mid-compaction failure', async () => {
    const { path, store } = await fixture()
    await store.commit(update(0))
    await store.commit(update(1))
    const before = await store.head()
    const sql = new DatabaseSync(path)
    try {
      sql.exec(`CREATE TRIGGER fail_compaction BEFORE DELETE ON output_lookup_versions BEGIN
        SELECT RAISE(ABORT,'simulated compaction failure'); END;`)
      await expect(store.compact('500', limits)).rejects.toThrow('simulated compaction failure')
      expect(await store.head()).toEqual(before)
      expect((await store.group('1')).sequence).toBe('1')
    } finally {
      sql.close()
    }
  })

  it('preserves tombstone scan order while compacting prior versions', async () => {
    const { store } = await fixture()
    await store.commit(update(0))
    await store.commit({ ...update(1), edits: [{ key: '01', previous: '1', next: null }] })
    const before = await store.snapshot('2', null, pages)
    await store.retainSnapshot(firstPin, '2', '1000')
    await store.compact('500', limits)
    expect(await store.snapshot('2', null, pages)).toEqual(before)
    expect(before).toMatchObject({ rows: [], after: '01', scanned: 1, complete: true })
    await store.commit({
      ...update(2, 500),
      edits: [{ key: '01', previous: null, next: { data: {}, expiresAt: null } }]
    })
    expect(await store.row('01', '2')).toBeNull()
    expect((await store.row('01', '3'))?.revision).toBe('3')
  })

  it.each([
    { ...limits, groups: 0 },
    { ...limits, versions: 1025 },
    { ...limits, pins: 1.5 },
    { ...limits, extra: 1 }
  ])('rejects unbounded compaction (%j)', async invalid => {
    const { store } = await fixture()
    await expect(store.compact('1000', invalid)).rejects.toMatchObject({ code: 'invalid' })
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

it('retains the exact pinned baseline and later groups over generated compaction boundaries', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 8 }), fc.nat({ max: 8 }), async (count, choice) => {
      const { store } = await fixture()
      try {
        for (let base = 0; base < count; base++) await store.commit(update(base))
        const watermark = choice % (count + 1)
        await store.retainSnapshot(firstPin, String(watermark), '1000')
        const compacted = await store.compact('500', limits)
        expect(compacted.head.retention.floor).toBe(String(watermark))
        const row = await store.row('01', String(watermark))
        if (watermark === 0) expect(row).toBeNull()
        else expect(row?.value.data.value).toBe(watermark - 1)
        expect((await store.changes(String(watermark), pages)).groups.map(x => x.sequence)).toEqual(
          Array.from({ length: count - watermark }, (_, i) => String(watermark + i + 1))
        )
        expect((await store.compact('1000', limits)).head.retention.floor).toBe(String(count))
        if (watermark < count)
          await expect(store.row('01', String(watermark))).rejects.toMatchObject({
            code: 'reset-required'
          })
      } finally {
        await store.close()
      }
    })
  )
}, 120000)

// An independent digest oracle protects the persisted record-format contract.
function retainedDigest(kind: string, identity: string, payload: string): string {
  return createHash('sha256')
    .update(
      canonicalOutputJSON({
        format: 'output-lookup-record/1',
        namespace: 'index',
        kind,
        identity
      }) +
        '\0' +
        payload
    )
    .digest('hex')
}

it('encodes full unsigned sequence positions and rejects corrupt persisted encodings', () => {
  for (const value of [
    undefined,
    null,
    7,
    '',
    '0'.repeat(15),
    '0'.repeat(17),
    'G'.repeat(16),
    'F'.repeat(16),
    '0'.repeat(15) + ' '
  ])
    expect(() => decimal(value)).toThrow(
      expect.objectContaining({ code: 'reset-required', message: 'Invalid lookup index sequence' })
    )
  expect(position('0')).toBe('0000000000000000')
  expect(position('18446744073709551615')).toBe('ffffffffffffffff')
  expect(decimal('ffffffffffffffff')).toBe('18446744073709551615')
  expect(bytes('aé🌍')).toBe(7)
})

it('independently binds persisted row payloads to their key, revision and current expiry', async () => {
  const { path, store } = await fixture()
  await store.commit(update(0))
  const original = (await store.row('01', '1'))!
  const sql = new DatabaseSync(path)
  try {
    const saved = sql
      .prepare('SELECT payload,digest,payload_bytes FROM output_lookup_versions')
      .get()!
    expect(saved.digest).toBe(retainedDigest('row', '01:1', saved.payload as string))
    for (const altered of [
      { ...original, key: '02' },
      { ...original, revision: '2' },
      { ...original, value: { ...original.value, expiresAt: '1000' } }
    ]) {
      const payload = canonicalOutputJSON(altered)
      sql
        .prepare('UPDATE output_lookup_versions SET payload=?,payload_bytes=?,digest=?')
        .run(payload, Buffer.byteLength(payload), retainedDigest('row', '01:1', payload))
      await expect(store.row('01', '1')).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup row version binding changed'
      })
    }
    sql
      .prepare('UPDATE output_lookup_versions SET payload=?,payload_bytes=?,digest=?')
      .run(saved.payload, Number(saved.payload_bytes) + 1, saved.digest)
    await expect(store.row('01', '1')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Invalid lookup index record integrity'
    })
  } finally {
    sql.close()
  }
})

it('rejects impossible key heads even when their checksums are internally consistent', async () => {
  const { path, store } = await fixture()
  await store.commit(update(0))
  const sql = new DatabaseSync(path)
  try {
    for (const state of [
      { first: '0', current: '1', expiresAt: null },
      { first: '2', current: '1', expiresAt: null },
      { first: '1', current: '2', expiresAt: null }
    ]) {
      sql
        .prepare('UPDATE output_lookup_keys SET first_sequence=?,current_sequence=?,head_digest=?')
        .run(
          position(state.first),
          position(state.current),
          retainedDigest('key', '01', canonicalOutputJSON(state))
        )
      await expect(store.row('01', '1')).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup key lost its head binding'
      })
    }
    sql
      .prepare('UPDATE output_lookup_keys SET first_sequence=?,current_sequence=?,head_digest=?')
      .run(position('1'), position('1'), 'ff'.repeat(32))
    await expect(store.row('01', '1')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup key lost its head binding'
    })
  } finally {
    sql.close()
  }
})

it('refuses inconsistent history links and missing current versions instead of falling back', async () => {
  const { path, store } = await fixture()
  for (let base = 0; base < 3; base++) await store.commit(update(base))
  const sql = new DatabaseSync(path)
  try {
    for (const next of [null, '4']) {
      sql
        .prepare('UPDATE output_lookup_versions SET next_sequence=?,link_digest=? WHERE sequence=?')
        .run(
          next === null ? null : position(next),
          retainedDigest('link', '01:1', canonicalOutputJSON(next)),
          position('1')
        )
      await expect(store.row('01', '1')).rejects.toMatchObject({
        code: 'reset-required',
        message:
          next === null
            ? 'Lookup row lost its current version'
            : 'Lookup row lost a promised history interval'
      })
    }
    sql
      .prepare('UPDATE output_lookup_versions SET next_sequence=?,link_digest=? WHERE sequence=?')
      .run(position('2'), 'ff'.repeat(32), position('1'))
    await expect(store.row('01', '1')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup row lost its history binding'
    })
    sql
      .prepare('UPDATE output_lookup_versions SET link_digest=? WHERE sequence=?')
      .run(retainedDigest('link', '01:1', canonicalOutputJSON('2')), position('1'))
    sql.prepare('DELETE FROM output_lookup_versions WHERE sequence=?').run(position('2'))
    const head = { first: '2', current: '3', expiresAt: null }
    sql
      .prepare('UPDATE output_lookup_keys SET first_sequence=?,head_digest=?')
      .run(position('2'), retainedDigest('key', '01', canonicalOutputJSON(head)))
    await expect(store.row('01', '2')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup row lost its history binding'
    })
  } finally {
    sql.close()
  }
})

it('rolls back a write when its prior version link could not be updated', async () => {
  const { path, store } = await fixture()
  await store.commit(update(0))
  const sql = new DatabaseSync(path)
  try {
    sql.exec(
      'CREATE TRIGGER fail_link BEFORE UPDATE ON output_lookup_versions BEGIN SELECT RAISE(IGNORE); END'
    )
    await expect(store.commit(update(1))).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup write lost its current version link'
    })
    expect((await store.head()).sequence).toBe('1')
    expect((await store.row('01', '1'))!.value.data).toEqual({ value: 0 })
    sql.exec('DROP TRIGGER fail_link')
    expect((await store.commit(update(1))).sequence).toBe('2')
  } finally {
    sql.close()
  }
})

it('binds a retained domain group to its requested sequence and original mutation identity', async () => {
  const { path, store } = await fixture()
  const group = await store.commit(update(0))
  const sql = new DatabaseSync(path)
  try {
    sql.prepare('UPDATE output_lookup_groups SET mutation_key=?').run('ff'.repeat(32))
    await expect(store.group('1')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup group binding changed'
    })
    const changed = {
        ...group,
        sequence: '2',
        changes: group.changes.map(change => ({
          ...change,
          after: change.after === null ? null : { ...change.after, revision: '2' }
        }))
      },
      codec = new LookupIndexCodec()
    const payload = canonicalOutputJSON(changed),
      mutationKey = codec.mutationKey(codec.original(changed))
    sql
      .prepare('UPDATE output_lookup_groups SET payload=?,payload_bytes=?,digest=?,mutation_key=?')
      .run(payload, Buffer.byteLength(payload), retainedDigest('group', '1', payload), mutationKey)
    await expect(store.group('1')).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup group binding changed'
    })
  } finally {
    sql.close()
  }
})

it('shares the actual owner transaction with its session companion bridge', async () => {
  const { store } = await fixture()
  const bridge = store[sqliteLookupBridge]()
  expect(bridge.namespace).toBe('index')
  expect(bridge.head()).toEqual(await store.head())
  expect(bridge.database.prepare('PRAGMA journal_mode').get()!.journal_mode).toBe('wal')
  expect(bridge.database.prepare('PRAGMA synchronous').get()!.synchronous).toBe(2)
  expect(bridge.database.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(1000)
  expect(bridge.database.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
  expect(() => bridge.database.enableLoadExtension(true)).toThrow()
  expect(() =>
    bridge.transaction(() => {
      bridge.retainSnapshot(firstPin, '0', '1000')
      expect(bridge.head().retained.pins).toBe(1)
      throw new Error('companion rollback')
    })
  ).toThrow('companion rollback')
  expect((await store.head()).retained.pins).toBe(0)
  bridge.transaction(() => bridge.retainSnapshot(firstPin, '0', '1000'))
  expect((await store.head()).retained.pins).toBe(1)
})

it('rejects compaction when a retained pin names future or already-lost history', async () => {
  for (const watermark of ['0', '2']) {
    const { path, store } = await fixture()
    await store.commit(update(0))
    await store.compact('200', limits)
    await store.retainSnapshot(firstPin, '1', '1000')
    const sql = new DatabaseSync(path)
    try {
      sql.prepare('UPDATE output_lookup_pins SET watermark=?').run(position(watermark))
      await expect(store.compact('201', limits)).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup retention pin lost its history'
      })
      expect((await store.head()).retention.floor).toBe('1')
    } finally {
      sql.close()
    }
  }
})

it('refuses missing compaction intervals and corrupted removable row sizes without deleting anything', async () => {
  const { path, store } = await fixture()
  await store.commit(update(0))
  await store.commit(update(1))
  const sql = new DatabaseSync(path)
  try {
    for (const size of [0, 1048577]) {
      sql
        .prepare('UPDATE output_lookup_versions SET payload_bytes=? WHERE sequence=?')
        .run(size, position('1'))
      await expect(store.compact('500', limits)).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Invalid compacted lookup row size'
      })
      expect((await store.head()).retention.floor).toBe('0')
      expect(sql.prepare('SELECT count(*) AS n FROM output_lookup_groups').get()!.n).toBe(2)
    }
    sql.prepare('DELETE FROM output_lookup_groups WHERE sequence=?').run(position('1'))
    await expect(store.compact('500', limits)).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup compaction found a missing log interval'
    })
    expect((await store.head()).retention.floor).toBe('0')
  } finally {
    sql.close()
  }
})

it('does not move an existing retention promise to another committed watermark', async () => {
  const { store } = await fixture()
  await store.commit(update(0))
  await store.retainSnapshot(firstPin, '0', '1000')
  await expect(store.retainSnapshot(firstPin, '1', '1000')).rejects.toMatchObject({
    code: 'conflict',
    message: 'Lookup retention promise changed'
  })
  expect((await store.compact('500', limits)).head.retention.floor).toBe('0')
})

it('validates all compaction keys and rejects a time before the latest domain write', async () => {
  const { store } = await fixture()
  for (const input of [
    { groups: 1, versions: 1, extra: 1 },
    { ...limits, pins: 0 },
    { ...limits, groups: 1.5 }
  ])
    await expect(store.compact('500', input as typeof limits)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Invalid lookup compaction work bound'
    })
  await store.commit(update(0, 500))
  await expect(store.compact('499', limits)).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Lookup retention clock moved backwards'
  })
})

it('rejects missing SQL before invoking the native statement compiler and preserves driver errors', () => {
  const failure = new Error('test-owned driver failure')
  const prepare = jest.fn((_sql: string): never => {
    throw failure
  })
  for (const sql of ['', ' ', '\n\t']) {
    expect(() => prepareLookupStatement({ prepare }, sql)).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Lookup SQL statement is empty' })
    )
  }
  expect(prepare).not.toHaveBeenCalled()
  expect(() => prepareLookupStatement({ prepare }, ' SELECT ? ')).toThrow(failure)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledWith(' SELECT ? ')
})

it('retains the native statement and its parameterized execution unchanged', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const statement = prepareLookupStatement(database, 'SELECT ? AS value')
    expect(statement.get('owned-value')).toEqual({ value: 'owned-value' })
    expect(statement.get(7)).toEqual({ value: 7 })
  } finally {
    database.close()
  }
})
