import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  signOutputPacket,
  Utils,
  type OutputProposalFinalize
} from '@bsv/sdk'
import { ProposalService, type ProposalServiceOptions } from '../src/proposals/ProposalService.js'
import { ProposalResponseDisclosure } from '../src/proposals/ProposalResponseDisclosure.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'
import { author, authorKey, signed, scope, finalize, reference } from './proposal-fixture.js'

export async function proposalDisclosureFixture(
  profile: { maxRequestBytes?: number; maxResponseBytes?: number } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-disclosure-'))
  const path = join(directory, 'journal.sqlite')
  const { lifecycle, manifest: original, request: trust } = proposalCapabilityFixture()
  const body = structuredClone(original.body)
  Object.assign(body.services[0].profiles[0], profile)
  const manifest = signOutputPacket('capabilities', body, authorKey)
  const state = { now: '11', allowed: true }
  const stores: SQLiteProposalJournal[] = []
  const open = () => {
    const store = new SQLiteProposalJournal(path, 'disclosure', author, lifecycle)
    stores.push(store)
    return store
  }
  const storage = open()
  const proposal = signed(),
    transaction = finalize(proposal)
  const caller = {
    caller: author,
    capabilityDigest: outputPacketDigest('capabilities', manifest.body)
  }
  const publication = canonicalOutputJSON({ version: 1, proposal })
  const query = canonicalOutputJSON({
    version: 1,
    service: scope.service,
    policy: reference,
    channel: proposal.body.channel
  })
  const request: OutputProposalFinalize = {
    version: 1,
    service: scope.service,
    proposalId: outputPacketDigest('proposal', proposal.body),
    operationId: 'disclosure-finalize',
    txid: transaction.id('hex'),
    beef: 'AA=='
  }
  const options: ProposalServiceOptions = {
    lifecycle,
    storage,
    trust,
    manifest: () => manifest,
    now: () => state.now,
    access: () => state.allowed,
    // These test ports isolate response authority, not Script or Engine verification.
    evidence: { verify: async () => Utils.toBase64(transaction.toBinary()) },
    admission: {
      maximumOutcomeBytes: 4096,
      recover: async job => ({ status: 'unresolved', operationId: job.operationId, txid: job.txid })
    }
  }
  const service = new ProposalService(options)
  const disclosure = new ProposalResponseDisclosure({
    lifecycle,
    trust,
    now: options.now,
    access: () => state.allowed
  })
  const ack = await service.put(publication, caller)
  return {
    state,
    open,
    storage,
    lifecycle,
    manifest,
    trust,
    proposal,
    caller,
    publication,
    query,
    request,
    options,
    service,
    disclosure,
    ack,
    async close() {
      await Promise.all(stores.map(store => store.close()))
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
