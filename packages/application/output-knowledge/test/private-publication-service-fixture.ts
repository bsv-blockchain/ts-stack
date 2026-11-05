import { createSecretKey } from 'node:crypto'
import {
  OUTPUT_PROFILES,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  Utils,
  type OutputCapabilities
} from '@bsv/sdk'
import { PrivatePublicationContracts } from '../src/private/PrivatePublicationContracts.js'
import { parsePrivatePublicationContractRecord } from '../src/private/PrivatePublicationContractRecord.js'
import { PrivateServiceIdentity } from '../src/private/PrivateServiceIdentity.js'
import { createPrivatePublicationRecords } from '../src/private/PrivatePublicationRecords.js'
import { chain, candidate, context, transactions } from './evidence-fixture.js'

export function contractFixture() {
  const key = new PrivateKey(52),
    seller = key.toPublicKey().toString()
  const rules = {
    id: 'urn:test:private-rules',
    parameters: { mode: 'synthetic' }
  }
  const rulesDigest = outputPacketDigest('service-rules', rules)
  const installation = {
    chain,
    seller,
    baseURL: 'https://seller.example/api',
    service: 'tm_publication',
    topic: 'tm_synthetic',
    rulesDigest,
    maximumPrivateBytes: 100000,
    schemas: ['urn:test:private-material']
  }
  const trust = {
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  }
  const contracts = new PrivatePublicationContracts(installation, trust)
  const body: OutputCapabilities = {
    version: 1,
    identity: seller,
    baseURL: installation.baseURL,
    chain,
    issuedAt: '10',
    expiresAt: '100',
    services: [
      {
        name: installation.service,
        kind: 'topic',
        rules,
        rulesDigest,
        profiles: [
          {
            id: OUTPUT_PROFILES.publication,
            authentication: 'brc103',
            payment: 'none',
            maxRequestBytes: 1048576,
            maxResponseBytes: 65536,
            parameters: {
              schemas: installation.schemas,
              maxPrivateBytes: 65536
            }
          }
        ]
      }
    ]
  }
  const manifest = signOutputPacket('capabilities', body, key)
  const retained = contracts.retain(manifest, '20')
  const request = {
    version: 1 as const,
    requestId: 'original-private-contract-1',
    topic: installation.topic,
    evidence: candidate('P').evidence,
    assetId: '44'.repeat(32),
    schema: installation.schemas[0],
    privateValues: 'AQID'
  }
  const publisher = new PrivateKey(63).toPublicKey().toString()
  const identity = new PrivateServiceIdentity(
    { chain, seller },
    { resolve: () => createSecretKey(Buffer.alloc(32, 107)) },
    'test-index'
  )
  const prepared = createPrivatePublicationRecords(
    request,
    identity,
    {
      publisher,
      chain,
      lookup: { service: 'ls_private', rulesDigest: '66'.repeat(32) }
    },
    '20',
    '30'
  )
  const policy = {
    id: 'urn:test:publisher-schema-policy',
    digest: '55'.repeat(32)
  }
  const record = {
    format: 'private-publication-contract/1' as const,
    publicationId: prepared.fence.state.publicationId,
    requestDigest: prepared.fence.state.requestDigest,
    rawTransaction: Utils.toBase64(transactions.get('P')!.toBinary()),
    capability: retained.record,
    verificationContext: context(),
    validationPolicy: policy
  }
  const restore = (value: unknown = record) =>
    parsePrivatePublicationContractRecord(value, prepared.fence.state, request, contracts, policy)
  return {
    contracts,
    body,
    key,
    installation,
    trust,
    retained,
    request,
    prepared,
    record,
    policy,
    restore
  }
}
