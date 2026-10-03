import { OverlayPurchaseAdmission } from '../PurchaseAdmission.js'
import { purchaseAdmissionFixture as fixture } from './PurchaseAdmissionFixture.js'
import { topic, scope, transaction } from './ProposalAdmissionFixture.js'
import { overlayAdmissionContextDigest } from '../EngineAdmission.js'
import { admissionSemanticDigest } from '../storage/AdmissionStorage.js'
import {
  Beef,
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputPacketDigest,
  retainOutputCapability,
  signOutputPacket,
  Utils,
  type OutputCapabilities,
  type OutputRetainedCapability
} from '@bsv/sdk'
import { key, identity, chain, rules } from './ProposalAdmissionFixture.js'

function resignTerms(f: ReturnType<typeof fixture>) {
  const request = f.job.original.request,
    acquisitionId = outputPacketDigest('purchase', {
      chain: request.listing.chain,
      seller: identity,
      recipient: request.recipient,
      topic: request.topic,
      requestId: request.requestId
    })
  f.job.original.terms = signOutputPacket(
    'purchase-terms',
    {
      ...f.job.original.terms.body,
      acquisitionId,
      requestDigest: outputPacketDigest('purchase-request', request),
      topic: request.topic,
      listing: request.listing
    },
    key
  )
  f.job.candidate.acquisitionId = acquisitionId
}

function replaceCapability(
  f: ReturnType<typeof fixture>,
  change: (body: OutputCapabilities) => void
) {
  const body = structuredClone(
    (f.job.original.capability as OutputRetainedCapability).manifest.body
  )
  change(body)
  f.job.original.capability = retainOutputCapability(signOutputPacket('capabilities', body, key), {
    baseURL: f.installation.baseURL,
    identity,
    chain,
    service: topic,
    kind: 'topic',
    profile: OUTPUT_PROFILES.purchase,
    now: '20',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  }).record
}

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

test.each([
  ['domainProfile', 'prefix urn:test:purchase', 'Purchase domain profile requires an absolute IRI'],
  ['domainProfile', '1urn:test:purchase', 'Purchase domain profile requires an absolute IRI'],
  ['admittedOutputIndex', 4294967296, 'Invalid purchase admission output index'],
  ['admittedOutputIndex', 0.5, 'Invalid purchase admission output index'],
  ['admittedOutputIndex', Number.NaN, 'Invalid purchase admission output index'],
  ['maximumRequestBytes', 0, 'Invalid purchase admission request allowance'],
  ['maximumRequestBytes', -1, 'Invalid purchase admission request allowance'],
  ['maximumRequestBytes', 0.5, 'Invalid purchase admission request allowance'],
  ['maximumRequestBytes', Number.NaN, 'Invalid purchase admission request allowance'],
  ['maximumRequestBytes', Number.POSITIVE_INFINITY, 'Invalid purchase admission request allowance'],
  ['maximumRequestBytes', 4194305, 'Invalid purchase admission request allowance'],
  ['maximumOutcomeBytes', 131073, 'Invalid purchase admission outcome allowance']
])('rejects the malformed installed %s boundary (%p)', (field, value, message) => {
  const f = fixture()
  expect(() => new OverlayPurchaseAdmission({ ...f.installation, [field]: value })).toThrow(
    expect.objectContaining({ code: 'invalid', message })
  )
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test.each([
  { admittedOutputIndex: 4294967295 },
  { maximumRequestBytes: 1 },
  { maximumRequestBytes: 4194304 },
  { maximumOutcomeBytes: 128 },
  { maximumOutcomeBytes: 131072 }
])('accepts the exact installed numeric boundary without scheduling a purchase (%p)', options => {
  const f = fixture()
  expect(() => new OverlayPurchaseAdmission({ ...f.installation, ...options })).not.toThrow()
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test.each([null, {}])(
  'refuses a missing synchronous request context before any read (%p)',
  async context => {
    const f = fixture()
    await expect(
      f.bridge.recover(f.job, new AbortController().signal, context as never)
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'Purchase admission needs a synchronous original-context guard'
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test('observes a rejected context promise before refusing asynchronous authority', async () => {
  const f = fixture(),
    result = Promise.reject(new Error('Deferred original purchase authority')),
    observed = jest.spyOn(result, 'catch')
  f.context.checkCurrent.mockImplementation((() => result) as never)
  await expect(f.run()).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Purchase admission context changed'
  })
  expect(observed).toHaveBeenCalledTimes(1)
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test('pins the original synchronous context across the awaited history read', async () => {
  const f = fixture()
  f.read.mockImplementation(async () => {
    f.context.checkCurrent = jest.fn()
    return { state: 'unresolved' }
  })
  await expect(f.run()).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Purchase admission context guard changed'
  })
  expect(f.submit).not.toHaveBeenCalled()
})

test.each(['storage', 'manager', 'history-reader', 'scope', 'admission'])(
  'rejects a replaced installed %s before touching original history',
  async boundary => {
    const f = fixture(),
      storage = f.engine.storage as unknown as {
        admissionScope: typeof scope
        admission: { history: { read: typeof f.read } }
      }
    if (boundary === 'storage') f.engine.storage = { ...f.engine.storage }
    if (boundary === 'manager') f.engine.managers[topic] = { ...f.engine.managers[topic] }
    if (boundary === 'history-reader') storage.admission.history.read = jest.fn(f.read)
    if (boundary === 'scope') storage.admissionScope.nodeId = 'different-original-host'
    if (boundary === 'admission') storage.admission = { ...storage.admission }
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Purchase admission installation changed'
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test('rejects an unknown retained history result before a second provider effect', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'another-state' } as never)
  await expect(f.run()).rejects.toMatchObject({
    code: 'invalid',
    message: 'Invalid purchase admission history result'
  })
  expect(f.submit).not.toHaveBeenCalled()
})

test.each(['host', 'history', 'topic'])(
  'requires the actual installed %s declaration when constructing admission',
  missing => {
    const f = fixture(),
      storage = f.engine.storage as unknown as { admission: object }
    if (missing === 'host') Reflect.deleteProperty(storage, 'admissionScope')
    if (missing === 'history') Reflect.deleteProperty(storage.admission, 'history')
    if (missing === 'topic') delete f.engine.managers[topic]
    expect(() => new OverlayPurchaseAdmission(f.installation)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message:
          missing === 'topic'
            ? 'Purchase topic is not installed'
            : 'Original timed admission history is required'
      })
    )
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test.each(['topic', 'domain', 'chain'])(
  'independently rejects a validly signed preparation with another installed %s premise',
  async field => {
    const f = fixture()
    if (field === 'topic') f.job.original.request.topic = 'tm_another'
    if (field === 'domain') f.job.original.terms.body.domainProfile = 'urn:test:another-domain'
    if (field === 'chain')
      f.job.original.request.listing.chain = { ...chain, network: 'another-chain' }
    resignTerms(f)
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Purchase admission differs from the original prepared transaction'
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test.each(['domains', 'policies'])(
  'requires the original selected %s alongside independently signed terms',
  async field => {
    const f = fixture()
    replaceCapability(f, body => {
      const parameters = body.services[0].profiles[0].parameters
      if (field === 'domains') parameters.domainProfiles = ['urn:test:another-domain']
      else parameters.releasePolicies = [{ kind: 'mined', confirmations: 1 }]
    })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Purchase domain or release policy is absent from the original capability'
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test('allows independently advertised policy alternatives rather than requiring them all to match', async () => {
  const f = fixture()
  replaceCapability(f, body => {
    body.services[0].profiles[0].parameters.releasePolicies = [
      { kind: 'mined', confirmations: 1 },
      { kind: 'local-admission' }
    ]
  })
  expect(await f.run()).toMatchObject({ status: 'unresolved' })
  expect(f.submit).toHaveBeenCalledTimes(1)
})

test('rejects another explicit atomic BEEF target before consulting retained history', async () => {
  const f = fixture(),
    beef = Beef.fromBinary(transaction.toBEEF()),
    parent = transaction.inputs[0].sourceTransaction!
  f.job.candidate.beef = Utils.toBase64(beef.toBinaryAtomic(parent.id('hex')))
  await expect(f.run()).rejects.toMatchObject({
    code: 'invalid',
    message: 'Purchase BEEF target differs'
  })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test('retains optional local original-owner metadata without extending its wire shape', async () => {
  const f = fixture()
  Object.assign(f.job.original, { format: 'retained-original/1', createdAt: '20' })
  expect(await f.run()).toMatchObject({ status: 'unresolved' })
  expect(f.submit).toHaveBeenCalledTimes(1)
})

test('checks the exact maximum complete topical receipt capacity before any provider work', async () => {
  const original = fixture(),
    allowance = canonicalOutputJSON({
      status: 'admitted',
      operationId: original.job.operationId,
      txid: original.job.candidate.txid,
      acceptedAt: '18446744073709551615',
      assessmentContextId: 'overlay-topic-admission-v1:' + 'f'.repeat(64),
      steak: {
        [topic]: {
          outputsToAdmit: [0],
          coinsToRetain: [0],
          coinsRemoved: [0]
        }
      }
    }),
    exact = fixture({ maximumOutcomeBytes: allowance.length }),
    short = fixture({ maximumOutcomeBytes: allowance.length - 1 })
  expect(await exact.run()).toMatchObject({ status: 'unresolved' })
  expect(exact.submit).toHaveBeenCalledTimes(1)
  await expect(short.run()).rejects.toMatchObject({
    code: 'limited',
    message: 'Output JSON byte limit'
  })
  expect(short.read).not.toHaveBeenCalled()
  expect(short.submit).not.toHaveBeenCalled()
})

test('refuses the otherwise valid retained capability of a different installed rules digest', async () => {
  const f = fixture({ rulesDigest: 'aa'.repeat(32) })
  await expect(f.run()).rejects.toMatchObject({
    code: 'unauthorized',
    message: 'Purchase retained capability differs from installation'
  })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})
