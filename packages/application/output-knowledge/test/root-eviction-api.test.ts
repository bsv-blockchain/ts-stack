import { afterEach, expect, it } from '@jest/globals'
import {
  apply,
  clock,
  fixture,
  policy,
  request,
  requester,
  restore,
  selected,
  signed
} from './root-eviction-fixture.js'
import type {
  RootEvictionAssessment,
  RootEvictionEvaluation
} from '../src/root-eviction/RootEvictionStorage.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function make(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup()
})
const error = (code = 'invalid') => ({ code, message: expect.stringMatching(/\S/) })
const assessed = (): RootEvictionAssessment => ({
  operationId: 'fixture_api_assessment',
  expectedRevision: '0',
  target: selected(),
  eligible: true,
  evidenceDigest: '77'.repeat(32),
  reasonCode: 'reviewed'
})
const target = () => ({
  index: 0,
  disposition: 'accept' as const,
  reasonCode: 'reviewed',
  eligible: true
})
const evaluation = (digest: string): RootEvictionEvaluation => ({
  requestDigest: digest,
  expectedRevision: '0',
  now: '150',
  targets: [target()]
})

it.each(['requests', 'targets'] as const)(
  'preserves the independent retained %s quota and exact retries at capacity',
  async limit => {
    const f = await make({ capacity: { [limit]: 1 } }),
      first = signed(),
      second = signed(request('fixture_capacity_next'))
    const retained = await f.store.retain(first, requester, clock)
    await expect(f.store.retain(second, requester, clock)).rejects.toMatchObject(error('limited'))
    expect(await f.store.get(requester, second.body.requestId)).toBeUndefined()
    expect(await f.store.retain(first, requester, clock)).toEqual(retained)
    expect((await f.store.head()).revision).toBe('0')
    expect(await f.reopen().get(requester, first.body.requestId)).toEqual(retained)
  }
)
it('binds serving and reassessment to the retained advertisement bytes', async () => {
  const f = await make()
  await f.store.assess(assessed())
  await f.store.projected((await f.store.projections(1))[0])
  const changed = { ...selected(), advertisementDigest: 'ff'.repeat(32) }
  await expect(f.store.serving(changed)).rejects.toMatchObject(error('conflict'))
  await expect(
    f.store.assess({
      ...assessed(),
      operationId: 'fixture_changed_advertisement',
      expectedRevision: '2',
      target: changed
    })
  ).rejects.toMatchObject(error('conflict'))
  expect(await f.store.serving(selected())).toEqual({
    state: 'eligible',
    revision: '2',
    blockers: []
  })
  expect((await f.store.head()).revision).toBe('2')
  expect(await f.store.projections(1)).toEqual([])
})

it.each(['extra', 'eligible', 'stale', 'chain'])(
  'rejects invalid or stale assessments before durable effects (%s)',
  async field => {
    const f = await make(),
      input = assessed()
    if (field === 'extra') Object.assign(input, { extra: true })
    if (field === 'eligible') Object.assign(input, { eligible: 1 })
    if (field === 'stale') input.expectedRevision = '1'
    if (field === 'chain')
      input.target.outpoint.chain = { ...input.target.outpoint.chain, network: 'other' }
    await expect(f.store.assess(input)).rejects.toMatchObject(
      error(field === 'stale' ? 'conflict' : 'invalid')
    )
    expect(await f.store.head()).toEqual({ revision: '0', policyDigest: policy })
    expect(await f.store.projections(1)).toEqual([])
  }
)
it('retains existing target capacity without permitting a second output or consuming a failed assessment key', async () => {
  const f = await make({ capacity: { targets: 1 } })
  await f.store.assess(assessed())
  const next = {
    ...assessed(),
    operationId: 'fixture_api_second',
    expectedRevision: '1',
    target: structuredClone(selected())
  }
  next.target.outpoint.outputIndex = 1
  await expect(f.store.assess(next)).rejects.toMatchObject(error('limited'))
  expect((await f.store.head()).revision).toBe('1')
  expect(await f.store.assess({ ...next, target: selected() })).toBe('2')
})
it.each([
  'extra',
  'empty',
  'too-many',
  'not-array',
  'target-extra',
  'fractional-index',
  'negative-index',
  'duplicate',
  'descending',
  'disposition',
  'eligible',
  'absent',
  'partly-absent',
  'stale'
])('refuses invalid evaluation selections atomically (%s)', async field => {
  const f = await make(),
    record = await f.store.retain(signed(), requester, clock),
    input = evaluation(record.digest)
  if (field === 'extra') Object.assign(input, { extra: true })
  if (field === 'empty') input.targets = []
  if (field === 'too-many')
    input.targets = Array.from({ length: 65 }, (_, index) => ({ ...target(), index }))
  if (field === 'not-array') Object.assign(input, { targets: { length: 1 } })
  if (field === 'target-extra') Object.assign(input.targets[0], { extra: true })
  if (field === 'fractional-index') input.targets[0].index = 0.5
  if (field === 'negative-index') input.targets[0].index = -1
  if (field === 'duplicate') input.targets = [target(), target()]
  if (field === 'descending') input.targets = [{ ...target(), index: 1 }, target()]
  if (field === 'disposition') Object.assign(input.targets[0], { disposition: 'other' })
  if (field === 'eligible') Object.assign(input.targets[0], { eligible: 0 })
  if (field === 'absent') input.targets[0].index = 1
  if (field === 'partly-absent') input.targets = [target(), { ...target(), index: 1 }]
  if (field === 'stale') input.expectedRevision = '1'
  await expect(f.store.evaluate(input)).rejects.toMatchObject(
    error(field === 'stale' ? 'conflict' : 'invalid')
  )
  expect((await f.store.head()).revision).toBe('0')
  expect(
    (await f.store.result(requester, request().requestId, '150')).outcomes[0].actionStatus
  ).toBe('pending')
  expect(await f.store.projections(1)).toEqual([])
})
it('evaluates the inclusive maximum batch and treats repeated terminal selections as immutable retries', async () => {
  const f = await make({ capacity: { blockers: 1 } }),
    body = request()
  body.targets = Array.from({ length: 64 }, (_, outputIndex) => ({
    ...structuredClone(body.targets[0]),
    outpoint: { ...body.targets[0].outpoint, outputIndex },
    advertisement: { ...body.targets[0].advertisement, outputIndex }
  }))
  const record = await f.store.retain(signed(body), requester, clock)
  const input = {
    ...evaluation(record.digest),
    targets: body.targets.map((_, index) => ({ ...target(), index }))
  }
  await f.store.evaluate(input)
  const result = await f.store.result(requester, body.requestId, '150')
  expect(result.outcomes).toHaveLength(64)
  expect(
    result.outcomes.every(outcome => outcome.actionStatus === 'applied' && outcome.revision === '1')
  ).toBe(true)
  await f.store.evaluate(input)
  expect(await f.store.result(requester, body.requestId, '150')).toEqual(result)
  expect((await f.store.head()).revision).toBe('1')
})
it('completes only the remaining targets when a batch retries an already terminal target', async () => {
  const f = await make(),
    body = request()
  body.targets.push({
    ...structuredClone(body.targets[0]),
    outpoint: { ...body.targets[0].outpoint, outputIndex: 1 },
    advertisement: { ...body.targets[0].advertisement, outputIndex: 1 }
  })
  const record = await f.store.retain(signed(body), requester, clock)
  await f.store.evaluate(evaluation(record.digest))
  const first = (await f.store.result(requester, body.requestId, '150')).outcomes[0]
  await f.store.evaluate({
    ...evaluation(record.digest),
    expectedRevision: '1',
    targets: [target(), { ...target(), index: 1 }]
  })
  const result = await f.store.result(requester, body.requestId, '150')
  expect(result.outcomes[0]).toEqual(first)
  expect(result.outcomes[1]).toMatchObject({ actionStatus: 'applied', revision: '2' })
})
it('returns distinct missing-request failures for evaluation and result recovery', async () => {
  const f = await make()
  await expect(f.store.evaluate(evaluation('ff'.repeat(32)))).rejects.toMatchObject(
    error('not-found')
  )
  await expect(f.store.result(requester, request().requestId, '150')).rejects.toMatchObject(
    error('not-found')
  )
})
it('requires restored advertisement bytes to match the named basis', async () => {
  const f = await make(),
    first = await apply(f.store),
    body = restore('fixture_wrong_restore_ad', first.outcomes[0].decisionId!)
  body.targets[0].advertisementDigest = 'ff'.repeat(32)
  await expect(apply(f.store, body)).rejects.toMatchObject(error())
  expect((await f.store.head()).revision).toBe('1')
  expect((await f.store.serving(selected())).blockers).toEqual(first.outcomes[0].serving.blockers)
})
it('does not invalidate a ready view when installing the already current policy', async () => {
  const f = await make()
  await f.store.assess(assessed())
  await f.store.projected((await f.store.projections(1))[0])
  const before = await f.store.serving(selected())
  await f.store.changePolicy(policy)
  expect(await f.store.serving(selected())).toEqual(before)
  expect(await f.store.projections(1)).toEqual([])
})
it('requires every returned advertisement to remain eligible at the final gate', async () => {
  const f = await make()
  await f.store.assess(assessed())
  await f.store.projected((await f.store.projections(1))[0])
  const second = structuredClone(selected())
  second.outpoint.outputIndex = 1
  let queued = false
  await expect(
    f.store.enqueue(
      { revision: '2', targets: [selected(), second], bytes: new Uint8Array([1]) },
      () => true,
      () => {
        queued = true
      }
    )
  ).rejects.toMatchObject(error('reset-required'))
  expect(queued).toBe(false)
})
it.each(['targets', 'many-targets', 'bytes', 'many-bytes'])(
  'rejects malformed or oversized final candidates (%s)',
  async field => {
    const f = await make(),
      candidate = { revision: '0', targets: [], bytes: new Uint8Array() }
    if (field === 'targets') Object.assign(candidate, { targets: { length: 0 } })
    if (field === 'many-targets')
      Object.assign(candidate, { targets: Array.from({ length: 1025 }, () => selected()) })
    if (field === 'bytes') Object.assign(candidate, { bytes: [] })
    if (field === 'many-bytes') candidate.bytes = new Uint8Array(4194305)
    let queued = false
    await expect(
      f.store.enqueue(
        candidate,
        () => true,
        () => {
          queued = true
        }
      )
    ).rejects.toMatchObject(error())
    expect(queued).toBe(false)
  }
)
it('accepts inclusive final queue limits and empty-target control responses', async () => {
  const f = await make()
  await f.store.assess(assessed())
  await f.store.projected((await f.store.projections(1))[0])
  const bytes = new Uint8Array(4194304)
  bytes[bytes.length - 1] = 17
  let queued = 0
  await f.store.enqueue(
    { revision: '2', targets: Array.from({ length: 1024 }, () => selected()), bytes },
    () => true,
    owned => {
      expect(owned).not.toBe(bytes)
      expect(owned.byteLength).toBe(4194304)
      expect(owned[4194303]).toBe(17)
      queued++
    }
  )
  await f.store.enqueue(
    { revision: '2', targets: [], bytes: new Uint8Array() },
    () => true,
    () => {
      queued++
    }
  )
  expect(queued).toBe(2)
})
it('rejects an async authorization function before it executes and refuses deferred enqueue results', async () => {
  const f = await make(),
    candidate = { revision: '0', targets: [], bytes: new Uint8Array() }
  let authorized = false,
    queued = false
  const authorize = async () => {
    authorized = true
    return true
  }
  await expect(
    f.store.enqueue(candidate, authorize as unknown as () => boolean, () => {
      queued = true
    })
  ).rejects.toMatchObject(error())
  expect(authorized).toBe(false)
  expect(queued).toBe(false)
  await expect(
    f.store.enqueue(candidate, () => true, (() => Promise.resolve()) as unknown as () => undefined)
  ).rejects.toMatchObject(error())
})
