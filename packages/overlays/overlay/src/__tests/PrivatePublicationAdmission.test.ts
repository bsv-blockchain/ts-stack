import { privateAdmissionFixture as fixture } from './PrivatePublicationAdmissionFixture.js'
import { retainedTopicAdmission } from '../RetainedTopicAdmission.js'
import { transaction, scope, topic } from './ProposalAdmissionFixture.js'
import { Utils, outputPrivatePublicationRequestDigest } from '@bsv/sdk'
import { type AdmissionHistoryResult } from '../storage/AdmissionStorage.js'
import { overlayAdmissionContextDigest } from '../EngineAdmission.js'

describe('private publication admission bridge', () => {
  test('honors the complete original request-byte limit before reading or submitting', async () => {
    const f = fixture({}, 65536, 128)
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a synchronous verification guard cannot change the installed manager before submission', async () => {
    const f = fixture()
    f.current.mockImplementation(() => {
      f.engine.managers[topic] = {} as never
      return true
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.submit).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
  })
  test('async authorization is not accepted as a synchronous current-context guard', async () => {
    const f = fixture({ isCurrent: (() => Promise.resolve(true)) as never })
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('changed semantic request fails before history or effects', async () => {
    const f = fixture()
    f.job.request.privateValues = Utils.toBase64([9])
    await expect(f.run()).rejects.toMatchObject({ code: 'conflict' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'invalid' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('outcome capacity is checked before submission', async () => {
    const f = fixture({ maximumOutcomeBytes: 128 })
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.read).not.toHaveBeenCalled()
  })
  test('current authorization is checked after retained history resolves', async () => {
    const f = fixture()
    f.read.mockImplementation(async () => {
      f.current.mockReturnValue(false)
      return { state: 'committed', admission: f.original() }
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a changed installed topic manager fences an in-flight result', async () => {
    const f = fixture()
    f.read.mockImplementation(async () => {
      f.engine.managers[topic] = {} as never
      return { state: 'unresolved' }
    })
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  test('a replaced submit implementation is not called', async () => {
    const f = fixture()
    f.engine.submit = jest.fn() as never
    await expect(f.run()).rejects.toMatchObject({ code: 'context-changed' })
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
    await expect(f.run()).rejects.toMatchObject({ code: 'limited' })
    resolve({ state: 'unresolved' })
    await first
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
      await expect(f.run()).rejects.toMatchObject({ code: 'invalid' })
      expect(f.submit).not.toHaveBeenCalled()
    }
  )
})
