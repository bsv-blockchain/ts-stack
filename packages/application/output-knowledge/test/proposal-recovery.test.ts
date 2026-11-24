import { afterEach, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outputPacketDigest, OutputProtocolError, Utils } from '@bsv/sdk'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalJournalMaintenance } from '../src/proposals/ProposalMaintenance.js'
import { ProposalScheduler } from '../src/proposals/ProposalScheduler.js'
import { ProposalService, type ProposalServiceOptions } from '../src/proposals/ProposalService.js'
import type {
  ProposalAdmissionJob,
  ProposalAdmissionOutcome
} from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'
import { author, signed, scope, finalize } from './proposal-fixture.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

it('recovers the exact reserved job and independent expiry from sealed SQLite state after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-recovery-')),
    path = join(directory, 'journal.sqlite')
  const { lifecycle, manifest, request: trust } = proposalCapabilityFixture()
  const stores: SQLiteProposalJournal[] = []
  cleanup.push(async () => {
    for (const store of stores) await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  let storage = SQLiteProposalJournal.create(path, 'recovery', author, lifecycle)
  stores.push(storage)
  let now = '11'
  const proposal = signed(),
    tx = finalize(proposal)
  const request = {
    version: 1 as const,
    service: scope.service,
    proposalId: outputPacketDigest('proposal', proposal.body),
    operationId: 'original-operation',
    txid: tx.id('hex'),
    beef: 'AA=='
  }
  const expectedJob: ProposalAdmissionJob[] = []
  const lost = new OutputProtocolError('unavailable', 'Synthetic admission acknowledgement loss')
  const recover = jest.fn<ProposalServiceOptions['admission']['recover']>(async job => {
    expectedJob.push(structuredClone(job))
    throw lost
  })
  // Qualified-port orchestration fixture only. It deliberately does not claim
  // actual BEEF/Script/SPV, Engine admission, or network evidence.
  const evidence = jest.fn(async () => Utils.toBase64(tx.toBinary()))
  const options: ProposalServiceOptions = {
    lifecycle,
    storage,
    trust,
    now: () => now,
    manifest: () => manifest,
    access: () => true,
    evidence: { verify: evidence },
    admission: { maximumOutcomeBytes: 4096, recover }
  }
  const caller = {
    caller: author,
    capabilityDigest: outputPacketDigest('capabilities', manifest.body)
  }
  const service = new ProposalService(options)
  await service.put({ version: 1, proposal }, caller)
  const unreserved = signed({ channel: 'aa'.repeat(32) })
  await service.put({ version: 1, proposal: unreserved }, caller)
  await expect(service.finalize(request, caller)).rejects.toBe(lost)
  expect((await storage.getProposal(request.proposalId))?.record.state.status).toBe('finalizing')
  expect((await storage.head()).reserved?.entries).toBe(1)
  await storage.close()
  storage = SQLiteProposalJournal.open(path, 'recovery', author, lifecycle)
  stores.push(storage)
  now = '1200'
  const unavailable = () => {
    throw new Error('New discovery and author access are unavailable')
  }
  options.storage = storage
  options.manifest = unavailable
  options.access = () => false
  evidence.mockImplementation(unavailable)
  const outcome: ProposalAdmissionOutcome = {
    status: 'admitted',
    operationId: request.operationId,
    txid: request.txid,
    steak: {},
    assessmentContextId: 'original-committed-assessment'
  }
  recover.mockImplementation(async job => {
    expectedJob.push(structuredClone(job))
    return outcome
  })
  const worker = new ProposalScheduler({
    source: new ProposalJournalMaintenance(storage),
    service: new ProposalService(options),
    pageSize: 256
  })
  const report = await worker.runOnce()
  expect(report).toMatchObject({ scanned: 2, expiryChecks: 1, recoveriesStarted: 1, failures: [] })
  const drained = await worker.stop()
  expect(drained.failures).toEqual([])
  expect(expectedJob).toHaveLength(2)
  expect(expectedJob[1]).toEqual(expectedJob[0])
  expect(evidence).toHaveBeenCalledTimes(1)
  expect((await storage.getProposal(request.proposalId))?.record.state).toMatchObject({
    status: 'finalized',
    operationId: request.operationId,
    txid: request.txid,
    assessmentContextId: 'original-committed-assessment'
  })
  expect((await storage.getChannel(proposalChannelKey(unreserved.body)))?.state.status).toBe(
    'expired'
  )
  expect((await storage.head()).reserved?.entries).toBe(0)
  await storage.close()
  const reopened = SQLiteProposalJournal.open(path, 'recovery', author, lifecycle)
  stores.push(reopened)
  expect(await new ProposalJournalMaintenance(reopened).page(256)).toEqual({ items: [] })
  expect(
    (await reopened.getOperation(author, scope.service, request.operationId))?.state.status
  ).toBe('finalized')
})
