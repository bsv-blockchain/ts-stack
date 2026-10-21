import { expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalOutputJSON,
  parseOutputJSON,
  retainOutputCapability,
  restoreOutputCapability,
  selectOutputCapability,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import { proposalCommitKey, ProposalCapabilityContracts } from '../src/proposals/index.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { author, scope, signed, finalize } from './proposal-fixture.js'
import { proposalCapabilityFixture } from './proposal-capability-fixture.js'

it('recovers an atomic job and its original signed capability after SQLite restart and manifest expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-capability-'))
  const path = join(directory, 'journal.sqlite')
  const { lifecycle, manifest, request } = proposalCapabilityFixture()
  const captured = retainOutputCapability(manifest, request)
  const contracts = new ProposalCapabilityContracts(lifecycle, request)
  const local = parseOutputJSON(
    canonicalOutputJSON({ capability: captured.record })
  ) as OutputJSONObject
  const first = lifecycle.put(undefined, signed(), author, '10')
  const transaction = finalize(first.next.proposal)
  // Storage/policy integration only: this fixture's BEEF is not verified evidence.
  const reserved = lifecycle.reserve(
    first.next,
    author,
    {
      version: 1,
      operationId: 'original-operation-id',
      service: scope.service,
      proposalId: first.next.proposalId,
      txid: transaction.id('hex'),
      beef: 'AA=='
    },
    Utils.toBase64(transaction.toBinary()),
    '99'
  )
  const store = new SQLiteProposalJournal(path, 'contract', author, lifecycle)
  let recovered: SQLiteProposalJournal | undefined
  try {
    await store.commit(first)
    await store.commit(reserved, local)
    await store.close()
    recovered = new SQLiteProposalJournal(path, 'contract', author, lifecycle)
    const saved = await recovered.getCommit(proposalCommitKey(reserved))
    expect(await recovered.getProposalEntry(reserved.next.proposalId)).toEqual(saved)
    expect(saved?.transition.next.admission).toEqual(reserved.next.admission)
    expect(saved?.local).toEqual(local)
    expect(() => selectOutputCapability(manifest, { ...request, now: '999' })).toThrow('expired')
    expect(restoreOutputCapability(saved?.local?.capability, request)).toEqual(captured.selection)
    expect(
      contracts.requirePolicy(saved?.local?.capability, reserved.next.proposal.body.policy)
    ).toEqual(captured.selection)
    expect((await recovered.head()).reserved?.entries).toBe(1)
  } finally {
    await store.close()
    await recovered?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
