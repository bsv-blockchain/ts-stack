import { expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputPacketDigest,
  parseOutputJSON,
  retainOutputCapability,
  restoreOutputCapability,
  selectOutputCapability,
  signOutputPacket,
  Utils,
  type OutputCapabilities,
  type OutputCapabilityRequest,
  type OutputJSONObject
} from '@bsv/sdk'
import { ProposalTransitions, proposalCommitKey } from '../src/proposals/index.js'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { author, authorKey, scope, registry, signed, finalize } from './proposal-fixture.js'

it('recovers an atomic job and its original signed capability after SQLite restart and manifest expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proposal-capability-'))
  const path = join(directory, 'journal.sqlite')
  const lifecycle = new ProposalTransitions(registry, scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const rules = { id: 'urn:test:proposal-service:1', parameters: {} }
  const manifest = signOutputPacket<OutputCapabilities>(
    'capabilities',
    {
      version: 1,
      identity: author,
      baseURL: 'https://provider.example/api',
      chain: scope.chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: scope.service,
          kind: 'topic',
          rules,
          rulesDigest: outputPacketDigest('service-rules', rules),
          profiles: [
            {
              id: OUTPUT_PROFILES.proposal,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 4194304,
              parameters: {
                policies: registry
                  .describe()
                  .map(({ id, digest, parameters }) => ({ id, digest, parameters })),
                maxLifetimeSeconds: '100',
                retentionSeconds: '1000'
              }
            }
          ]
        }
      ]
    },
    authorKey
  )
  const request: OutputCapabilityRequest = {
    baseURL: manifest.body.baseURL,
    identity: author,
    authenticatedPeer: author,
    chain: scope.chain,
    kind: 'topic',
    service: scope.service,
    profile: OUTPUT_PROFILES.proposal,
    now: '99',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '2',
    rules: new Map([
      [
        rules.id,
        parameters => {
          if (canonicalOutputJSON(parameters) !== '{}')
            throw new Error('Unsupported rules parameters')
        }
      ]
    ])
  }
  const captured = retainOutputCapability(manifest, request)
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
    expect(saved?.transition.next.admission).toEqual(reserved.next.admission)
    expect(saved?.local).toEqual(local)
    expect(() => selectOutputCapability(manifest, { ...request, now: '999' })).toThrow('expired')
    expect(restoreOutputCapability(saved?.local?.capability, request)).toEqual(captured.selection)
    expect((await recovered.head()).reserved?.entries).toBe(1)
  } finally {
    await store.close()
    await recovered?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
