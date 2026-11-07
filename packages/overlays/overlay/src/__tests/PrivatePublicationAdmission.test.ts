import { OverlayPrivatePublicationAdmission } from '../PrivatePublicationAdmission.js'
import { privateAdmissionFixture as fixture } from './PrivatePublicationAdmissionFixture.js'
import { retainedTopicAdmission, timedRetainedTopicAdmission } from '../RetainedTopicAdmission.js'
import { transaction, scope, topic, key, service } from './ProposalAdmissionFixture.js'
import {
  Utils,
  PrivateKey,
  outputPacketDigest,
  signOutputPacket,
  outputPrivatePublicationRequestDigest
} from '@bsv/sdk'
import {
  admissionSemanticDigest,
  type AdmissionHistoryResult
} from '../storage/AdmissionStorage.js'
import { getOverlayAdmissionHost, overlayAdmissionContextDigest } from '../EngineAdmission.js'

describe('private publication admission bridge', () => {
  test('requires original acceptance time for a timed companion without changing ordinary history projection', () => {
    const f = fixture(),
      original = f.original(),
      query = {
        scope,
        txid: transaction.id('hex'),
        topic,
        policyId: 'overlay-engine-submit-v1',
        contextDigest: overlayAdmissionContextDigest([1, 2, 3])
      }
    const ordinary = retainedTopicAdmission(original, query, transaction)
    expect(() => timedRetainedTopicAdmission(original, query, transaction)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
    const retained = { ...original, acceptedAt: '30' as never }
    const timed = timedRetainedTopicAdmission(retained, query, transaction)
    expect(timed.acceptedAt).toBe('30')
    expect(timed.steak).toEqual(ordinary.steak)
    expect(retainedTopicAdmission(retained, query, transaction)).toEqual(ordinary)
    expect(timedRetainedTopicAdmission(structuredClone(retained), query, transaction)).toEqual(
      timed
    )
    expect(
      timedRetainedTopicAdmission({ ...retained, acceptedAt: '31' as never }, query, transaction)
        .assessmentContextId
    ).not.toBe(timed.assessmentContextId)
    expect(() =>
      timedRetainedTopicAdmission({ ...retained, acceptedAt: '-1' as never }, query, transaction)
    ).toThrow()
  })
  test('honors the complete original request-byte limit before reading or submitting', async () => {
    const f = fixture({}, 65536, 128)
    await expect(f.run()).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a synchronous verification guard cannot change the installed manager before submission', async () => {
    const f = fixture()
    f.current.mockImplementation(() => {
      f.engine.managers[topic] = {} as never
      return true
    })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
  })
  test('async authorization is not accepted as a synchronous current-context guard', async () => {
    const f = fixture({ isCurrent: (() => Promise.resolve(true)) as never })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  test('accepts the exact Engine private-byte ceiling when the installed contract promises it', async () => {
    const f = fixture({ maximumPrivateBytes: 100000 }, 100000)
    f.job.request.privateValues = Utils.toBase64(Array.from({ length: 100000 }, () => 7))
    f.job.requestDigest = outputPrivatePublicationRequestDigest(f.job.request)
    f.context.requestDigest = f.job.requestDigest
    await expect(f.run()).resolves.toMatchObject({ status: 'unresolved' })
    expect(f.submit.mock.calls[0][3]).toEqual(Array.from({ length: 100000 }, () => 7))
  })
  test('applies a smaller selected capacity before effects', async () => {
    const f = fixture({}, 1)
    await expect(f.run()).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  test('recovers exact private context and projects only the original selected topic', async () => {
    const f = fixture(),
      admission = f.original()
    f.read.mockResolvedValue({ state: 'committed', admission })
    const result = await f.run()
    const expected = retainedTopicAdmission(
      admission,
      {
        scope,
        txid: transaction.id('hex'),
        topic,
        policyId: 'overlay-engine-submit-v1',
        contextDigest: overlayAdmissionContextDigest([1, 2, 3])
      },
      transaction
    )
    expect(result).toEqual({
      operationId: f.job.operationId,
      txid: f.job.request.evidence.txid,
      status: 'admitted',
      context: 'matching-private-values',
      ...expected
    })
    expect(Object.keys(expected.steak)).toEqual([topic])
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('submits private bytes through the existing off-chain argument then reads retained history', async () => {
    const f = fixture()
    f.submit.mockImplementation(async () => {
      f.read.mockResolvedValue({ state: 'committed', admission: f.original() })
      return {}
    })
    expect(await f.run()).toMatchObject({ status: 'admitted', context: 'matching-private-values' })
    expect(f.submit).toHaveBeenCalledWith(
      { beef: Utils.toArray(f.job.request.evidence.beef, 'base64'), topics: [topic] },
      undefined,
      'current-tx',
      [1, 2, 3]
    )
    expect(f.read).toHaveBeenCalledTimes(2)
  })
  test('a lost reply after commit recovers the original receipt', async () => {
    const f = fixture()
    f.submit.mockImplementation(async () => {
      f.read.mockResolvedValue({ state: 'committed', admission: f.original() })
      throw new Error('reply lost')
    })
    expect(await f.run()).toMatchObject({ status: 'admitted' })
  })
  test('a duplicate STEAK without retained history remains unresolved', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({
      operationId: f.job.operationId,
      txid: f.job.request.evidence.txid,
      status: 'unresolved'
    })
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  test('explicit public reuse preserves public provenance and original assessment', async () => {
    const f = fixture({ publicAdmissionReuse: 'after-independent-private-validation' })
    const admission = f.original('public')
    f.read.mockImplementation(async query =>
      query.contextDigest === admission.identity.contextDigest
        ? { state: 'committed', admission }
        : { state: 'unresolved' }
    )
    const result = await f.run()
    expect(result).toMatchObject({ status: 'admitted', context: 'public' })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledTimes(2)
  })
  test('disabled public reuse cannot adopt public admission', async () => {
    const f = fixture(),
      admission = f.original('public')
    f.read.mockImplementation(async query =>
      query.contextDigest === admission.identity.contextDigest
        ? { state: 'committed', admission }
        : { state: 'unresolved' }
    )
    expect(await f.run()).toMatchObject({ status: 'unresolved' })
    expect(
      f.read.mock.calls.every(
        ([query]) => query.contextDigest === overlayAdmissionContextDigest([1, 2, 3])
      )
    ).toBe(true)
  })
  test('a retained transaction excluding the requested output is not admitted', async () => {
    const f = fixture(),
      admission = f.original()
    admission.receipt.steak = JSON.stringify({ [topic]: { outputsToAdmit: [], coinsToRetain: [] } })
    f.read.mockResolvedValue({ state: 'committed', admission })
    expect(await f.run()).toMatchObject({ status: 'excluded', context: 'matching-private-values' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('does not relabel historical assessment with a new reservation or index visibility', async () => {
    const f = fixture(),
      admission = f.original()
    f.read.mockResolvedValue({ state: 'committed', admission })
    const first = await f.run()
    f.job.operationId = '44'.repeat(32)
    admission.receipt.indexes = [{ target: 'new-index', state: 'visible' }]
    admission.receipt.propagation = 'pending'
    const second = await f.run()
    expect(first.status).toBe('admitted')
    expect(second.status).toBe('admitted')
    if (first.status === 'unresolved' || second.status === 'unresolved')
      throw new Error('Missing assessment')
    expect(second.assessmentContextId).toBe(first.assessmentContextId)
    expect(second.operationId).not.toBe(first.operationId)
  })
  test.each(['publisher', 'requestDigest', 'id'] as const)(
    'requires a valid original verification %s',
    async field => {
      const f = fixture()
      f.context[field] = ''
      await expect(f.run()).rejects.toBeDefined()
      expect(f.submit).not.toHaveBeenCalled()
      expect(f.read).not.toHaveBeenCalled()
    }
  )
  test('changed immutable chain context is rejected', async () => {
    const f = fixture()
    f.context.view.chain.genesisHash = '77'.repeat(32)
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('changed semantic request fails before history or effects', async () => {
    const f = fixture()
    f.job.request.privateValues = Utils.toBase64([9])
    await expect(f.run()).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  test.each(['publicationId', 'rawTransaction'] as const)(
    'changed reserved %s fails',
    async field => {
      const f = fixture()
      f.job[field] = field === 'publicationId' ? '77'.repeat(32) : Utils.toBase64([0])
      await expect(f.run()).rejects.toBeDefined()
      expect(f.submit).not.toHaveBeenCalled()
    }
  )
  test('invalid output index cannot use an otherwise valid transaction', async () => {
    const f = fixture()
    f.job.request.evidence.outputIndex = transaction.outputs.length
    f.job.requestDigest = outputPrivatePublicationRequestDigest(f.job.request)
    f.context.requestDigest = f.job.requestDigest
    await expect(f.run()).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  test('original capability signature is verified', async () => {
    const f = fixture()
    f.selection.manifest.signature = '00'
    await expect(f.run()).rejects.toBeDefined()
    expect(f.read).not.toHaveBeenCalled()
  })
  test('a manifest cannot promise more than this Engine accepts', async () => {
    const f = fixture({}, 100001)
    await expect(f.run()).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('outcome capacity is checked before submission', async () => {
    const f = fixture({ maximumOutcomeBytes: 128 })
    await expect(f.run()).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test.each([0, 100001, 1.5, Number.NaN])(
    'rejects invalid installed private bound %s',
    maximumPrivateBytes => {
      expect(() => fixture({ maximumPrivateBytes })).toThrow()
    }
  )
  test('current authorization is checked before reading history', async () => {
    const f = fixture()
    f.current.mockReturnValue(false)
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  })
  test('current authorization is checked after retained history resolves', async () => {
    const f = fixture()
    f.read.mockImplementation(async () => {
      f.current.mockReturnValue(false)
      return { state: 'committed', admission: f.original() }
    })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a changed installed topic manager fences an in-flight result', async () => {
    const f = fixture()
    f.read.mockImplementation(async () => {
      f.engine.managers[topic] = {} as never
      return { state: 'unresolved' }
    })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a replaced submit implementation is not called', async () => {
    const f = fixture()
    f.engine.submit = jest.fn() as never
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.engine.submit).not.toHaveBeenCalled()
  })
  test('all request, selection and context bytes are owned across awaits', async () => {
    const f = fixture(),
      originalContext = structuredClone(f.context)
    f.read.mockImplementationOnce(async () => {
      f.job.request.privateValues = Utils.toBase64([8])
      f.selection.digest = '55'.repeat(32)
      f.context.id = 'replaced'
      return { state: 'unresolved' }
    })
    await f.run()
    expect(f.submit.mock.calls[0][3]).toEqual([1, 2, 3])
    expect(
      f.current.mock.calls.every(
        ([context]) => JSON.stringify(context) === JSON.stringify(originalContext)
      )
    ).toBe(true)
  })
  test('physical capacity remains occupied while history is stalled, and releases afterward', async () => {
    const f = fixture({ maximumConcurrentAdmissions: 1 })
    let resolve!: (value: AdmissionHistoryResult) => void
    f.read.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const first = f.run()
    // Attach both settlement handlers before testing the competing call. Early
    // validation failures must fail assertions, never become unhandled rejections.
    const settled = Promise.allSettled([first])
    try {
      await expect(f.run()).rejects.toMatchObject({
        code: 'limited',
        message: expect.stringMatching(/\S/),
        retryable: true
      })
    } finally {
      resolve?.({ state: 'unresolved' })
    }
    expect(await settled).toEqual([
      {
        status: 'fulfilled',
        value: {
          operationId: f.job.operationId,
          txid: f.job.request.evidence.txid,
          status: 'unresolved'
        }
      }
    ])
    await expect(f.run()).resolves.toMatchObject({ status: 'unresolved' })
  })
  test.each(['context', 'scope', 'topic', 'digest'] as const)(
    'refuses mismatching retained %s provenance',
    async field => {
      const f = fixture(),
        admission = f.original()
      if (field === 'context') admission.identity.contextDigest = '99'.repeat(32)
      if (field === 'scope') admission.identity.scope.nodeId = 'other'
      if (field === 'topic')
        admission.identity.topics = [{ topic: 'other', policyId: 'overlay-engine-submit-v1' }]
      if (field === 'digest') admission.receipt.semanticDigest = '99'.repeat(32)
      f.read.mockResolvedValue({ state: 'committed', admission })
      await expect(f.run()).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringMatching(/\S/)
      })
      expect(f.submit).not.toHaveBeenCalled()
    }
  )
})

function resign(f: ReturnType<typeof fixture>): void {
  f.selection.manifest = signOutputPacket('capabilities', f.selection.manifest.body, key)
  f.selection.digest = outputPacketDigest('capabilities', f.selection.manifest.body)
  f.selection.headers['x-bsv-overlay-capability'] = f.selection.digest
}
function digestRequest(f: ReturnType<typeof fixture>): void {
  f.job.requestDigest = outputPrivatePublicationRequestDigest(f.job.request)
  f.context.requestDigest = f.job.requestDigest
}

test.each([
  [
    'selected service',
    (f: ReturnType<typeof fixture>) => {
      f.selection.service = { ...f.selection.service, name: 'other' }
    }
  ],
  [
    'selected profile',
    (f: ReturnType<typeof fixture>) => {
      f.selection.profile = { ...f.selection.profile, maxResponseBytes: 32 }
    }
  ],
  [
    'capability digest',
    (f: ReturnType<typeof fixture>) => {
      f.selection.digest = '99'.repeat(32)
    }
  ],
  [
    'capability header',
    (f: ReturnType<typeof fixture>) => {
      f.selection.headers['x-bsv-overlay-capability'] = '99'.repeat(32)
    }
  ],
  [
    'profile header',
    (f: ReturnType<typeof fixture>) => {
      f.selection.headers['x-bsv-overlay-profile'] = 'urn:test:other'
    }
  ],
  [
    'manifest identity',
    (f: ReturnType<typeof fixture>) => {
      f.selection.manifest.body.identity = new PrivateKey(12).toPublicKey().toString()
      resign(f)
    }
  ],
  [
    'requested topic',
    (f: ReturnType<typeof fixture>) => {
      f.job.request.topic = 'tm_other'
      digestRequest(f)
    }
  ]
] as const)('independently binds %s before any history read', async (_name, change) => {
  const f = fixture()
  change(f)
  await expect(f.run()).rejects.toMatchObject({
    code: 'unauthorized',
    message: expect.stringMatching(/\S/)
  })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})
test.each([
  ['rulesDigest', { rulesDigest: '99'.repeat(32) }],
  ['service', { service: 'other-service' }]
] as const)('requires the exact installed %s', async (_name, options) => {
  const f = fixture(options)
  await expect(f.run()).rejects.toMatchObject({
    code: 'unauthorized',
    message: expect.stringMatching(/\S/)
  })
  expect(f.read).not.toHaveBeenCalled()
})
test('selects only the matching topic service and publication profile among unrelated entries', async () => {
  const f = fixture(),
    otherProfile = { ...f.selection.profile, id: 'urn:test:other', parameters: {} }
  const selectedService = { ...f.selection.service, profiles: [otherProfile, f.selection.profile] }
  f.selection.manifest.body.services = [
    { ...selectedService, name: service, kind: 'lookup', profiles: [otherProfile] },
    { ...selectedService, name: 'other-service' },
    selectedService
  ]
  f.selection.service = selectedService
  resign(f)
  expect(await f.run()).toMatchObject({ status: 'unresolved' })
  expect(f.submit).toHaveBeenCalledTimes(1)
})
test('rejects a service that no longer includes the selected publication profile', async () => {
  const f = fixture()
  f.selection.manifest.body.services[0].profiles[0].id = 'urn:test:other'
  resign(f)
  await expect(f.run()).rejects.toMatchObject({
    code: 'unauthorized',
    message: expect.stringMatching(/\S/)
  })
  expect(f.read).not.toHaveBeenCalled()
})
test.each(['publisher', 'requestDigest', 'chain'] as const)(
  'rejects independently changed original verification %s',
  async field => {
    const f = fixture()
    if (field === 'publisher') f.context.publisher = new PrivateKey(12).toPublicKey().toString()
    if (field === 'requestDigest') f.context.requestDigest = '99'.repeat(32)
    if (field === 'chain') {
      f.selection.manifest.body.chain.network = 'other'
      resign(f)
      f.job.publicationId = outputPacketDigest('private-publication', {
        chain: f.selection.manifest.body.chain,
        publisher: f.job.publisher,
        topic: f.job.request.topic,
        requestId: f.job.request.requestId
      })
    }
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  }
)
test('does not admit a different claimed txid even when raw bytes and output index match the BEEF', async () => {
  const f = fixture()
  f.job.request.evidence.txid = '99'.repeat(32)
  digestRequest(f)
  await expect(f.run()).rejects.toMatchObject({
    code: 'invalid',
    message: 'Publication and BEEF default target differ'
  })
  expect(f.read).not.toHaveBeenCalled()
})
test('rejects an unsupported schema before reading history', async () => {
  const f = fixture()
  f.job.request.schema = 'urn:test:uninstalled'
  digestRequest(f)
  await expect(f.run()).rejects.toMatchObject({
    code: 'unsupported',
    message: expect.stringMatching(/\S/)
  })
  expect(f.read).not.toHaveBeenCalled()
})
test.each(['storage', 'admission', 'history', 'scope'] as const)(
  'fences a replaced %s after an asynchronous read',
  async field => {
    const f = fixture()
    f.read.mockImplementationOnce(async () => {
      const host = getOverlayAdmissionHost(f.engine.storage)!
      if (field === 'storage') f.engine.storage = { ...f.engine.storage } as never
      if (field === 'admission')
        (f.engine.storage as unknown as { admission: typeof host.admission }).admission = {
          ...host.admission
        }
      if (field === 'history')
        Object.defineProperty(host.admission, 'history', {
          value: { ...host.admission.history! },
          configurable: true
        })
      if (field === 'scope')
        (f.engine.storage as unknown as { admissionScope: typeof scope }).admissionScope.nodeId =
          'replaced-node'
      return { state: 'unresolved' }
    })
    await expect(f.run()).rejects.toMatchObject({
      code: 'context-changed',
      message: expect.stringMatching(/\S/)
    })
    expect(f.submit).not.toHaveBeenCalled()
  }
)
test.each(['missing host', 'missing history'] as const)(
  'requires original retained history with %s',
  missing => {
    const f = fixture(),
      host = getOverlayAdmissionHost(f.engine.storage)!
    if (missing === 'missing host')
      delete (f.engine.storage as unknown as { admissionScope?: unknown }).admissionScope
    else expect(Reflect.deleteProperty(host.admission, 'history')).toBe(true)
    expect(() => new OverlayPrivatePublicationAdmission(f.options)).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: 'Durable retained admission history is required'
      })
    )
  }
)
test.each([undefined, null, false])(
  'requires an installed current-context guard: %s',
  isCurrent => {
    expect(() => fixture({ isCurrent: isCurrent as never })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Current publication verification guard is required'
      })
    )
  }
)
test.each([undefined, 'implicit', true])(
  'requires an explicit public-history policy: %s',
  publicAdmissionReuse => {
    expect(() => fixture({ publicAdmissionReuse: publicAdmissionReuse as never })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'An explicit public admission reuse policy is required'
      })
    )
  }
)
test('requires an installed topic manager before accepting the adapter', () => {
  const f = fixture()
  delete f.engine.managers[topic]
  expect(() => new OverlayPrivatePublicationAdmission(f.options)).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Private publication topic manager is not installed'
    })
  )
})
test('rejects malformed retained history state rather than treating any non-unresolved value as committed', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'unexpected', admission: f.original() } as never)
  await expect(f.run()).rejects.toMatchObject({
    code: 'invalid',
    message: 'Invalid admission history result'
  })
  expect(f.submit).not.toHaveBeenCalled()
})
test('requires the original ordinary Engine policy even if the selected topic is present', async () => {
  const f = fixture(),
    original = f.original()
  original.identity.topics[0].policyId = 'other-policy'
  original.receipt.semanticDigest = admissionSemanticDigest(original.identity)
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  await expect(f.run()).rejects.toMatchObject({
    code: 'invalid',
    message: expect.stringMatching(/\S/)
  })
  expect(f.submit).not.toHaveBeenCalled()
})
test('preflights the full maximum admission representation, including its context and assessment prefix', async () => {
  const original = fixture()
  const maximum = {
    operationId: original.job.operationId,
    txid: original.job.request.evidence.txid,
    status: 'admitted',
    context: 'matching-private-values',
    assessmentContextId: 'overlay-topic-admission-v1:' + '0'.repeat(64),
    steak: {
      [topic]: {
        outputsToAdmit: transaction.outputs.map((_, i) => i),
        coinsToRetain: transaction.inputs.map((_, i) => i),
        coinsRemoved: transaction.inputs.map((_, i) => i)
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(maximum))
  const f = fixture({ maximumOutcomeBytes: bytes - 1 })
  await expect(f.run()).rejects.toMatchObject({
    code: 'limited',
    message: expect.stringMatching(/\S/)
  })
  expect(f.submit).not.toHaveBeenCalled()
  const exact = fixture({ maximumOutcomeBytes: bytes })
  await expect(exact.run()).resolves.toMatchObject({ status: 'unresolved' })
})

test('owns explicitly supported critical extensions while default installations reject them', async () => {
  const extensions = ['urn:test:private-extension'],
    f = fixture({ supportedExtensions: extensions })
  extensions.length = 0
  Object.assign(f.job.request, {
    extensions: { 'urn:test:private-extension': { value: true } },
    critical: ['urn:test:private-extension']
  })
  f.job.requestDigest = outputPrivatePublicationRequestDigest(f.job.request, [
    'urn:test:private-extension'
  ])
  f.context.requestDigest = f.job.requestDigest
  expect(await f.run()).toMatchObject({ status: 'unresolved' })
  const ordinary = fixture()
  Object.assign(ordinary.job, structuredClone(f.job))
  ordinary.context.requestDigest = f.job.requestDigest
  await expect(ordinary.run()).rejects.toMatchObject({
    code: 'unsupported',
    message: expect.stringMatching(/\S/)
  })
  expect(ordinary.read).not.toHaveBeenCalled()
})
test('never enables plaintext localhost HTTP for the retained private profile', async () => {
  const f = fixture()
  f.selection.manifest.body.baseURL = 'http://localhost:8080/api'
  resign(f)
  await expect(f.run()).rejects.toBeDefined()
  expect(f.read).not.toHaveBeenCalled()
})
test.each([
  { maximumOutcomeBytes: 127 },
  { maximumOutcomeBytes: 65537 },
  { maximumConcurrentAdmissions: 0 },
  { maximumConcurrentAdmissions: 65 }
])('rejects invalid whole-outcome or work bounds: %j', options => {
  expect(() => fixture(options)).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Invalid private publication admission capacity'
    })
  )
})
test.each(['job', 'context'] as const)(
  'bounds the complete %s envelope before field validation',
  async field => {
    const f = fixture()
    if (field === 'job') f.job.rawTransaction = 'A'.repeat(2 * 1048576)
    else f.context.id = 'x'.repeat(16384)
    await expect(f.run()).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringMatching(/\S/)
    })
    expect(f.read).not.toHaveBeenCalled()
  }
)

test('preserves the independently fixed original selected-topic assessment bytes', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'committed', admission: f.original() })
  await expect(f.run()).resolves.toMatchObject({
    status: 'admitted',
    assessmentContextId:
      'overlay-topic-admission-v1:bc58a63e3d9164c9d7070ba5dca3bb95b607590fa48bdccf67f862c6d21c8771'
  })
})
