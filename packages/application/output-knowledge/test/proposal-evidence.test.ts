import { expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Beef,
  LockingScript,
  outputPacketDigest,
  P2PKH,
  PrivateKey,
  signOutputPacket,
  Transaction,
  Utils,
  type OutputProposalFinalize
} from '@bsv/sdk'
import {
  ProposalService,
  ProposalTransitions,
  SDKProposalEvidence
} from '../src/proposals/index.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { context, resolver, chain, transactions, candidate } from './evidence-fixture.js'
import { author, registry, signed, authorKey, scope } from './proposal-fixture.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'

async function verifiedFinalization() {
  const proposal = signed({ chain })
  const proposalId = outputPacketDigest('proposal', proposal.body)
  const transaction = new Transaction(
    1,
    [
      {
        sourceTransaction: transactions.get('P')!,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
        sequence: 0xffffffff
      }
    ],
    [{ satoshis: 1, lockingScript: LockingScript.fromHex('006a045052503120' + proposalId) }],
    0
  )
  await transaction.sign()
  const request: OutputProposalFinalize = {
    version: 1,
    service: scope.service,
    operationId: 'verified-operation',
    proposalId,
    txid: transaction.id('hex'),
    beef: Utils.toBase64(transaction.toAtomicBEEF())
  }
  return { proposal, transaction, request }
}

it('checks a real signed PRP1 transaction and its complete anchored ancestry before durable reservation', async () => {
  const { proposal, transaction, request } = await verifiedFinalization()
  const originalContext = context()
  const evidence = new SDKProposalEvidence(resolver, () => originalContext)
  const detailed = await evidence.verifyWithContext(request, proposal)
  expect(detailed.verificationContext).toEqual(originalContext)
  expect(detailed.rawTransaction).toBe(Utils.toBase64(transaction.toBinary()))
  detailed.verificationContext.view.id = 'changed-by-consumer'
  expect(originalContext.view.id).toBe('base')
  expect(await evidence.verify(request, proposal)).toBe(Utils.toBase64(transaction.toBinary()))
  const directory = mkdtempSync(join(tmpdir(), 'proposal-verified-'))
  const lifecycle = new ProposalTransitions(
    registry,
    { ...scope, chain },
    { maxLifetimeSeconds: '100', futureSkewSeconds: '2' }
  )
  const storage = new SQLiteProposalJournal(
    join(directory, 'journal.sqlite'),
    'verified',
    author,
    lifecycle
  )
  const fixture = proposalCapabilityFixture()
  const manifest = signOutputPacket('capabilities', { ...fixture.manifest.body, chain }, authorKey)
  const service = new ProposalService({
    lifecycle,
    storage,
    evidence,
    trust: fixture.request,
    manifest: () => manifest,
    now: () => '11',
    access: () => true,
    // Ordinary topic processing is deliberately unresolved in this test. Real
    // Script/SPV success is not a substitute for the separate admission adapter.
    admission: {
      maximumOutcomeBytes: 4096,
      requiresVerificationContext: true,
      recover: async (job, _proposal, _selection, verificationContext) => {
        expect(verificationContext).toEqual(originalContext)
        const saved = (await storage.getProposalEntry(request.proposalId))!.local!
        expect(saved.format).toBe('proposal-service/2')
        expect(saved.verificationContext).toEqual(originalContext)
        return { status: 'unresolved', operationId: job.operationId, txid: job.txid }
      }
    }
  })
  try {
    const caller = {
      caller: author,
      capabilityDigest: outputPacketDigest('capabilities', manifest.body)
    }
    await service.put({ version: 1, proposal }, caller)
    expect((await service.finalize(request, caller)).state.status).toBe('finalizing')
    expect((await storage.getProposal(request.proposalId))?.record.admission?.rawTransaction).toBe(
      Utils.toBase64(transaction.toBinary())
    )
  } finally {
    await storage.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects invalid Script, missing ancestors, a foreign view and a mismatched proposal without returning raw evidence', async () => {
  const { proposal, transaction, request } = await verifiedFinalization()
  const evidence = new SDKProposalEvidence(resolver, () => context())
  transaction.outputs[0].satoshis = 2
  const bad = new Transaction(
    transaction.version,
    transaction.inputs,
    transaction.outputs,
    transaction.lockTime
  )
  await expect(
    evidence.verify(
      { ...request, txid: bad.id('hex'), beef: Utils.toBase64(bad.toAtomicBEEF()) },
      proposal
    )
  ).rejects.toMatchObject({ code: 'invalid' })
  const missing = new Beef()
  missing.mergeTxidOnly(request.txid)
  await expect(
    evidence.verify({ ...request, beef: Utils.toBase64(missing.toBinary()) }, proposal)
  ).rejects.toMatchObject({ code: 'unavailable' })
  await expect(
    new SDKProposalEvidence(resolver, () => ({
      ...context(),
      view: { ...context().view, chain: scope.chain }
    })).verify(request, proposal)
  ).rejects.toMatchObject({ code: 'invalid' })
  await expect(
    evidence.verify({ ...request, proposalId: 'ff'.repeat(32) }, proposal)
  ).rejects.toMatchObject({ code: 'invalid' })
})

it('uses exact target bytes from aggregate evidence and keeps deadline/cancellation failures unresolved', async () => {
  const { proposal, transaction, request } = await verifiedFinalization()
  const beef = Beef.fromBinary(transaction.toBEEF())
  beef.mergeBeef(Utils.toArray(candidate('Q').evidence.beef, 'base64'))
  expect(
    await new SDKProposalEvidence(resolver, () => context()).verify(
      { ...request, beef: Utils.toBase64(beef.toBinary()) },
      proposal
    )
  ).toBe(Utils.toBase64(transaction.toBinary()))
  const abort = new AbortController()
  abort.abort()
  await expect(
    new SDKProposalEvidence(resolver, () => context()).verify(request, proposal, abort.signal)
  ).rejects.toMatchObject({ code: 'cancelled' })
  await expect(
    new SDKProposalEvidence(resolver, () => ({
      ...context(),
      now: '0',
      limits: { ...context().limits, deadline: '1' }
    })).verify(request, proposal)
  ).rejects.toMatchObject({ code: 'limited' })
})
