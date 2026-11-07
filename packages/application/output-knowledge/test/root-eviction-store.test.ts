import { afterEach, describe, expect, it } from '@jest/globals'
import { signOutputPacket, verifyOutputRootEvictionResult } from '@bsv/sdk'
import { DatabaseSync } from 'node:sqlite'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'
import {
  apply,
  clock,
  fixture,
  policy,
  request,
  requester,
  restore,
  rootKey,
  selected,
  signed
} from './root-eviction-fixture.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})

describe('durable root decisions and serving fences', () => {
  it('recovers immutable decisions after restart and admits a signed result bound to the original request', async () => {
    const f = await make(),
      body = request()
    const retained = await f.store.retain(signed(body), requester, clock)
    expect(await f.store.head()).toEqual({ revision: '0', policyDigest: policy })
    expect((await f.store.result(requester, body.requestId, '150')).outcomes[0]).toMatchObject({
      actionStatus: 'pending',
      revision: '0',
      serving: { state: 'unresolved', revision: '0' }
    })
    const first = await apply(f.store, body)
    expect(first.outcomes[0]).toMatchObject({
      actionStatus: 'applied',
      revision: '1',
      serving: { state: 'suppressed', revision: '1' }
    })
    await f.store.close()
    const recovered = f.reopen()
    expect(await recovered.result(requester, body.requestId, '150')).toEqual(first)
    expect(await recovered.retain(signed(body), requester, { ...clock, now: '999' })).toEqual(
      retained
    )
    expect(
      verifyOutputRootEvictionResult(
        signOutputPacket('root-eviction-result', first, rootKey),
        retained.request,
        retained.policyDigest
      ).body
    ).toEqual(first)
  })

  it('lifts only the named basis and keeps the saved action while serving assessments evolve', async () => {
    const { store } = await make()
    const a = await apply(store, request('fixture_suppress_A'))
    const b = await apply(store, request('fixture_suppress_B'))
    const aid = a.outcomes[0].decisionId!,
      bid = b.outcomes[0].decisionId!
    const ra = restore('fixture_restore_A', aid)
    const restoredA = await apply(store, ra)
    expect(restoredA.outcomes[0]).toMatchObject({
      actionStatus: 'applied',
      affectedDecisionIds: [aid],
      serving: { state: 'suppressed', blockers: [{ decisionId: bid, policyDigest: policy }] }
    })
    const restoreB = await apply(store, restore('fixture_restore_B', bid))
    expect(restoreB.outcomes[0].serving.state).toBe('unresolved')
    const [intent] = await store.projections(1)
    expect(intent.membership).toBe('include')
    expect(await store.projected(intent)).toBe(true)
    const before = await store.head()
    expect(await store.projected(intent)).toBe(true)
    expect(await store.head()).toEqual(before)
    const replayA = await store.result(requester, ra.requestId, '155')
    expect(replayA.outcomes[0]).toMatchObject({
      ...restoredA.outcomes[0],
      serving: { state: 'eligible', blockers: [], revision: before.revision }
    })
    const noop = await apply(store, restore('fixture_restore_A_again', aid))
    expect(noop.outcomes[0]).toMatchObject({ actionStatus: 'no-op', affectedDecisionIds: [aid] })
    expect(noop.outcomes[0].decisionId).toBeUndefined()
    expect(await store.projections(10)).toEqual([])
  })

  it('does not let stale index acknowledgements clear a newer suppression', async () => {
    const { store } = await make()
    const a = await apply(store)
    await apply(store, restore('fixture_restore_one', a.outcomes[0].decisionId!))
    const [old] = await store.projections(1)
    const b = await apply(store, request('fixture_suppress_new'))
    expect(await store.projected(old)).toBe(false)
    expect(await store.serving(selected())).toEqual(b.outcomes[0].serving)
    const [current] = await store.projections(1)
    expect(current.membership).toBe('withdraw')
    expect(await store.projected(current)).toBe(true)
    expect((await store.serving(selected())).state).toBe('suppressed')
  })

  it('expires pending outcomes exactly at the deadline without rewriting applied outcomes', async () => {
    const { store } = await make()
    const body = request()
    await store.retain(signed(body), requester, clock)
    expect((await store.result(requester, body.requestId, '199')).outcomes[0].actionStatus).toBe(
      'pending'
    )
    const expired = await store.result(requester, body.requestId, '200')
    expect(expired.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'request-expired',
      revision: '1'
    })
    expect((await store.result(requester, body.requestId, '999')).outcomes).toEqual(
      expired.outcomes
    )
    expect(await store.projections(1)).toEqual([])
  })

  it('rejects pending work on policy rotation while preserving completed attribution and independent blockers', async () => {
    const { store } = await make()
    const first = await apply(store)
    const pending = request('fixture_pending_two')
    await store.retain(signed(pending), requester, clock)
    const changed = await store.changePolicy('66'.repeat(32))
    expect(changed).toEqual({ revision: '2', policyDigest: '66'.repeat(32) })
    expect(await store.changePolicy(changed.policyDigest)).toEqual(changed)
    expect((await store.result(requester, pending.requestId, '151')).outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'policy-changed',
      revision: '2'
    })
    expect((await store.result(requester, request().requestId, '151')).outcomes).toEqual([
      { ...first.outcomes[0], serving: { ...first.outcomes[0].serving, revision: '2' } }
    ])
  })

  it('rejects altered request semantics and preserves reservations for admitted requests at capacity', async () => {
    const { store } = await make({ capacity: { requests: 1, targets: 1, blockers: 1 } })
    const body = request()
    await store.retain(signed(body), requester, clock)
    await expect(
      store.retain(signed({ ...body, reason: 'changed' }), requester, clock)
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/\S/) })
    await expect(
      store.retain(signed(request('fixture_over_capacity')), requester, clock)
    ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
    expect((await apply(store, body)).outcomes[0].actionStatus).toBe('applied')
    expect(await store.projections(10)).toHaveLength(1)
  })

  it('rolls back all targets and the revision if a restoration names another output', async () => {
    const { store } = await make()
    const body = restore('fixture_invalid_restore', 'ff'.repeat(32))
    const record = await store.retain(signed(body), requester, clock)
    await expect(
      store.evaluate({
        requestDigest: record.digest,
        expectedRevision: '0',
        now: '150',
        targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
      })
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/\S/) })
    expect((await store.head()).revision).toBe('0')
    expect((await store.result(requester, body.requestId, '150')).outcomes[0].actionStatus).toBe(
      'pending'
    )
    expect(await store.projections(1)).toEqual([])
  })

  it('queues exact bytes only with current authorization, revision and completed eligible projection', async () => {
    const { store } = await make()
    const initial = await apply(store)
    await apply(store, restore('fixture_restore_queue', initial.outcomes[0].decisionId!))
    const before = await store.head(),
      sent: Uint8Array[] = []
    const bytes = new Uint8Array([1, 2, 3])
    const candidate = { revision: before.revision, targets: [selected()], bytes }
    await expect(
      store.enqueue(
        candidate,
        () => true,
        value => {
          sent.push(value)
        }
      )
    ).rejects.toMatchObject({ code: 'reset-required', message: expect.stringMatching(/\S/) })
    await store.projected((await store.projections(1))[0])
    await expect(
      store.enqueue(
        candidate,
        () => true,
        value => {
          sent.push(value)
        }
      )
    ).rejects.toMatchObject({ code: 'reset-required', message: expect.stringMatching(/\S/) })
    const live = { ...candidate, revision: (await store.head()).revision }
    await expect(
      store.enqueue(
        live,
        () => false,
        value => {
          sent.push(value)
        }
      )
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/\S/) })
    await store.enqueue(
      live,
      () => true,
      value => {
        sent.push(value)
      }
    )
    bytes[0] = 99
    expect(sent).toEqual([new Uint8Array([1, 2, 3])])
    await apply(store, request('fixture_new_block'))
    await expect(
      store.enqueue(
        live,
        () => true,
        value => {
          sent.push(value)
        }
      )
    ).rejects.toMatchObject({ code: 'reset-required', message: expect.stringMatching(/\S/) })
    expect(sent).toHaveLength(1)
  })

  it('requires explicit creation and sealed recovery; broken revision reservations fail closed', async () => {
    const f = await make()
    expect(() => SQLiteRootEvictionStore.create(f.path, f.configuration, policy)).toThrow()
    expect(() => SQLiteRootEvictionStore.open(f.path + '.missing', f.configuration)).toThrow()
    expect(() =>
      SQLiteRootEvictionStore.open(f.path, { ...f.configuration, capacity: { requests: 1 } })
    ).toThrow('configuration changed')
    const record = await f.store.retain(signed(), requester, clock)
    const db = new DatabaseSync(f.path)
    db.prepare('UPDATE root_meta SET revision=?').run('f'.repeat(16))
    db.close()
    await expect(
      f.store.evaluate({
        requestDigest: record.digest,
        expectedRevision: '18446744073709551615',
        now: '150',
        targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
      })
    ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
    await expect(f.store.result(requester, request().requestId, '150')).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    const inspection = new DatabaseSync(f.path)
    expect(inspection.prepare('SELECT count(*) AS n FROM root_actions').get()?.n).toBe(0)
    expect(inspection.prepare('SELECT count(*) AS n FROM root_projections').get()?.n).toBe(0)
    inspection.close()
  })
})

it('owns a Buffer control response before authorization reads caller state', async () => {
  const f = await make(),
    input = Buffer.from('fixture-owned-control'),
    expected = Array.from(input)
  let received: number[] | undefined
  await f.store.enqueue(
    { revision: '0', targets: [], bytes: input },
    () => {
      input.fill(0)
      return true
    },
    owned => {
      received = Array.from(owned)
      return undefined
    }
  )
  expect(received).toEqual(expected)
  expect(input.every(value => value === 0)).toBe(true)
})
