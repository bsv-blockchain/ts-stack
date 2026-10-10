import {
  canonicalOutputJSON,
  OutputProtocolError,
  PrivateKey,
  signOutputPacket,
  Utils,
  type OutputProposalBody
} from '@bsv/sdk'
import {
  BitcoinKnowledge,
  IndexedDBJournal,
  KnowledgeStore,
  knowledgeMutation
} from '@bsv/output-knowledge'
import {
  AuthorDocumentPolicy,
  ProposalPolicyRegistry,
  ProposalSourcePolicy
} from '@bsv/output-knowledge/proposals'

// Public synthetic signature and native persistence fixture, without a remote
// provider or a claim to qualify authenticated private lookup composition.
const key = new PrivateKey(1)
const author = key.toPublicKey().toString()
const chain = { network: 'browser-proposal-fixture', genesisHash: '11'.repeat(32) }
const partition = { application: 'browser-proposal-fixture', account: author, access: 'private' }
const scope = {
  chain,
  provider: author,
  service: 'documents',
  queryDigest: '12'.repeat(32),
  rulesDigest: '13'.repeat(32),
  access: 'private'
}
const registry = new ProposalPolicyRegistry([
  { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 32 } }
])
const { parameters: _parameters, ...policy } = registry.describe()[0]
let now = 1000000
let store: KnowledgeStore, worker: BitcoinKnowledge
let bitcoinChecks = 0

async function initialize(create: boolean) {
  const journal = await IndexedDBJournal.open('browser-proposal-receipts', 'proposal-client')
  worker = new BitcoinKnowledge({
    journalId: journal.namespace,
    partition,
    nonFinal: true,
    now: () => now,
    verifier: {
      verify() {
        bitcoinChecks++
        return Promise.reject(
          new Error('An intent-only observation cannot request Bitcoin verification')
        )
      }
    },
    proposals: new ProposalSourcePolicy(registry, author, [
      {
        source: scope,
        proposalService: scope.service,
        policy,
        maxLifetimeSeconds: '100',
        futureSkewSeconds: '2'
      }
    ])
  })
  store = new KnowledgeStore(journal, worker, { partition, now: () => now })
  if (create) {
    await store.commit(
      '0',
      knowledgeMutation({
        kind: 'context',
        context: {
          id: 'proposal-context',
          partition,
          generation: '0',
          view: {
            id: 'proposal-view',
            chain,
            tipHash: '14'.repeat(32),
            tipHeight: '0',
            medianTimePast: '900',
            chainPolicyDigest: '15'.repeat(32)
          },
          policyDigest: '16'.repeat(32),
          now: '1000',
          limits: { bytes: 4194304, transactions: 4096, dependencies: 16384, deadline: '2000' }
        }
      })
    )
    const proposal = signOutputPacket<OutputProposalBody>(
      'proposal',
      {
        version: 1,
        chain,
        service: scope.service,
        policy,
        channel: '17'.repeat(32),
        revision: '0',
        previous: null,
        author,
        recipients: [author],
        anchors: [],
        issuedAt: '1000',
        expiresAt: '1100',
        operation: 'update',
        payload: Utils.toBase64(
          Utils.toArray(canonicalOutputJSON({ text: 'browser intent' }), 'utf8')
        )
      },
      key
    )
    const receivedScope = { ...scope, epoch: 'one' }
    await store.commit(
      '1',
      knowledgeMutation({
        kind: 'receive',
        batch: {
          provenance: {
            partition,
            generation: '0',
            adapter: 'synthetic-browser-fixture',
            scope: receivedScope,
            authentication: 'configured-transport',
            peer: author,
            receivedAt: '1'
          },
          groups: [
            {
              id: 'one',
              sequence: '0',
              observations: [
                { id: 'intent', scope: receivedScope, kind: 'proposal', payload: { proposal } }
              ]
            }
          ],
          coverage: { scope: receivedScope, phase: 'finite', status: 'complete' }
        }
      })
    )
  }
  return read(now)
}
async function read(milliseconds: number) {
  now = milliseconds
  try {
    return { input: await store.read(), bitcoinChecks }
  } catch (error) {
    if (!(error instanceof OutputProtocolError)) throw error
    return { code: error.code, bitcoinChecks }
  }
}
async function accept() {
  await worker.advance(store, new AbortController().signal)
  return read(now)
}
export const proposalBrowser = { initialize, read, accept }
