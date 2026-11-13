import { afterEach, describe, expect, it } from '@jest/globals'
import { canonicalOutputJSON, PrivateKey, signOutputPacket } from '@bsv/sdk'
import { DatabaseSync } from 'node:sqlite'
import {
  fixture,
  apply,
  request,
  requester,
  policy,
  root,
  clock,
  signed,
  selected,
  restore
} from './root-eviction-fixture.js'
import type { RootEvictionAssessment } from '../src/root-eviction/RootEvictionStorage.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
const assessment = (): RootEvictionAssessment => ({
  operationId: 'fixture_assess_one',
  expectedRevision: '0',
  target: selected(),
  eligible: true,
  evidenceDigest: '77'.repeat(32),
  reasonCode: 'verified-current-context'
})

describe('root journal bounds and independent decisions', () => {
  it('installs fresh advertisements and preserves a retained assessment across retries and restarts', async () => {
    const f = await make()
    expect(await f.store.assess(assessment())).toBe('1')
    const intents = await f.store.projections(1)
    expect((await f.store.serving(selected())).state).toBe('unresolved')
    await f.store.close()
    const store = f.reopen()
    expect(await store.assess(assessment())).toBe('1')
    expect(await store.projections(1)).toEqual(intents)
    expect(await store.projected(intents[0])).toBe(true)
    expect(await store.serving(selected())).toEqual({
      state: 'eligible',
      revision: '2',
      blockers: []
    })
    await expect(store.assess({ ...assessment(), eligible: false })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/\S/)
    })
    const denied = {
      ...assessment(),
      operationId: 'fixture_reorg_one',
      expectedRevision: '2',
      eligible: false
    }
    expect(await store.assess(denied)).toBe('3')
    expect((await store.projections(1))[0].membership).toBe('withdraw')
    expect((await store.serving(selected())).state).toBe('unresolved')
  })

  it('reassessment cannot bypass suppression and new outpoints remain independent', async () => {
    const { store } = await make()
    const suppressed = await apply(store)
    const next = { ...assessment(), expectedRevision: '1' }
    await store.assess(next)
    await store.projected((await store.projections(1))[0])
    expect((await store.serving(selected())).blockers).toEqual(
      suppressed.outcomes[0].serving.blockers
    )
    const newTarget = selected()
    newTarget.outpoint.outputIndex = 1
    await store.assess({
      ...next,
      operationId: 'fixture_new_outpoint',
      target: newTarget,
      expectedRevision: (await store.head()).revision
    })
    const [intent] = await store.projections(1)
    expect(intent.target).toEqual(newTarget)
    await store.projected(intent)
    expect((await store.serving(newTarget)).state).toBe('eligible')
    expect((await store.serving(selected())).state).toBe('suppressed')
  })

  it('clears old eligibility on policy rotation and requires a fresh coherent projection', async () => {
    const { store } = await make()
    await store.assess(assessment())
    await store.projected((await store.projections(1))[0])
    expect((await store.serving(selected())).state).toBe('eligible')
    const head = await store.changePolicy('66'.repeat(32))
    expect(await store.serving(selected())).toEqual({
      state: 'unresolved',
      revision: head.revision,
      blockers: []
    })
    expect((await store.projections(1))[0].membership).toBe('withdraw')
    await store.assess({
      ...assessment(),
      operationId: 'fixture_new_policy_assessment',
      expectedRevision: head.revision
    })
    expect((await store.projections(1))[0].membership).toBe('include')
    expect((await store.serving(selected())).state).toBe('unresolved')
  })

  it('keeps exact basis attribution available to the trusted restoration policy', async () => {
    const { store } = await make()
    const first = await apply(store)
    const decisionId = first.outcomes[0].decisionId!
    expect(await store.basis('ff'.repeat(32))).toBeUndefined()
    expect(await store.basis(decisionId)).toEqual({
      decisionId,
      target: selected(),
      requester,
      requestDigest: first.requestDigest,
      policyDigest: policy,
      revision: '1',
      liftedBy: null
    })
    const lifted = await apply(store, restore('fixture_lift_basis', decisionId))
    expect((await store.basis(decisionId))?.liftedBy).toBe(lifted.outcomes[0].decisionId)
  })

  it('permits legitimate divergent root policy without implying different Bitcoin consensus', async () => {
    const rootB = new PrivateKey(84).toPublicKey().toString()
    const a = await make(),
      b = await make({ root: rootB })
    const first = await apply(a.store)
    const second = await apply(b.store, { ...request(), recipient: rootB }, 'reject')
    expect(first.outcomes[0].serving.state).toBe('suppressed')
    expect(second.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      serving: { state: 'unresolved', blockers: [] }
    })
    expect(await b.store.basis(first.outcomes[0].decisionId!)).toBeUndefined()
    expect(first.root).not.toBe(second.root)
  })

  it('supports partial batch completion at separate revisions and retains terminal outcomes at expiry', async () => {
    const { store } = await make()
    const body = request()
    body.targets = [0, 1, 2].map(outputIndex => ({
      ...body.targets[0],
      outpoint: { ...body.targets[0].outpoint, outputIndex },
      advertisement: { ...body.targets[0].advertisement, outputIndex }
    }))
    const record = await store.retain(signed(body), requester, clock)
    const base = { requestDigest: record.digest, expectedRevision: '0', now: '150' }
    await store.evaluate({
      ...base,
      targets: [
        { index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true },
        { index: 1, disposition: 'reject', reasonCode: 'policy-denied', eligible: false }
      ]
    })
    const partial = await store.result(requester, body.requestId, '150')
    expect(partial.outcomes.map(value => [value.actionStatus, value.revision])).toEqual([
      ['applied', '1'],
      ['rejected', '1'],
      ['pending', '0']
    ])
    const expired = await store.result(requester, body.requestId, '200')
    expect(expired.outcomes.slice(0, 2)).toEqual(partial.outcomes.slice(0, 2))
    expect(expired.outcomes[2]).toMatchObject({
      actionStatus: 'rejected',
      reasonCode: 'request-expired',
      revision: '2'
    })
  })

  it('authenticates retained keys and rejects changed recipients, signatures and new requests at expiry', async () => {
    const { store } = await make(),
      body = request()
    await store.retain(signed(body), requester, clock)
    await expect(store.retain(signed(body), root, clock)).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringMatching(/\S/)
    })
    const other = new PrivateKey(84).toPublicKey().toString()
    await expect(
      store.retain(signed({ ...body, recipient: other }), requester, clock)
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/\S/) })
    await expect(
      store.retain(
        signed({ ...request('fixture_other_recipient'), recipient: other }),
        requester,
        clock
      )
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/\S/) })
    await expect(
      store.retain(
        signOutputPacket(
          'root-eviction-request',
          request('fixture_bad_signer'),
          new PrivateKey(84)
        ),
        requester,
        clock
      )
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/\S/) })
    await expect(
      store.retain(signed(request('fixture_expired_new')), requester, { ...clock, now: '200' })
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/\S/) })
    expect(await store.get(requester, 'fixture_expired_new')).toBeUndefined()
    expect(await store.get(requester, body.requestId)).toBeDefined()
  })

  it('can report a rejected advertisement digest without hiding the actual outpoint suppression', async () => {
    const { store } = await make()
    const valid = await apply(store)
    const invalid = request('fixture_bad_advertisement')
    invalid.targets[0].advertisementDigest = '00'.repeat(32)
    const result = await apply(store, invalid, 'reject')
    expect(result.outcomes[0]).toMatchObject({
      actionStatus: 'rejected',
      serving: valid.outcomes[0].serving
    })
    await expect(store.serving(selected(invalid))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/\S/)
    })
  })

  it('reserves escaped maximum-length status and blocker bytes before accepting a request', async () => {
    const { store } = await make()
    const body = request()
    body.targets = Array.from({ length: 64 }, (_, outputIndex) => ({
      ...body.targets[0],
      outpoint: { ...body.targets[0].outpoint, outputIndex },
      advertisement: { ...body.targets[0].advertisement, outputIndex }
    }))
    expect(new TextEncoder().encode(canonicalOutputJSON(signed(body))).length).toBeLessThan(1048576)
    await expect(store.retain(signed(body), requester, clock)).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(await store.get(requester, body.requestId)).toBeUndefined()
    expect((await store.head()).revision).toBe('0')
    const bounded = await make({ capacity: { blockers: 32 } })
    expect(
      (await bounded.store.retain(signed(body), requester, clock)).request.body.targets
    ).toHaveLength(64)
  })

  it('retains request, target, assessment and active-basis bounds without consuming completion space', async () => {
    const f = await make({ capacity: { assessments: 1, targets: 1, blockers: 1 } })
    await f.store.assess(assessment())
    await expect(
      f.store.assess({
        ...assessment(),
        operationId: 'fixture_next_assessment',
        expectedRevision: '1'
      })
    ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
    const a = await apply(f.store)
    expect(a.outcomes[0].actionStatus).toBe('applied')
    const tiny = await make({ capacity: { requestBytes: 1 } })
    await expect(tiny.store.retain(signed(), requester, clock)).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(await tiny.store.projections(1)).toEqual([])
    const b = await make({ capacity: { blockers: 1 } })
    await apply(b.store)
    const second = request('fixture_blocker_capacity')
    const retained = await b.store.retain(signed(second), requester, clock)
    await expect(
      b.store.evaluate({
        requestDigest: retained.digest,
        expectedRevision: '1',
        now: '150',
        targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
      })
    ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
    expect((await b.store.head()).revision).toBe('1')
    expect((await b.store.result(requester, second.requestId, '200')).outcomes[0].reasonCode).toBe(
      'request-expired'
    )
  })
})

it('reserves the final U64 slots for pending outcomes and their projection acknowledgements', async () => {
  const f = await make(),
    maximum = 18446744073709551615n,
    initial = maximum - 2n
  const db = new DatabaseSync(f.path)
  db.prepare('UPDATE root_meta SET revision=?').run(initial.toString(16))
  db.close()
  const retained = await f.store.retain(signed(), requester, clock)
  await expect(
    f.store.retain(signed(request('fixture_unreserved_work')), requester, clock)
  ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
  expect(await f.store.get(requester, 'fixture_unreserved_work')).toBeUndefined()
  await expect(
    f.store.assess({ ...assessment(), expectedRevision: initial.toString() })
  ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
  expect((await f.store.head()).revision).toBe(initial.toString())
  expect(await f.store.projections(1)).toEqual([])
  await f.store.evaluate({
    requestDigest: retained.digest,
    expectedRevision: initial.toString(),
    now: '150',
    targets: [{ index: 0, disposition: 'accept', reasonCode: 'reviewed', eligible: true }]
  })
  const [intent] = await f.store.projections(1)
  expect(intent.revision).toBe((maximum - 1n).toString())
  expect(await f.store.projected(intent)).toBe(true)
  expect(await f.store.projected(intent)).toBe(true)
  expect((await f.store.head()).revision).toBe(maximum.toString())
  expect((await f.store.result(requester, request().requestId, '150')).outcomes[0]).toMatchObject({
    actionStatus: 'applied',
    revision: (maximum - 1n).toString(),
    serving: { state: 'suppressed', revision: maximum.toString() }
  })
  await expect(
    f.store.assess({ ...assessment(), expectedRevision: maximum.toString() })
  ).rejects.toMatchObject({ code: 'limited', message: expect.stringMatching(/\S/) })
})
