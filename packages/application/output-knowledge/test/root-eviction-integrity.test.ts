import { afterEach, expect, it, jest } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  apply,
  chain,
  clock,
  fixture,
  policy,
  request,
  requester,
  root,
  selected,
  signed
} from './root-eviction-fixture.js'
import { SQLiteRootEvictionDatabase } from '../src/root-eviction/SQLiteRootEvictionDatabase.js'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const f of fixtures.splice(0)) await f.cleanup()
})
const error = (code = 'unavailable') => ({ code, message: expect.stringMatching(/\S/) })
function alter(path: string, sql: string, ...args: (string | number | null)[]) {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON')
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

it.each(['', ':memory:', 'file:root-journal.db'])(
  'requires a durable explicit filesystem path (%s)',
  path => {
    expect(() => SQLiteRootEvictionStore.open(path, { root, chain })).toThrow(
      expect.objectContaining(error('invalid'))
    )
  }
)
it('creates private durable WAL storage with synchronous commits, foreign keys and no extension loading', async () => {
  const f = await make(),
    bridge = new SQLiteRootEvictionDatabase(f.path, f.configuration, undefined)
  const { stat } = await import('node:fs/promises')
  expect((await stat(f.path)).mode & 0o777).toBe(0o600)
  try {
    bridge.transaction(() => {
      expect(bridge.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' })
      expect(bridge.get('PRAGMA synchronous')).toEqual({ synchronous: 2 })
      expect(bridge.get('PRAGMA busy_timeout')).toEqual({ timeout: 1000 })
      expect(bridge.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 })
      expect(() =>
        bridge.get("SELECT load_extension('nonexistent-root-fixture-extension')")
      ).toThrow(/not authorized/i)
    })
  } finally {
    bridge.close()
  }
})
it.each([5, 6])(
  'classifies SQLite busy/locked code %i as a retryable unavailable result',
  async errcode => {
    const { store } = await make()
    jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
      throw { errcode }
    })
    await expect(store.head()).rejects.toMatchObject({ ...error(), retryable: true })
  }
)
it.each([null, undefined, 'I/O', 9, { errcode: 9 }, { errcode: '5' }, () => undefined])(
  'preserves an unrecognized driver failure %#',
  async failure => {
    const { store } = await make()
    jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
      throw failure
    })
    await expect(store.head()).rejects.toBe(failure)
  }
)
it('supports synchronous scalar/null callbacks and refuses function thenables without running their work', async () => {
  const f = await make(),
    bridge = new SQLiteRootEvictionDatabase(f.path, f.configuration, undefined)
  try {
    expect(bridge.transaction(() => null)).toBeNull()
    expect(bridge.transaction(() => 42)).toBe(42)
    // Model a callable adapter whose asynchronous completion is exposed through
    // a proxy. The transaction bridge must reject it without assimilating it.
    const completion = Promise.resolve(true)
    const thenable = new Proxy(() => undefined, {
      has: (target, key) => key === 'then' || Reflect.has(target, key),
      get: (target, key) =>
        key === 'then' ? completion.then.bind(completion) : Reflect.get(target, key)
    })
    expect(() => bridge.transaction(() => thenable)).toThrow(
      expect.objectContaining(error('invalid'))
    )
    const fn = () => 42
    expect(bridge.transaction(() => fn)).toBe(fn)
  } finally {
    bridge.close()
  }
})

it.each(['digest', 'request_id', 'targets', 'bytes', 'noncanonical', 'oversized'])(
  'refuses altered retained request binding (%s)',
  async field => {
    const f = await make(),
      body = request()
    const record = await f.store.retain(signed(body), requester, clock)
    let id = body.requestId
    if (field === 'digest') alter(f.path, 'UPDATE root_requests SET digest=?', 'ff'.repeat(32))
    if (field === 'request_id') {
      id = 'fixture_changed_retained'
      alter(f.path, 'UPDATE root_requests SET request_id=?', id)
    }
    if (field === 'targets') alter(f.path, 'UPDATE root_requests SET targets=2')
    if (field === 'bytes') alter(f.path, 'UPDATE root_requests SET bytes=bytes+1')
    if (field === 'noncanonical' || field === 'oversized') {
      const packet =
        (field === 'noncanonical' ? ' ' : ' '.repeat(1048576)) + canonicalOutputJSON(record.request)
      alter(f.path, 'UPDATE root_requests SET packet=?,bytes=?', packet, Buffer.byteLength(packet))
    }
    await expect(f.store.get(requester, id)).rejects.toMatchObject(error())
  }
)
it.each([
  'invalid-status',
  'missing-decision',
  'missing-affected',
  'rejected-decision',
  'rejected-affected'
])('refuses damaged terminal action attribution (%s)', async field => {
  const f = await make()
  await apply(f.store)
  if (field === 'invalid-status') alter(f.path, "UPDATE root_actions SET action_status='other'")
  if (field === 'missing-decision') alter(f.path, 'UPDATE root_actions SET decision=NULL')
  if (field === 'missing-affected') alter(f.path, 'UPDATE root_actions SET affected=NULL')
  if (field === 'rejected-decision')
    alter(f.path, "UPDATE root_actions SET action_status='rejected',affected=NULL")
  if (field === 'rejected-affected')
    alter(f.path, "UPDATE root_actions SET action_status='rejected',decision=NULL")
  await expect(f.store.result(requester, request().requestId, '150')).rejects.toMatchObject(error())
})
it('expires an old-policy pending request during recovery without evaluating under a new policy', async () => {
  const f = await make()
  await f.store.retain(signed(), requester, clock)
  alter(f.path, 'UPDATE root_meta SET policy=?', '66'.repeat(32))
  const result = await f.store.result(requester, request().requestId, '150')
  expect(result.outcomes[0]).toMatchObject({
    actionStatus: 'rejected',
    reasonCode: 'policy-changed',
    revision: '1'
  })
  expect(await f.store.projections(1)).toEqual([])
})
it.each(['eligible', 'ready'])(
  'rejects damaged serving %s flags before exposing a row',
  async field => {
    const f = await make()
    await apply(f.store)
    alter(
      f.path,
      field === 'eligible' ? 'UPDATE root_views SET eligible=2' : 'UPDATE root_views SET ready=2'
    )
    await expect(f.store.serving(selected())).rejects.toMatchObject(error())
  }
)
it.each(['membership', 'missing', 'revision'])(
  'requires the exact durable projection intent before acknowledging (%s)',
  async field => {
    const f = await make()
    await apply(f.store)
    const [intent] = await f.store.projections(1)
    if (field === 'membership') alter(f.path, "UPDATE root_projections SET membership='include'")
    if (field === 'missing') alter(f.path, 'DELETE FROM root_projections')
    if (field === 'revision')
      alter(f.path, "UPDATE root_projections SET revision='0000000000000000'")
    await expect(f.store.projected(intent)).rejects.toMatchObject(error())
    expect((await f.store.serving(selected())).state).toBe('suppressed')
  }
)
it('rejects changed projection membership and malformed persisted membership without consuming revision', async () => {
  const f = await make()
  await apply(f.store)
  const [intent] = await f.store.projections(1)
  await expect(f.store.projected({ ...intent, membership: 'include' })).rejects.toMatchObject(
    error('conflict')
  )
  await expect(
    f.store.projected({ ...intent, membership: 'other' as 'include' })
  ).rejects.toMatchObject(error('invalid'))
  alter(f.path, "UPDATE root_projections SET membership='other'")
  await expect(f.store.projections(1)).rejects.toMatchObject(error())
  expect((await f.store.head()).revision).toBe('1')
})
it.each([0, -1, 1.5, 1025, NaN, Infinity])('bounds projection paging (%s)', async maximum => {
  const f = await make()
  await expect(f.store.projections(maximum)).rejects.toMatchObject(error('invalid'))
})
it('accepts the inclusive maximum projection page size', async () => {
  const f = await make()
  await apply(f.store)
  expect(await f.store.projections(1024)).toHaveLength(1)
})

it.each([
  'bytes-negative',
  'bytes-wrong',
  'targets-wrong',
  'action-negative',
  'action-outside',
  'orphan',
  'view-capacity',
  'assessment-capacity',
  'blocker-capacity'
])('rejects an inconsistent recovered inventory (%s)', async fault => {
  const f = await make({ capacity: { requests: 1, targets: 1, assessments: 1, blockers: 1 } })
  await apply(f.store)
  if (fault === 'bytes-negative') alter(f.path, 'UPDATE root_requests SET bytes=-1')
  if (fault === 'bytes-wrong') alter(f.path, 'UPDATE root_requests SET bytes=bytes-1')
  if (fault === 'targets-wrong') alter(f.path, 'UPDATE root_requests SET targets=65')
  if (fault === 'action-negative') alter(f.path, 'UPDATE root_actions SET target_index=-1')
  if (fault === 'action-outside') alter(f.path, 'UPDATE root_actions SET target_index=1')
  if (fault === 'orphan') alter(f.path, 'UPDATE root_bases SET request_digest=?', 'ff'.repeat(32))
  if (fault === 'view-capacity')
    alter(
      f.path,
      "INSERT INTO root_views SELECT target_key||'x',target,revision,projection_revision,eligible,ready FROM root_views"
    )
  if (fault === 'assessment-capacity') {
    alter(
      f.path,
      "INSERT INTO root_assessments VALUES ('fixture_one','{}',?,'0000000000000001')",
      policy
    )
    alter(
      f.path,
      "INSERT INTO root_assessments VALUES ('fixture_two','{}',?,'0000000000000001')",
      policy
    )
  }
  if (fault === 'blocker-capacity')
    alter(
      f.path,
      'INSERT INTO root_bases SELECT ?,target_key,advertisement_digest,requester,request_digest,policy,revision,lifted_by FROM root_bases',
      'ff'.repeat(32)
    )
  expect(() => f.reopen()).toThrow(expect.objectContaining(error()))
})
it('accepts exact retained request byte/target/count and serving/assessment limits on reopening', async () => {
  const packet = signed(),
    bytes = Buffer.byteLength(canonicalOutputJSON(packet))
  const f = await make({
    capacity: { requests: 1, requestBytes: bytes, targets: 1, assessments: 1, blockers: 1 }
  })
  const retained = await f.store.retain(packet, requester, clock)
  await f.store.assess({
    operationId: 'fixture_assessment',
    expectedRevision: '0',
    target: selected(),
    eligible: true,
    evidenceDigest: '77'.repeat(32),
    reasonCode: 'reviewed'
  })
  expect(await f.reopen().get(requester, packet.body.requestId)).toEqual(retained)
  const next = request('fixture_capacity_other')
  await expect(f.store.retain(signed(next), requester, clock)).rejects.toMatchObject(
    error('limited')
  )
})
it.each(['requests', 'bytes', 'targets'])(
  'rejects nonintegral driver inventory totals (%s)',
  async field => {
    const f = await make(),
      get = SQLiteRootEvictionDatabase.prototype.get
    jest.spyOn(SQLiteRootEvictionDatabase.prototype, 'get').mockImplementation(function (
      this: SQLiteRootEvictionDatabase,
      sql,
      ...values
    ) {
      const row = get.call(this, sql, ...values)
      return sql.startsWith('SELECT count(*) AS requests') ? { ...row, [field]: 0.5 } : row
    })
    expect(() => f.reopen()).toThrow(expect.objectContaining(error()))
  }
)
it.each([
  { pending: -1, projections: 0 },
  { pending: 0.5, projections: 0 },
  { pending: 0, projections: -1 },
  { pending: 0, projections: 0.5 }
])('rejects invalid completion accounting %#', async accounting => {
  const f = await make(),
    get = SQLiteRootEvictionDatabase.prototype.get
  jest.spyOn(SQLiteRootEvictionDatabase.prototype, 'get').mockImplementation(function (
    this: SQLiteRootEvictionDatabase,
    sql,
    ...values
  ) {
    return sql.includes('AS pending') ? accounting : get.call(this, sql, ...values)
  })
  await expect(f.store.head()).rejects.toMatchObject(error())
})
