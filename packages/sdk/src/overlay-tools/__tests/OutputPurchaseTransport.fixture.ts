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
  type OutputPurchasePrepare,
  type OutputPurchaseTerms,
  type OutputReleaseEvidence,
  type OutputSignedPotatoes
} from '../../../mod.js'
import {
  OutputPurchaseTransport,
  type OutputPurchaseOperation,
  type OutputPurchaseTransportOptions
} from '../OutputPurchaseTransport.js'
export const purchaseSeller = new PrivateKey(83),
  purchaseBuyer = new PrivateKey(84)
export function purchaseTransportFixture<Operation extends OutputPurchaseOperation>(
  operation: Operation,
  overrides: Partial<OutputPurchaseTransportOptions<Operation>> = {},
  change?: (manifest: OutputCapabilities) => void
) {
  const chain = { network: 'purchase-fixture', genesisHash: '11'.repeat(32) },
    rules = { id: 'urn:test:purchase-service:1', parameters: {} },
    seller = purchaseSeller.toPublicKey().toString(),
    recipient = purchaseBuyer.toPublicKey().toString(),
    trust: OutputCapabilityRequest = {
      baseURL: 'https://provider.example.test/api',
      identity: seller,
      chain,
      kind: 'topic',
      service: 'tm_fixture',
      profile: OUTPUT_PROFILES.purchase,
      now: '90',
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0',
      rules: new Map([[rules.id, () => {}]])
    },
    manifest: OutputCapabilities = {
      version: 1,
      baseURL: trust.baseURL,
      identity: seller,
      chain,
      issuedAt: '89',
      expiresAt: '91',
      services: [
        {
          kind: 'topic',
          name: trust.service,
          rules,
          rulesDigest: outputPacketDigest('service-rules', rules),
          profiles: [
            {
              id: OUTPUT_PROFILES.purchase,
              authentication: 'brc103',
              payment: 'covenant',
              maxRequestBytes: 1048576,
              maxResponseBytes: 4194304,
              parameters: {
                recoverySeconds: '86400',
                domainProfiles: ['urn:fixture:domain'],
                releasePolicies: [{ kind: 'local-admission' }]
              }
            }
          ]
        }
      ]
    }
  change?.(manifest)
  const { record, selection } = retainOutputCapability(
      signOutputPacket('capabilities', manifest, purchaseSeller),
      trust
    ),
    request: OutputPurchasePrepare = {
      version: 1,
      requestId: 'purchase_fixture_01',
      topic: trust.service,
      listing: { chain, txid: '33'.repeat(32), outputIndex: 0 },
      assetId: '44'.repeat(32),
      termsDigest: '55'.repeat(32),
      recipient,
      request: 'AA=='
    },
    acquisitionId = outputPacketDigest('purchase', {
      chain,
      seller,
      recipient,
      topic: request.topic,
      requestId: request.requestId
    }),
    body: OutputPurchaseTerms = {
      version: 1,
      acquisitionId,
      requestDigest: outputPacketDigest('purchase-request', request),
      seller,
      recipient,
      topic: request.topic,
      listing: request.listing,
      assetId: request.assetId,
      termsDigest: request.termsDigest,
      domainProfile: 'urn:fixture:domain',
      domainEvidence: { schema: 'urn:fixture:lineage', bytes: 'AA==' },
      releasePolicy: { kind: 'local-admission' },
      purchaseUntil: '100',
      recoveryUntil: '86500'
    },
    terms = signOutputPacket('purchase-terms', body, purchaseSeller),
    candidate = { version: 1 as const, acquisitionId, txid: '22'.repeat(32), beef: 'AA==' },
    evidence: OutputReleaseEvidence = {
      chain,
      txid: candidate.txid,
      policy: body.releasePolicy,
      acceptedAt: '90'
    },
    potatoes: OutputSignedPotatoes['body'] = {
      version: 1,
      acquisitionId,
      requestDigest: body.requestDigest,
      seller,
      recipient,
      topic: body.topic,
      txid: candidate.txid,
      assetId: body.assetId,
      termsDigest: body.termsDigest,
      releasePolicy: body.releasePolicy,
      evidenceDigest: outputPacketDigest('release-evidence', evidence),
      schema: 'urn:fixture:secret',
      secret: 'AA==',
      issuedAt: '91',
      recoveryUntil: body.recoveryUntil
    },
    envelope = {
      result: {
        version: 1 as const,
        acquisitionId,
        txid: candidate.txid,
        status: 'delivered' as const,
        steak: { tm_fixture: { outputsToAdmit: [0], coinsToRetain: [] } },
        potatoes: signOutputPacket('potatoes', potatoes, purchaseSeller),
        recoveryUntil: body.recoveryUntil
      },
      releaseEvidence: evidence
    },
    fetchClient = jest.fn<typeof fetch>(),
    options = {
      operation,
      contract: record,
      trust,
      request,
      wallet: new CompletedProtoWallet(purchaseBuyer),
      fetch: fetchClient,
      ...(operation === 'prepare' ? {} : { terms, candidate }),
      ...overrides
    } as unknown as OutputPurchaseTransportOptions<Operation>,
    response = (
      value: unknown = operation === 'prepare' ? terms : envelope,
      status = 200,
      headers: Record<string, string> = {}
    ) =>
      new Response(typeof value === 'string' ? value : JSON.stringify(value), {
        status,
        headers: { ...selection.headers, 'x-bsv-auth-identity-key': seller, ...headers }
      })
  // Representation/authentication boundary only. These tiny BEEF placeholders
  // are deliberately not a Bitcoin, admission, release or decryption verdict.
  return {
    options,
    request,
    body,
    terms,
    candidate,
    evidence,
    potatoes,
    envelope,
    record,
    selection,
    response,
    fetchClient,
    client: new OutputPurchaseTransport(options)
  }
}
