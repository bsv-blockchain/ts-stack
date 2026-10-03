import { jest } from '@jest/globals'
import {
  CompletedProtoWallet,
  PrivateKey,
  OUTPUT_PROFILES,
  outputPacketDigest,
  retainOutputCapability,
  signOutputPacket,
  type OutputCapabilityRequest,
  type OutputCapabilities,
  type OutputSignedProposal
} from '../../../mod.js'
import {
  OutputProposalTransport,
  type OutputProposalOperation,
  type OutputProposalTransportOptions
} from '../OutputProposalTransport.js'

export const proposalAuthor = new PrivateKey(81)
export const proposalProvider = new PrivateKey(82)
export const proposalChain = { network: 'mock', genesisHash: '00'.repeat(32) }
const policy = { id: 'urn:test:document:1', parameters: { maxTextBytes: 4096 } }
export const proposalPolicy = { ...policy, digest: outputPacketDigest('proposal-policy', policy) }

export function transportProposal(
  changes: Partial<OutputSignedProposal['body']> = {}
): OutputSignedProposal {
  const author = proposalAuthor.toPublicKey().toString()
  return signOutputPacket(
    'proposal',
    {
      version: 1,
      service: 'tm_records',
      chain: proposalChain,
      policy: { id: policy.id, digest: proposalPolicy.digest },
      channel: '11'.repeat(32),
      revision: '0',
      previous: null,
      author,
      recipients: [author],
      anchors: [],
      issuedAt: '99',
      expiresAt: '120',
      operation: 'update',
      payload: 'e30=',
      ...changes
    },
    proposalAuthor
  )
}

export function proposalTransportFixture<Operation extends OutputProposalOperation>(
  operation: Operation,
  overrides: Partial<OutputProposalTransportOptions<Operation>> = {},
  change?: (manifest: OutputCapabilities) => void
) {
  const rules = { id: 'urn:test:proposal-service:1', parameters: {} }
  const trust: OutputCapabilityRequest = {
    baseURL: 'https://provider.example.test/api',
    identity: proposalProvider.toPublicKey().toString(),
    chain: proposalChain,
    kind: 'topic',
    service: 'tm_records',
    profile: OUTPUT_PROFILES.proposal,
    now: '100',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '0',
    rules: new Map([[rules.id, () => {}]])
  }
  const manifest: OutputCapabilities = {
    version: 1,
    baseURL: trust.baseURL,
    identity: trust.identity,
    chain: proposalChain,
    issuedAt: '99',
    expiresAt: '101',
    services: [
      {
        kind: 'topic',
        name: trust.service,
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
              policies: [proposalPolicy],
              maxLifetimeSeconds: '100',
              retentionSeconds: '200'
            }
          }
        ]
      }
    ]
  }
  change?.(manifest)
  const { record, selection } = retainOutputCapability(
    signOutputPacket('capabilities', manifest, proposalProvider),
    trust
  )
  const proposal = transportProposal(),
    proposalId = outputPacketDigest('proposal', proposal.body)
  const requests = {
    put: { version: 1, proposal },
    get: {
      version: 1,
      service: trust.service,
      policy: proposal.body.policy,
      channel: proposal.body.channel
    },
    finalize: {
      version: 1,
      service: trust.service,
      proposalId,
      operationId: 'original_finalize_1',
      txid: '22'.repeat(32),
      beef: 'AA=='
    }
  }
  const results = {
    put: { version: 1, proposalId, status: 'recorded', expiresAt: proposal.body.expiresAt },
    get: { version: 1, proposal, state: { status: 'active', recordedAt: '100' } },
    finalize: {
      version: 1,
      proposalId,
      state: {
        status: 'finalizing',
        recordedAt: '100',
        operationId: requests.finalize.operationId,
        txid: requests.finalize.txid
      }
    }
  }
  const fetchClient = jest.fn<typeof fetch>(),
    state = { now: '100' }
  const options: OutputProposalTransportOptions<Operation> = {
    operation,
    request: requests[operation],
    contract: record,
    trust,
    wallet: new CompletedProtoWallet(proposalAuthor),
    fetch: fetchClient,
    now: () => state.now,
    ...overrides
  }
  const response = (
    value: unknown = results[operation],
    status = 200,
    headers: Record<string, string> = {}
  ) =>
    new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: { ...selection.headers, ...headers }
    })
  return {
    client: new OutputProposalTransport(options),
    options,
    record,
    selection,
    proposal,
    proposalId,
    requests,
    results,
    response,
    fetchClient,
    state
  }
}
