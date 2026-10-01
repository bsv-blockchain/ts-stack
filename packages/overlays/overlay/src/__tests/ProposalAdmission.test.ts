import { canonicalOutputJSON, PrivateKey, signOutputPacket, Transaction, Utils } from '@bsv/sdk'
import { OverlayProposalAdmission } from '../ProposalAdmission.js'
import { admissionSemanticDigest, type RetainedAdmission } from '../storage/AdmissionStorage.js'
import {
  fixture,
  chain,
  identity,
  key,
  retained,
  rulesDigest,
  scope,
  service,
  topic,
  transaction
} from './ProposalAdmissionFixture.js'

test('requires actual retained-history capability and an installed topic', () => {
  const f = fixture()
  const options = { engine: f.engine, identity, rulesDigest, service, topic }
  expect(f.bridge.requiresVerificationContext).toBe(true)
  expect(f.bridge.maximumOutcomeBytes).toBe(1048576)
  expect(
    new OverlayProposalAdmission({ ...options, maximumConcurrentAdmissions: 64 })
  ).toBeDefined()
  for (const value of [127, 1048577, 128.5, NaN])
    expect(() => new OverlayProposalAdmission({ ...options, maximumOutcomeBytes: value })).toThrow(
      'capacity'
    )
  expect(() => new OverlayProposalAdmission({ ...options, topic: 'missing' })).toThrow(
    'not installed'
  )
  delete (f.engine.storage.admission as { history?: unknown }).history
  expect(() => new OverlayProposalAdmission(options)).toThrow('history is required')
})

test('recovers only the requested topic and preserves the original assessment across new reservations', async () => {
  const f = fixture()
  const original = retained()
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  const first = await f.bridge.recover(f.job, f.proposal, f.selection, f.context)
  expect(first).toMatchObject({
    operationId: f.job.operationId,
    txid: f.job.txid,
    status: 'admitted',
    steak: { [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] } }
  })
  expect(JSON.stringify(first)).not.toMatch(/private|duplicate|historical|original-reservation/)
  expect(f.read).toHaveBeenCalledWith({
    scope,
    txid: f.job.txid,
    topic,
    policyId: 'overlay-engine-submit-v1',
    contextDigest: original.identity.contextDigest
  })
  expect(f.submit).not.toHaveBeenCalled()
  original.receipt.indexes[0].state = 'visible'
  const second = await f.bridge.recover(
    { ...f.job, operationId: 'another-reservation' },
    f.proposal,
    f.selection,
    { ...f.context, id: 'new-verification-context' }
  )
  expect(second).toEqual({ ...first, operationId: 'another-reservation' })
  original.receipt.operationId = 'another-original-operation'
  const third = await f.bridge.recover(f.job, f.proposal, f.selection, f.context)
  expect(third).not.toEqual(first)
})

test('submits the exact reserved BEEF to the installed topic and recovers after a lost response', async () => {
  const f = fixture()
  f.read
    .mockResolvedValueOnce({ state: 'unresolved' })
    .mockResolvedValueOnce({ state: 'committed', admission: retained() })
  f.submit.mockRejectedValue(new Error('lost response after commit'))
  expect(await f.bridge.recover(f.job, f.proposal, f.selection, f.context)).toMatchObject({
    status: 'admitted'
  })
  expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.submit).toHaveBeenCalledWith({ beef: transaction.toBEEF(), topics: [topic] })
  expect(f.read).toHaveBeenCalledTimes(2)
})

test.each([false, true])(
  'missing history remains unresolved, including duplicate/failed submission (%s)',
  async fails => {
    const f = fixture()
    if (fails) f.submit.mockRejectedValue(new Error('partial failure'))
    expect(await f.bridge.recover(f.job, f.proposal, f.selection, f.context)).toEqual({
      status: 'unresolved',
      operationId: f.job.operationId,
      txid: f.job.txid
    })
  }
)

test('failed history access is not absence and cannot trigger a new submission', async () => {
  const f = fixture()
  f.read.mockRejectedValue(new Error('database unavailable'))
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toThrow(
    'database unavailable'
  )
  expect(f.submit).not.toHaveBeenCalled()
})

test('bounds a complete valid result before effects and also bounds retained results', async () => {
  const f = fixture(128)
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'limited'
  })
  expect(f.submit).not.toHaveBeenCalled()
  f.read.mockResolvedValue({ state: 'committed', admission: retained() })
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'limited'
  })
})

test.each<[string, (f: ReturnType<typeof fixture>) => void]>([
  [
    'job extension',
    f => {
      Object.assign(f.job, { ignored: true })
    }
  ],
  [
    'raw mismatch',
    f => {
      f.job.rawTransaction = Utils.toBase64(new Transaction().toBinary())
    }
  ],
  [
    'txid mismatch',
    f => {
      f.job.txid = 'ff'.repeat(32)
    }
  ],
  [
    'operation identity',
    f => {
      f.job.operationId = ''
    }
  ],
  [
    'caller',
    f => {
      f.job.caller = '02' + 'ff'.repeat(32)
    }
  ],
  [
    'request time',
    f => {
      f.job.requestedAt = '-1'
    }
  ],
  [
    'signature',
    f => {
      f.proposal = signOutputPacket('proposal', f.proposal.body, new PrivateKey(12))
    }
  ],
  [
    'withdrawal',
    f => {
      f.proposal = signOutputPacket('proposal', { ...f.proposal.body, operation: 'withdraw' }, key)
    }
  ],
  [
    'service',
    f => {
      f.proposal = signOutputPacket('proposal', { ...f.proposal.body, service: 'wrong' }, key)
    }
  ],
  [
    'policy',
    f => {
      f.proposal = signOutputPacket(
        'proposal',
        { ...f.proposal.body, policy: { id: 'urn:other', digest: '03'.repeat(32) } },
        key
      )
    }
  ],
  [
    'selection digest',
    f => {
      f.selection.digest = '04'.repeat(32)
    }
  ],
  [
    'selected service',
    f => {
      f.selection.service = { ...f.selection.service, name: 'other' }
    }
  ],
  [
    'selected profile',
    f => {
      f.selection.profile = {
        ...f.selection.profile,
        maxResponseBytes: f.selection.profile.maxResponseBytes + 1
      }
    }
  ],
  [
    'capability header',
    f => {
      f.selection.headers['x-bsv-overlay-capability'] = '05'.repeat(32)
    }
  ],
  [
    'profile header',
    f => {
      f.selection.headers['x-bsv-overlay-profile'] = 'urn:other'
    }
  ],
  [
    'manifest identity',
    f => {
      f.selection.manifest = signOutputPacket(
        'capabilities',
        { ...f.selection.manifest.body, identity: new PrivateKey(12).toPublicKey().toString() },
        new PrivateKey(12)
      )
    }
  ],
  [
    'context chain',
    f => {
      f.context = { ...f.context, view: { chain: { ...chain, network: 'other' } } }
    }
  ],
  [
    'proposal chain',
    f => {
      f.proposal = signOutputPacket(
        'proposal',
        { ...f.proposal.body, chain: { ...chain, network: 'other' } },
        key
      )
    }
  ]
])('rejects %s before history or effects', async (_, change) => {
  const f = fixture()
  change(f)
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toThrow()
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test('requires original evidence context rather than synthesizing one', async () => {
  const f = fixture()
  await expect(f.bridge.recover(f.job, f.proposal, f.selection)).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect(f.submit).not.toHaveBeenCalled()
})

test('holds physical work capacity until stalled admission settles, then releases after either outcome', async () => {
  const f = fixture()
  const options = { engine: f.engine, identity, rulesDigest, service, topic }
  for (const maximumConcurrentAdmissions of [0, 65, 1.5, NaN])
    expect(() => new OverlayProposalAdmission({ ...options, maximumConcurrentAdmissions })).toThrow(
      'concurrency capacity'
    )
  const bridge = new OverlayProposalAdmission({ ...options, maximumConcurrentAdmissions: 1 })
  let release!: () => void
  const wait = new Promise<void>(resolve => {
    release = resolve
  })
  f.read.mockImplementationOnce(async () => {
    await wait
    throw new Error('delayed failure')
  })
  const first = bridge.recover(f.job, f.proposal, f.selection, f.context)
  const failed = expect(first).rejects.toThrow('delayed failure')
  await expect(bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'limited',
    retryable: true
  })
  expect(f.read).toHaveBeenCalledTimes(1)
  release()
  await failed
  f.read.mockResolvedValue({ state: 'committed', admission: retained() })
  expect(await bridge.recover(f.job, f.proposal, f.selection, f.context)).toMatchObject({
    status: 'admitted'
  })
  expect(await bridge.recover(f.job, f.proposal, f.selection, f.context)).toMatchObject({
    status: 'admitted'
  })
})

test.each<[string, (value: RetainedAdmission) => void]>([
  [
    'scope',
    r => {
      r.identity.scope.nodeId = 'other'
    }
  ],
  [
    'transaction',
    r => {
      r.identity.txid = '03'.repeat(32)
    }
  ],
  [
    'context',
    r => {
      r.identity.contextDigest = '04'.repeat(32)
    }
  ],
  [
    'duplicate-only topic',
    r => {
      r.identity.topics = r.identity.topics.filter(t => t.topic !== topic)
    }
  ],
  [
    'ordinary policy',
    r => {
      r.identity.topics[0].policyId = 'other'
    }
  ],
  [
    'digest',
    r => {
      r.receipt.semanticDigest = '05'.repeat(32)
    }
  ],
  [
    'durability',
    r => {
      r.receipt.durability = 'memory' as never
    }
  ],
  [
    'missing topic',
    r => {
      r.receipt.steak = '{}'
    }
  ],
  [
    'out-of-range output',
    r => {
      r.receipt.steak = JSON.stringify({
        [topic]: { outputsToAdmit: [transaction.outputs.length], coinsToRetain: [] }
      })
    }
  ],
  [
    'duplicate output',
    r => {
      r.receipt.steak = JSON.stringify({ [topic]: { outputsToAdmit: [0, 0], coinsToRetain: [] } })
    }
  ],
  [
    'conflicting retain/remove',
    r => {
      r.receipt.steak = JSON.stringify({
        [topic]: { outputsToAdmit: [0], coinsToRetain: [0], coinsRemoved: [0] }
      })
    }
  ],
  [
    'invalid shape',
    r => {
      r.receipt.steak = JSON.stringify({ [topic]: { outputsToAdmit: [-1], coinsToRetain: [] } })
    }
  ]
])('rejects corrupt retained %s without submitting', async (_, change) => {
  const f = fixture()
  const original = retained()
  change(original)
  if (original.receipt.semanticDigest !== '05'.repeat(32))
    original.receipt.semanticDigest = admissionSemanticDigest(original.identity)
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toThrow()
  expect(f.submit).not.toHaveBeenCalled()
})

test('owns caller inputs across asynchronous history reads and detects installation replacement', async () => {
  const f = fixture()
  const originalJob = structuredClone(f.job)
  f.read.mockImplementationOnce(async () => {
    f.job.txid = '03'.repeat(32)
    f.job.beef = ''
    f.proposal.body.service = 'other'
    return { state: 'unresolved' }
  })
  expect(await f.bridge.recover(f.job, f.proposal, f.selection, f.context)).toEqual({
    operationId: originalJob.operationId,
    txid: originalJob.txid,
    status: 'unresolved'
  })
  expect(f.submit).toHaveBeenCalledWith({ beef: transaction.toBEEF(), topics: [topic] })
  const g = fixture()
  g.read.mockImplementationOnce(async () => {
    g.engine.storage = { ...g.engine.storage }
    return { state: 'committed', admission: retained() }
  })
  await expect(g.bridge.recover(g.job, g.proposal, g.selection, g.context)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(g.submit).not.toHaveBeenCalled()
})

test('a serialized result is bounded, owned and contains no other-topic receipt material', async () => {
  const f = fixture()
  const original = retained()
  f.read.mockResolvedValue({ state: 'committed', admission: original })
  const result = await f.bridge.recover(f.job, f.proposal, f.selection, f.context)
  expect(Buffer.byteLength(canonicalOutputJSON(result))).toBeLessThanOrEqual(
    f.bridge.maximumOutcomeBytes
  )
  if (result.status !== 'admitted') throw new Error('expected admission')
  result.steak[topic].outputsToAdmit.push(1)
  expect(original).toEqual(retained())
})

test.each([
  { outputsToAdmit: [], coinsToRetain: [] },
  { outputsToAdmit: [0], coinsToRetain: [] },
  { outputsToAdmit: [], coinsToRetain: [0] },
  { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [0] }
])(
  'preserves each valid ordinary admission route and optional STEAK fields',
  async instructions => {
    const f = fixture()
    const original = retained()
    original.receipt.steak = JSON.stringify({ [topic]: instructions })
    f.read.mockResolvedValue({ state: 'committed', admission: original })
    expect(await f.bridge.recover(f.job, f.proposal, f.selection, f.context)).toMatchObject({
      status: 'admitted',
      steak: { [topic]: instructions }
    })
  }
)

test('accepts the exact canonical outcome bound and refuses one byte less', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'committed', admission: retained() })
  const result = await f.bridge.recover(f.job, f.proposal, f.selection, f.context)
  const size = Buffer.byteLength(canonicalOutputJSON(result))
  const options = { engine: f.engine, identity, rulesDigest, service, topic }
  const exact = new OverlayProposalAdmission({ ...options, maximumOutcomeBytes: size })
  expect(await exact.recover(f.job, f.proposal, f.selection, f.context)).toEqual(result)
  const short = new OverlayProposalAdmission({ ...options, maximumOutcomeBytes: size - 1 })
  await expect(short.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'limited'
  })
  expect(f.submit).not.toHaveBeenCalled()
})

test.each(['manager', 'admission', 'history', 'scope'] as const)(
  'detects replaced %s while history is pending',
  async replacement => {
    const f = fixture()
    f.read.mockImplementationOnce(async () => {
      if (replacement === 'manager') f.engine.managers[topic] = { ...f.engine.managers[topic] }
      else if (replacement === 'admission')
        Object.assign(f.engine.storage, { admission: { ...f.engine.storage.admission! } })
      else if (replacement === 'history')
        Object.assign(f.engine.storage.admission!, {
          history: { ...f.engine.storage.admission!.history! }
        })
      else Object.assign(f.engine.storage, { admissionScope: { ...scope, nodeId: 'changed' } })
      return { state: 'committed', admission: retained() }
    })
    await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject(
      { code: 'context-changed' }
    )
    expect(f.submit).not.toHaveBeenCalled()
  }
)

test('never treats an unknown history state as committed', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ state: 'pending' } as never)
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'invalid'
  })
  expect(f.submit).not.toHaveBeenCalled()
})

test('owns explicitly installed extension support and rejects uninstalled critical semantics', async () => {
  const f = fixture()
  const extension = 'urn:test:proposal-extension'
  const proposal = signOutputPacket(
    'proposal',
    {
      ...f.proposal.body,
      extensions: { [extension]: { version: 1 } },
      critical: [extension]
    },
    key
  )
  f.read.mockResolvedValue({ state: 'committed', admission: retained() })
  await expect(f.bridge.recover(f.job, proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'unsupported'
  })
  const supportedExtensions = [extension]
  const installed = new OverlayProposalAdmission({
    engine: f.engine,
    identity,
    rulesDigest,
    service,
    topic,
    supportedExtensions
  })
  supportedExtensions.length = 0
  expect(await installed.recover(f.job, proposal, f.selection, f.context)).toMatchObject({
    status: 'admitted'
  })
})

test('verifies the retained manifest signature independently of its correctly bound body and selector', async () => {
  const f = fixture()
  f.selection.manifest = signOutputPacket(
    'capabilities',
    f.selection.manifest.body,
    new PrivateKey(12)
  )
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'unauthorized'
  })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test('never submits a different BEEF default target even when the reserved transaction is embedded in its ancestry', async () => {
  const f = fixture()
  const ancestor = transaction.inputs[0].sourceTransaction!
  f.job.txid = ancestor.id('hex')
  f.job.rawTransaction = Utils.toBase64(ancestor.toBinary())
  await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toThrow(
    'BEEF target differ'
  )
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test('requires the configured service-rules digest independently of signed manifest validity', async () => {
  const f = fixture()
  const bridge = new OverlayProposalAdmission({
    engine: f.engine,
    identity,
    rulesDigest: '06'.repeat(32),
    service,
    topic
  })
  await expect(bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject({
    code: 'unauthorized'
  })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})

test.each(['service', 'profile'] as const)(
  'requires an actually advertised proposal %s',
  async missing => {
    const f = fixture()
    const body = structuredClone(f.selection.manifest.body)
    if (missing === 'service') body.services = []
    else body.services[0].profiles[0].id = 'urn:test:another-profile'
    f.selection.manifest = signOutputPacket('capabilities', body, key)
    await expect(f.bridge.recover(f.job, f.proposal, f.selection, f.context)).rejects.toMatchObject(
      { code: 'unauthorized' }
    )
    expect(f.read).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  }
)
