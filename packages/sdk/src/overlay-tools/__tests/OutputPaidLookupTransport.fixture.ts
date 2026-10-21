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
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupAcquired
} from '../../../mod.js'
import {
  OutputPaidLookupTransport,
  type OutputPaidLookupOperation,
  type OutputPaidLookupTransportOptions
} from '../OutputPaidLookupTransport.js'
export const paidSeller = new PrivateKey(83)
export const paidBuyer = new PrivateKey(84)
export const paidChain = { network: 'paid-fixture', genesisHash: '11'.repeat(32) }
export function paidTransportFixture<Operation extends OutputPaidLookupOperation>(
  operation: Operation,
  overrides: Partial<OutputPaidLookupTransportOptions<Operation>> = {},
  change?: (manifest: OutputCapabilities) => void
) {
  const rules = { id: 'urn:test:paid-service:1', parameters: {} }
  const trust: OutputCapabilityRequest = {
    baseURL: 'https://provider.example.test/api',
    identity: paidSeller.toPublicKey().toString(),
    chain: paidChain,
    kind: 'lookup',
    service: 'ls_fixture',
    profile: OUTPUT_PROFILES.acquisition,
    now: '90',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '0',
    rules: new Map([[rules.id, () => {}]])
  }
  const manifest: OutputCapabilities = {
    version: 1,
    baseURL: trust.baseURL,
    identity: trust.identity,
    chain: paidChain,
    issuedAt: '89',
    expiresAt: '91',
    services: [
      {
        kind: 'lookup',
        name: trust.service,
        rules,
        rulesDigest: outputPacketDigest('service-rules', rules),
        profiles: [
          {
            id: OUTPUT_PROFILES.acquisition,
            authentication: 'brc103',
            payment: 'brc105',
            maxRequestBytes: 1048576,
            maxResponseBytes: 4194304,
            parameters: { recoverySeconds: '86400', acceptancePolicy: { kind: 'local-admission' } }
          }
        ]
      }
    ]
  }
  change?.(manifest)
  const { record, selection } = retainOutputCapability(
    signOutputPacket('capabilities', manifest, paidSeller),
    trust
  )
  const request: OutputPaidLookupAcquire = {
    version: 1,
    requestId: 'paid_lookup_transport',
    service: trust.service,
    assetId: '22'.repeat(32),
    listing: { chain: paidChain, txid: '33'.repeat(32), outputIndex: 1 },
    termsDigest: '44'.repeat(32),
    recipient: paidBuyer.toPublicKey().toString(),
    request: 'AA=='
  }
  const challenge: OutputPaidLookupChallenge = {
    version: 1,
    acquisitionId: outputPacketDigest('acquisition', {
      chain: paidChain,
      seller: trust.identity,
      buyer: request.recipient,
      service: request.service,
      requestId: request.requestId
    }),
    requestDigest: outputPacketDigest('acquire-request', request),
    seller: trust.identity,
    buyer: request.recipient,
    assetId: request.assetId,
    termsDigest: request.termsDigest,
    satoshis: '100',
    derivationPrefix: 'fixture-prefix',
    acceptancePolicy: { kind: 'local-admission' },
    rulesDigest: selection.service.rulesDigest,
    payableUntil: '100',
    recoveryUntil: '86500'
  }
  // This fixture exercises transport representation only, not transaction acceptance.
  const payment = {
    derivationPrefix: challenge.derivationPrefix,
    derivationSuffix: 'fixture-suffix',
    transaction: 'AA=='
  }
  const common = {
    version: 1 as const,
    acquisitionId: challenge.acquisitionId,
    recoveryUntil: challenge.recoveryUntil,
    challenge
  }
  const funding = { chain: paidChain, txid: '66'.repeat(32), outputIndex: 2 }
  const quoted: OutputPaidLookupAcquired = { ...common, status: 'quoted' }
  const delivered: OutputPaidLookupAcquired = {
    ...common,
    status: 'delivered',
    funding,
    acceptance: {
      chain: paidChain,
      txid: funding.txid,
      policy: challenge.acceptancePolicy,
      acceptedAt: '101'
    },
    result: {
      evidence: { txid: request.listing.txid, outputIndex: 1, beef: 'AA==' },
      context: 'AQ==',
      schema: 'urn:fixture:context'
    }
  }
  const fetchClient = jest.fn<typeof fetch>()
  const options = {
    operation,
    contract: record,
    trust,
    request,
    wallet: new CompletedProtoWallet(paidBuyer),
    fetch: fetchClient,
    ...(operation === 'quote' ? {} : { challenge }),
    ...(operation === 'pay' ? { payment } : {}),
    ...overrides
  } as unknown as OutputPaidLookupTransportOptions<Operation>
  const response = (
    value: unknown = operation === 'quote' ? challenge : delivered,
    status = operation === 'quote' ? 402 : 200,
    headers: Record<string, string> = {}
  ) =>
    new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: {
        ...selection.headers,
        'x-bsv-auth-identity-key': trust.identity,
        ...(status === 402
          ? {
              'x-bsv-payment-version': '1.0',
              'x-bsv-payment-satoshis-required': challenge.satoshis,
              'x-bsv-payment-derivation-prefix': challenge.derivationPrefix
            }
          : {}),
        ...headers
      }
    })
  return {
    client: new OutputPaidLookupTransport(options),
    options,
    record,
    selection,
    request,
    challenge,
    payment,
    common,
    quoted,
    delivered,
    response,
    fetchClient
  }
}
