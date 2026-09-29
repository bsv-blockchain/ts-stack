import { afterEach, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  OutputProtocolError,
  parseOutputJSON,
  retainOutputCapability,
  signOutputPacket,
  Utils,
  type OutputProposalFinalize
} from '@bsv/sdk'
import {
  MemoryProposalJournal,
  ProposalService,
  proposalChannelKey,
  type ProposalAdmissionJob,
  type ProposalAdmissionOutcome,
  type ProposalJournalLimits,
  type ProposalServiceOptions
} from '../src/proposals/index.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'
import {
  author,
  authorKey,
  outsider,
  recipient,
  signed,
  scope,
  finalize,
  reference
} from './proposal-fixture.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

function fixture(limits: Partial<ProposalJournalLimits> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-service-'))
  const path = join(directory, 'journal.sqlite')
  const { lifecycle, manifest, request: trust } = proposalCapabilityFixture()
  let now = '11'
  const stores: SQLiteProposalJournal[] = []
  const open = () => {
    const store = new SQLiteProposalJournal(path, 'service', author, lifecycle, limits)
    stores.push(store)
    return store
  }
  const storage = open()
  cleanup.push(async () => {
    for (const store of stores) await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const proposal = signed()
  const transaction = finalize(proposal)
  const raw = Utils.toBase64(transaction.toBinary())
  // Service orchestration tests inject qualified-port results. AA== is not a
  // real BEEF fixture and these tests do not claim Script/SPV or HTTP coverage.
  const request: OutputProposalFinalize = {
    version: 1,
    service: scope.service,
    proposalId: outputPacketDigest('proposal', proposal.body),
    operationId: 'first-operation-id',
    txid: transaction.id('hex'),
    beef: 'AA=='
  }
  const admitted = (job: ProposalAdmissionJob): ProposalAdmissionOutcome => ({
    status: 'admitted',
    operationId: job.operationId,
    txid: job.txid,
    steak: { [scope.service]: { outputsToAdmit: [0], coinsToRetain: [] } },
    assessmentContextId: 'verified-context-1'
  })
  const options: ProposalServiceOptions = {
    lifecycle,
    storage,
    trust,
    now: () => now,
    manifest: () => manifest,
    access: () => true,
    evidence: { verify: jest.fn(async () => raw) },
    admission: {
      maximumOutcomeBytes: 4096,
      recover: jest.fn(async (job: ProposalAdmissionJob): Promise<ProposalAdmissionOutcome> =>
        admitted(job)
      )
    }
  }
  const caller = {
    caller: author,
    capabilityDigest: outputPacketDigest('capabilities', manifest.body)
  }
  const query = {
    version: 1 as const,
    service: scope.service,
    policy: reference,
    channel: proposal.body.channel
  }
  const make = () => new ProposalService(options)
  return {
    storage,
    lifecycle,
    options,
    caller,
    proposal,
    request,
    raw,
    query,
    make,
    open,
    manifest,
    admitted,
    time: (value: string) => {
      now = value
    }
  }
}

it('records a private signed head, rechecks recipients, commits expiry and recovers its original contract', async () => {
  const f = fixture(),
    service = f.make()
  const result = await service.put({ version: 1, proposal: f.proposal }, f.caller)
  expect(result).toEqual({
    version: 1,
    proposalId: f.request.proposalId,
    status: 'recorded',
    expiresAt: '100'
  })
  const received = await service.get(f.query, { ...f.caller, caller: recipient })
  expect(received.state.status).toBe('active')
  received.proposal.body.recipients.length = 0
  expect((await service.get(f.query, f.caller)).proposal).toEqual(f.proposal)
  expect(f.options.admission.recover).not.toHaveBeenCalled()
  expect(f.options.evidence.verify).not.toHaveBeenCalled()
  f.time('100')
  expect((await service.get(f.query, f.caller)).state).toEqual({
    status: 'expired',
    recordedAt: '100'
  })
  expect((await f.storage.head()).entries).toBe(2)
  expect(await service.put({ version: 1, proposal: f.proposal }, f.caller)).toEqual(result)
  f.time('1100')
  await expect(service.get(f.query, f.caller)).rejects.toMatchObject({ code: 'expired' })
  expect(
    (await f.storage.getChannelEntry(proposalChannelKey(f.proposal.body)))?.transition.next.state
      .status
  ).toBe('expired')
})

it('does not distinguish missing and unauthorized reads, including access revoked before serialization', async () => {
  const f = fixture(),
    service = f.make()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  for (const [query, caller] of [
    [f.query, { ...f.caller, caller: outsider }],
    [{ ...f.query, channel: 'ff'.repeat(32) }, f.caller],
    [{ ...f.query, service: 'other' }, f.caller]
  ] as const)
    await expect(service.get(query, caller)).rejects.toMatchObject({
      code: 'not-found',
      message: 'Proposal not found'
    })
  let reads = 0
  f.options.access = action => action !== 'read' || ++reads === 1
  await expect(service.get(f.query, f.caller)).rejects.toMatchObject({
    code: 'not-found',
    message: 'Proposal not found'
  })
  expect(reads).toBe(2)
})

it('persists the exact job and held completion space before admission, then recovers without new effects', async () => {
  const f = fixture(),
    service = f.make()
  f.options.admission.recover = jest.fn(
    async (job: ProposalAdmissionJob): Promise<ProposalAdmissionOutcome> => {
      const entry = await f.storage.getProposalEntry(f.request.proposalId)
      expect(entry?.transition.next.admission).toEqual(job)
      expect(entry?.transition.next.state.status).toBe('finalizing')
      expect(entry?.local).toHaveProperty('admission')
      expect((await f.storage.head()).reserved?.entries).toBe(1)
      return f.admitted(job)
    }
  )
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  const response = await service.finalize(f.request, f.caller)
  expect(response.state.status).toBe('finalized')
  expect((await f.storage.head()).reserved?.entries).toBe(0)
  expect(await service.finalize(f.request, f.caller)).toEqual(response)
  expect(
    await service.finalize(
      { ...f.request, operationId: 'another-operation-id', txid: 'aa'.repeat(32) },
      f.caller
    )
  ).toEqual(response)
  expect(f.options.admission.recover).toHaveBeenCalledTimes(1)
  expect(f.options.evidence.verify).toHaveBeenCalledTimes(1)
  await expect(
    service.finalize({ ...f.request, txid: 'aa'.repeat(32) }, f.caller)
  ).rejects.toMatchObject({ code: 'conflict' })
})

it('continues only the original reserved job after SQLite restart, clock expiry and loss of caller access', async () => {
  const f = fixture()
  let available = false
  f.options.admission.recover = jest.fn(
    async (job: ProposalAdmissionJob): Promise<ProposalAdmissionOutcome> => {
      if (!available)
        throw new OutputProtocolError('unavailable', 'Admission acknowledgement was lost')
      return f.admitted(job)
    }
  )
  let service = f.make()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'unavailable' })
  await f.storage.close()
  f.options.storage = f.open()
  f.time('1200')
  f.options.manifest = () => {
    throw new Error('Discovery is offline')
  }
  f.options.evidence.verify = jest.fn(async () => {
    throw new Error('Evidence lookup is offline')
  })
  f.options.access = () => false
  available = true
  service = f.make()
  await service.reconcile(f.request.proposalId)
  expect((await f.options.storage.getProposal(f.request.proposalId))?.record.state.status).toBe(
    'finalized'
  )
  await expect(service.get(f.query, f.caller)).rejects.toMatchObject({ code: 'not-found' })
  f.options.access = () => true
  expect((await service.finalize(f.request, f.caller)).state.status).toBe('finalized')
  expect(f.options.evidence.verify).not.toHaveBeenCalled()
  expect(
    (await f.options.storage.getProposalEntry!(f.request.proposalId))?.local?.retainUntil
  ).toBe('2200')
})

it('retains publication and admission selectors across manifest changes without accepting an unrelated current selector', async () => {
  const f = fixture(),
    service = f.make()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  const updated = signOutputPacket(
    'capabilities',
    { ...f.manifest.body, issuedAt: '12', expiresAt: '112' },
    authorKey
  )
  f.options.manifest = () => updated
  f.time('13')
  const latest = { ...f.caller, capabilityDigest: outputPacketDigest('capabilities', updated.body) }
  await service.finalize(f.request, latest)
  expect((await service.get(f.query, f.caller)).state.status).toBe('finalized')
  expect((await service.get(f.query, latest)).state.status).toBe('finalized')
  await expect(
    service.get(f.query, { ...latest, capabilityDigest: 'f0'.repeat(32) })
  ).rejects.toMatchObject({ code: 'context-changed' })
})

it('leaves malformed, unauthorized and unverified attempts unclaimed and bounds completion before admission', async () => {
  const f = fixture({ entryBytes: 6000 }),
    service = f.make()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  await expect(
    service.finalize(f.request, { ...f.caller, caller: recipient })
  ).rejects.toMatchObject({ code: 'unauthorized' })
  f.options.evidence.verify = jest.fn(async () => {
    throw new OutputProtocolError('invalid', 'Bad Script evidence')
  })
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'invalid' })
  expect(await f.storage.getOperation(author, scope.service, f.request.operationId)).toBeUndefined()
  f.options.evidence.verify = jest.fn(async () => f.raw)
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'limited' })
  expect(f.options.admission.recover).not.toHaveBeenCalled()
  expect((await f.storage.getProposal(f.request.proposalId))?.record.state.status).toBe('active')
})

it('accepts alternative proof encodings only after exact raw-byte verification and never substitutes a new transaction', async () => {
  const f = fixture(),
    service = f.make()
  f.options.admission.recover = jest.fn(
    async (job: ProposalAdmissionJob): Promise<ProposalAdmissionOutcome> => ({
      status: 'unresolved',
      operationId: job.operationId,
      txid: job.txid
    })
  )
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  expect((await service.finalize(f.request, f.caller)).state.status).toBe('finalizing')
  f.time('101')
  expect((await service.finalize({ ...f.request, beef: 'AQ==' }, f.caller)).state.status).toBe(
    'finalizing'
  )
  expect(f.options.evidence.verify).toHaveBeenCalledTimes(2)
  expect((await f.storage.getProposal(f.request.proposalId))?.record.admission?.beef).toBe('AA==')
  f.options.evidence.verify = jest.fn(async () => 'AA==')
  await expect(service.finalize({ ...f.request, beef: 'Ag==' }, f.caller)).rejects.toMatchObject({
    code: 'conflict'
  })
})

it('serializes concurrent signed revisions and rejects operation reuse across channels', async () => {
  const f = fixture(),
    service = f.make()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  const next = signed({ revision: '1', previous: f.request.proposalId })
  const withdrawal = signed({
    revision: '1',
    previous: f.request.proposalId,
    operation: 'withdraw'
  })
  const outcomes = await Promise.allSettled(
    [next, withdrawal].map(proposal => service.put({ version: 1, proposal }, f.caller))
  )
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'conflict' })

  const second = fixture(),
    secondService = second.make()
  await secondService.put({ version: 1, proposal: second.proposal }, second.caller)
  await secondService.finalize(second.request, second.caller)
  const other = signed({ channel: 'ab'.repeat(32) })
  await secondService.put({ version: 1, proposal: other }, second.caller)
  await expect(
    secondService.finalize(
      { ...second.request, proposalId: outputPacketDigest('proposal', other.body) },
      second.caller
    )
  ).rejects.toMatchObject({ code: 'conflict' })
})

it('rejects missing retained context and incompatible host ports instead of adopting new discovery', async () => {
  const f = fixture()
  const memory = new MemoryProposalJournal('volatile', author, f.lifecycle)
  expect(() => new ProposalService({ ...f.options, storage: memory })).toThrow('durable')
  expect(
    () => new ProposalService({ ...f.options, trust: { ...f.options.trust, identity: recipient } })
  ).toThrow('identity')
  expect(
    () =>
      new ProposalService({
        ...f.options,
        admission: { ...f.options.admission, maximumOutcomeBytes: 127 }
      })
  ).toThrow('outcome limit')
  await f.storage.commit(f.lifecycle.put(undefined, f.proposal, author, '11'))
  await expect(f.make().get(f.query, f.caller)).rejects.toMatchObject({ code: 'unavailable' })
})

it('counts transmitted whitespace against selected request limits and checks response capacity before effects', async () => {
  const f = fixture()
  const body = structuredClone(f.manifest.body)
  body.services[0].profiles[0].maxRequestBytes = 4096
  body.services[0].profiles[0].maxResponseBytes = 2048
  const manifest = signOutputPacket('capabilities', body, authorKey)
  f.options.manifest = () => manifest
  const caller = { ...f.caller, capabilityDigest: outputPacketDigest('capabilities', body) }
  const service = f.make()
  const request = canonicalOutputJSON({ version: 1, proposal: f.proposal })
  await expect(
    service.put(request + ' '.repeat(4097 - request.length), caller)
  ).rejects.toMatchObject({ code: 'limited' })
  expect((await f.storage.head()).entries).toBe(0)
  await service.put(request, caller)
  await expect(service.finalize(f.request, caller)).rejects.toMatchObject({ code: 'limited' })
  expect(f.options.admission.recover).not.toHaveBeenCalled()
})

it('records definitive local rejection without a global failure claim and does not let timers cancel a reservation', async () => {
  const f = fixture(),
    service = f.make()
  f.options.admission.recover = jest.fn(
    async (job: ProposalAdmissionJob): Promise<ProposalAdmissionOutcome> => {
      f.time('101')
      await service.expire(proposalChannelKey(f.proposal.body))
      expect((await f.storage.getProposal(f.request.proposalId))?.record.state.status).toBe(
        'finalizing'
      )
      return {
        status: 'rejected',
        operationId: job.operationId,
        txid: job.txid,
        reason: 'Topic rule denied admission'
      }
    }
  )
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  const result = await service.finalize(f.request, f.caller)
  expect(result.state).toMatchObject({ status: 'finalization-failed', globalOutcome: 'unknown' })
  await service.expire('missing-channel')
  await service.reconcile('ff'.repeat(32))
  await expect(
    service.put(
      {
        version: 1,
        proposal: signed({
          revision: '1',
          previous: f.request.proposalId,
          issuedAt: '101',
          expiresAt: '150'
        })
      },
      f.caller
    )
  ).rejects.toThrow()
})

it('rechecks authorization and clocks after verification without claiming rejected attempts', async () => {
  for (const expiry of [false, true]) {
    const f = fixture(),
      service = f.make()
    await service.put({ version: 1, proposal: f.proposal }, f.caller)
    f.options.evidence.verify = jest.fn(async () => {
      if (expiry) f.time('100')
      else f.options.access = () => false
      return f.raw
    })
    await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({
      code: expiry ? 'expired' : 'unauthorized'
    })
    expect(
      await f.storage.getOperation(author, scope.service, f.request.operationId)
    ).toBeUndefined()
    expect(f.options.admission.recover).not.toHaveBeenCalled()
  }
})

it('recovers a lost journal acknowledgement and refuses capacity exhaustion before any admission effect', async () => {
  const f = fixture(),
    service = f.make()
  const commit = f.storage.commit.bind(f.storage)
  jest.spyOn(f.storage, 'commit').mockImplementation(async (plan, local) => {
    await commit(plan, local)
    throw new OutputProtocolError('unavailable', 'Write acknowledgement lost')
  })
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  expect((await service.finalize(f.request, f.caller)).state.status).toBe('finalized')
  expect((await f.storage.head()).entries).toBe(3)
  const full = fixture({ entries: 2 }),
    blocked = full.make()
  await blocked.put({ version: 1, proposal: full.proposal }, full.caller)
  await expect(blocked.finalize(full.request, full.caller)).rejects.toMatchObject({
    code: 'limited'
  })
  expect(full.options.admission.recover).not.toHaveBeenCalled()
})

it('rejects terminated or expired first finalizations and stale new-operation selectors', async () => {
  const f = fixture(),
    service = f.make()
  await expect(service.put({ version: 2, proposal: f.proposal }, f.caller)).rejects.toMatchObject({
    code: 'invalid'
  })
  await expect(
    service.put(
      { version: 1, proposal: f.proposal },
      { ...f.caller, capabilityDigest: 'aa'.repeat(32) }
    )
  ).rejects.toMatchObject({ code: 'context-changed' })
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  f.time('100')
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'expired' })
  await service.expire(proposalChannelKey(f.proposal.body))
  await expect(service.finalize(f.request, f.caller)).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    service.finalize({ ...f.request, service: 'wrong-topic' }, f.caller)
  ).rejects.toMatchObject({ code: 'not-found' })
  await expect(
    service.finalize({ ...f.request, proposalId: 'aa'.repeat(32) }, f.caller)
  ).rejects.toMatchObject({ code: 'not-found' })
  expect(f.options.evidence.verify).not.toHaveBeenCalled()
})

it('rejects unknown or misplaced persisted contracts and returns owned memory journal metadata', async () => {
  for (const misplaced of [false, true]) {
    const f = fixture()
    const retained = retainOutputCapability(f.manifest, {
      ...proposalCapabilityFixture().request,
      now: '11'
    }).record
    const local = parseOutputJSON(
      canonicalOutputJSON({
        format: misplaced ? 'proposal-service/1' : 'unknown',
        publication: retained,
        retainUntil: '1100',
        ...(misplaced ? { admission: retained } : {})
      })
    )
    if (local === null || typeof local !== 'object' || Array.isArray(local))
      throw new Error('Invalid fixture')
    await f.storage.commit(f.lifecycle.put(undefined, f.proposal, author, '11'), local)
    await expect(f.make().get(f.query, f.caller)).rejects.toMatchObject({
      code: misplaced ? 'unavailable' : 'unsupported'
    })
  }
  const f = fixture(),
    memory = new MemoryProposalJournal('metadata', author, f.lifecycle)
  const bounds = await memory.getLimits()
  bounds.entryBytes = 1
  expect((await memory.getLimits()).entryBytes).toBe(4194304)
  const plan = f.lifecycle.put(undefined, f.proposal, author, '11')
  await memory.commit(plan)
  const entry = await memory.getChannelEntry(proposalChannelKey(f.proposal.body))
  entry!.transition.next.proposal.body.recipients.length = 0
  expect(
    (await memory.getChannelEntry(proposalChannelKey(f.proposal.body)))?.transition.next.proposal
  ).toEqual(f.proposal)
  await memory.close()
})

it('serializes timer races across SQLite writers and surfaces unavailable expiry storage', async () => {
  const f = fixture(),
    service = f.make(),
    other = f.open()
  await service.put({ version: 1, proposal: f.proposal }, f.caller)
  f.time('100')
  const commit = f.storage.commit.bind(f.storage)
  jest.spyOn(f.storage, 'commit').mockImplementationOnce(async (plan, local) => {
    const current = await other.getProposalEntry(f.request.proposalId)
    await other.commit(f.lifecycle.expire(current!.transition.next, '101'), current!.local)
    return await commit(plan, local)
  })
  expect((await service.get(f.query, f.caller)).state).toEqual({
    status: 'expired',
    recordedAt: '101'
  })
  expect((await f.storage.head()).entries).toBe(2)
  const failed = fixture(),
    unavailable = failed.make()
  await unavailable.put({ version: 1, proposal: failed.proposal }, failed.caller)
  failed.time('100')
  jest
    .spyOn(failed.storage, 'commit')
    .mockRejectedValue(new OutputProtocolError('unavailable', 'Disk unavailable'))
  await expect(unavailable.get(failed.query, failed.caller)).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect((await failed.storage.head()).entries).toBe(1)
})
