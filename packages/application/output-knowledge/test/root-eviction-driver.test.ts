import { afterEach, expect, it, jest } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import {
  fixture,
  policy,
  selected,
  clock,
  request,
  requester,
  signed
} from './root-eviction-fixture.js'
import { SQLiteRootEvictionDatabase } from '../src/root-eviction/SQLiteRootEvictionDatabase.js'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function make() {
  const f = await fixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const f of fixtures.splice(0)) await f.cleanup()
})

it('rolls back incomplete initialization and closes its connection when the driver fails', async () => {
  const f = await make(),
    failed = f.path + '.incomplete'
  const prepare = DatabaseSync.prototype.prepare
  const close = jest.spyOn(DatabaseSync.prototype, 'close')
  const failure = new Error('synthetic storage write failure')
  jest.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    if (sql === 'INSERT INTO root_meta VALUES (1,?,?,?)') throw failure
    return prepare.call(this, sql)
  })
  expect(() => SQLiteRootEvictionStore.create(failed, f.configuration, policy)).toThrow(failure)
  expect(close).toHaveBeenCalledTimes(1)
  jest.restoreAllMocks()
  const inspection = new DatabaseSync(failed)
  expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
  inspection.close()
  expect(() => SQLiteRootEvictionStore.open(failed, f.configuration)).toThrow()
})

it('preserves an unexpected driver error rather than misclassifying it as a retryable lock', async () => {
  const { store } = await make(),
    failure = new Error('synthetic journal I/O failure')
  jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
    throw failure
  })
  await expect(store.head()).rejects.toBe(failure)
  jest.restoreAllMocks()
  expect((await store.head()).revision).toBe('0')
})

it('quarantines an uncertain connection and recovers the committed decision without another effect', async () => {
  const f = await make(),
    body = request()
  const retained = await f.store.retain(signed(body), requester, clock)
  const exec = DatabaseSync.prototype.exec,
    failure = new Error('synthetic acknowledgement loss after commit')
  jest.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql: string
  ) {
    exec.call(this, sql)
    if (sql === 'COMMIT') throw failure
  })
  await expect(
    f.store.evaluate({
      requestDigest: retained.digest,
      expectedRevision: '0',
      now: '150',
      targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
    })
  ).rejects.toBe(failure)
  jest.restoreAllMocks()
  await expect(f.store.head()).rejects.toMatchObject({
    code: 'unavailable',
    message: expect.stringMatching(/\S/)
  })
  const reopened = f.reopen()
  expect((await reopened.result(requester, body.requestId, '150')).outcomes[0]).toMatchObject({
    actionStatus: 'applied',
    revision: '1',
    serving: { state: 'suppressed' }
  })
  expect(await reopened.retain(signed(body), requester, clock)).toEqual(retained)
  expect((await reopened.head()).revision).toBe('1')
  expect(await reopened.projections(1)).toHaveLength(1)
})

it('rejects asynchronous, reentrant and closed use of the transaction bridge before releasing its gate', async () => {
  const f = await make(),
    bridge = new SQLiteRootEvictionDatabase(f.path, f.configuration, undefined)
  try {
    let invoked = false
    expect(() =>
      bridge.transaction(async () => {
        invoked = true
        return true
      })
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Root journal callbacks must be synchronous'
      })
    )
    expect(invoked).toBe(false)
    expect(() => bridge.transaction(() => Promise.resolve(true))).toThrow('asynchronous')
    expect(() => bridge.transaction(() => bridge.transaction(() => true))).toThrow('reentered')
    expect(() => bridge.transaction(() => bridge.close())).toThrow('Cannot close')
    expect(() => bridge.get('SELECT 1')).toThrow('requires its transaction')
    expect(() => bridge.transaction(() => bridge.get(' '))).toThrow('SQL is empty')
    expect(bridge.transaction(() => bridge.head())).toEqual({ revision: '0', policyDigest: policy })
  } finally {
    bridge.close()
  }
  bridge.close()
  expect(() => bridge.transaction(() => true)).toThrow('closed')
})

it('rejects an async send adapter before invoking it and closes the public port idempotently', async () => {
  const { store } = await make()
  await store.assess({
    operationId: 'fixture_async_gate',
    expectedRevision: '0',
    target: selected(),
    eligible: true,
    evidenceDigest: '77'.repeat(32),
    reasonCode: 'current'
  })
  await store.projected((await store.projections(1))[0])
  const candidate = {
    revision: (await store.head()).revision,
    targets: [selected()],
    bytes: new Uint8Array([1])
  }
  let called = false
  const asynchronous = async () => {
    called = true
  }
  await expect(
    store.enqueue(candidate, () => true, asynchronous as unknown as () => undefined)
  ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/\S/) })
  expect(called).toBe(false)
  await store.close()
  await store.close()
  await expect(store.head()).rejects.toMatchObject({
    code: 'unavailable',
    message: expect.stringMatching(/\S/)
  })
})

it.each(['decision', 'affected', 'no-op', 'initial-revision', 'future-revision'])(
  'does not return altered saved action attribution (%s)',
  async field => {
    const f = await make(),
      body = request()
    const retained = await f.store.retain(signed(body), requester, clock)
    await f.store.evaluate({
      requestDigest: retained.digest,
      expectedRevision: '0',
      now: '150',
      targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
    })
    const { outputRootEvictionDecisionId } = await import('@bsv/sdk')
    const revision = field === 'initial-revision' ? '0' : field === 'future-revision' ? '2' : '1'
    const correct = outputRootEvictionDecisionId({
      root: f.configuration.root,
      requestDigest: retained.digest,
      service: body.targets[0].service,
      outpoint: body.targets[0].outpoint,
      revision
    })
    const db = new DatabaseSync(f.path)
    db.prepare('UPDATE root_actions SET decision=?,affected=?,action_status=?,revision=?').run(
      field === 'no-op' ? null : field === 'decision' ? 'ff'.repeat(32) : correct,
      field === 'affected' ? 'ff'.repeat(32) : correct,
      field === 'no-op' ? 'no-op' : 'applied',
      BigInt(revision).toString(16).padStart(16, '0')
    )
    db.close()
    await expect(f.store.result(requester, body.requestId, '150')).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/\S/)
    })
  }
)
