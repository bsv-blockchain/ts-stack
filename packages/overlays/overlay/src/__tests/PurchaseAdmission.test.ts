import { OverlayPurchaseAdmission } from '../PurchaseAdmission.js'
import { purchaseAdmissionFixture as fixture } from './PurchaseAdmissionFixture.js'
import { topic, scope, transaction } from './ProposalAdmissionFixture.js'
import { overlayAdmissionContextDigest } from '../EngineAdmission.js'
import { admissionSemanticDigest } from '../storage/AdmissionStorage.js'

test('recovers original selected-topic admission without resubmitting or disclosing other topics', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'committed', admission: f.original() })
  const first = await f.run()
  expect(first).toMatchObject({
    status: 'admitted',
    operationId: f.job.operationId,
    txid: f.job.candidate.txid,
    acceptedAt: '30',
    steak: { [topic]: { outputsToAdmit: [0] } }
  })
  if (first.status === 'admitted') expect(Object.keys(first.steak)).toEqual([topic])
  expect(JSON.stringify(first)).not.toMatch(/tm_private|potatoes|secret|requestDigest/)
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.read).toHaveBeenCalledWith({
    scope,
    txid: transaction.id('hex'),
    topic,
    policyId: 'overlay-engine-submit-v1',
    contextDigest: overlayAdmissionContextDigest()
  })
  expect(await f.run()).toEqual(first)
})

test('a lost Engine response recovers the original receipt; returned duplicate STEAK is ignored', async () => {
  const f = fixture()
  f.read
    .mockResolvedValueOnce({ state: 'unresolved' })
    .mockResolvedValueOnce({ state: 'committed', admission: f.original() })
  f.submit.mockRejectedValue(new Error('lost response after majority commit'))
  expect(await f.run()).toMatchObject({ status: 'admitted', acceptedAt: '30' })
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.submit).toHaveBeenCalledWith({ beef: transaction.toBEEF(), topics: [topic] })
  expect(f.submit.mock.calls[0]).toHaveLength(1)
})

test.each([false, true])(
  'without actual retained history submission stays unresolved (%s)',
  async failure => {
    const f = fixture()
    if (failure) f.submit.mockRejectedValue(new Error('unknown admission outcome'))
    else f.submit.mockResolvedValue({ [topic]: { outputsToAdmit: [], coinsToRetain: [] } })
    expect(await f.run()).toEqual({
      status: 'unresolved',
      operationId: f.job.operationId,
      txid: f.job.candidate.txid
    })
  }
)

test('database failure is not absence and cannot cause a new submission', async () => {
  const f = fixture()
  f.read.mockRejectedValue(new Error('retained history unavailable'))
  await expect(f.run()).rejects.toThrow('retained history unavailable')
  expect(f.submit).not.toHaveBeenCalled()
})

test('legacy history without original time cannot fulfill the stronger companion', async () => {
  const f = fixture()
  const original = f.original()
  delete (original as { acceptedAt?: unknown }).acceptedAt
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  await expect(f.run()).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.submit).not.toHaveBeenCalled()
})

test('a different topical projection cannot establish the required admitted successor', async () => {
  const f = fixture()
  const original = f.original()
  original.receipt.steak = JSON.stringify({ [topic]: { outputsToAdmit: [], coinsToRetain: [] } })
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  await expect(f.run()).rejects.toMatchObject({ code: 'invalid' })
  expect(f.submit).not.toHaveBeenCalled()
})

test('original-context checks prevent scheduling effects after an awaited authority change', async () => {
  const f = fixture()
  let authorized = true
  f.context.checkCurrent.mockImplementation(() => {
    if (!authorized) throw new Error('intent revoked')
  })
  f.read.mockImplementation(async () => {
    authorized = false
    return { state: 'unresolved' }
  })
  await expect(f.run()).rejects.toThrow('intent revoked')
  expect(f.submit).not.toHaveBeenCalled()
})

test('installed manager, storage, history and submit identities are pinned', async () => {
  const f = fixture()
  f.engine.submit = jest.fn(async () => ({}))
  await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.read).not.toHaveBeenCalled()
})

test('pre-aborted work never reads a candidate or calls a provider', async () => {
  const f = fixture(),
    stop = new AbortController()
  stop.abort()
  await expect(f.run(stop.signal)).rejects.toMatchObject({ code: 'cancelled' })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test.each(['acquisition', 'txid', 'beef', 'topic', 'capability'])(
  'refuses changed original association before Engine (%s)',
  async name => {
    const f = fixture()
    if (name === 'acquisition') f.job.candidate.acquisitionId = 'aa'.repeat(32)
    if (name === 'txid') f.job.candidate.txid = 'bb'.repeat(32)
    if (name === 'beef') f.job.candidate.beef = 'AA=='
    if (name === 'topic') f.job.original.request.topic = 'other'
    if (name === 'capability')
      (f.job.original.capability as { digest: string }).digest = 'cc'.repeat(32)
    await expect(f.run()).rejects.toThrow()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test('bounds complete candidate and possible STEAK before scheduling external work', async () => {
  for (const options of [{ maximumRequestBytes: 128 }, { maximumOutcomeBytes: 128 }]) {
    const f = fixture(options)
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
  const f = fixture()
  expect(
    () => new OverlayPurchaseAdmission({ ...f.installation, maximumOutcomeBytes: 127 })
  ).toThrow()
  expect(
    () => new OverlayPurchaseAdmission({ ...f.installation, admittedOutputIndex: -1 })
  ).toThrow()
})

test('retained provenance and original timestamp remain independently checked', async () => {
  const f = fixture()
  const original = f.original()
  original.identity.contextDigest = 'aa'.repeat(32)
  original.receipt.semanticDigest = admissionSemanticDigest(original.identity)
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  await expect(f.run()).rejects.toMatchObject({ code: 'invalid' })
  expect(f.submit).not.toHaveBeenCalled()
})

test('an asynchronous local guard is refused and a returned rejected promise is drained', async () => {
  const f = fixture()
  await expect(
    f.bridge.recover(f.job, new AbortController().signal, { checkCurrent: async () => {} })
  ).rejects.toMatchObject({ code: 'invalid' })
  f.context.checkCurrent.mockImplementation((() =>
    Promise.reject(new Error('async guard'))) as never)
  await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
  expect(f.read).not.toHaveBeenCalled()
})
